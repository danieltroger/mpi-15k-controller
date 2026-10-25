/**
 * Self-test for the stuck-inverter detection, the sustain tracker and the combined alert policy.
 * Run from backend/ with:
 *   yarn node src/alerting/inverterStuck.selftest.ts
 *
 * Snapshot values are the incident report's (2026-10-21 latch, look-alikes from report §4.3).
 */
import {
  evaluateBuyWindowNotCharging,
  evaluateDcSideIdle,
  evaluateInverterStuckRules,
  evaluatePvStalledInDaylight,
  hallBlindWhileInverterTalks,
  type InverterStuckSnapshot,
} from "./inverterStuckDetection.ts";
import {
  describeInverterStuckAlert,
  describeInverterStuckResolved,
  formatStockholmTime,
  type InverterStuckAlertAction,
  inverterStuckAlertKey,
  type InverterStuckAlertState,
  type InverterStuckSettings,
  INVERTER_STUCK_IDLE_STATE,
  persistableEpisode,
  restoreEpisode,
  stepInverterStuckAlert,
} from "./inverterStuckAlertPolicy.ts";
import {
  addTrailingSample,
  advanceSustainedCondition,
  createTrailingMeanWindow,
  INACTIVE_SUSTAINED_CONDITION,
  type TrailingMeanWindow,
  trailingMean,
} from "./sustainedCondition.ts";
import { sunElevationDegrees } from "../utilities/sunElevation.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const ONSET_MS = +new Date("2026-10-21T04:15:10Z");
const DEFAULT_SETTINGS: InverterStuckSettings = {
  inverter_stuck_sustain_minutes: 30,
  inverter_stuck_buy_window_sustain_minutes: 5,
  inverter_stuck_p1_after_minutes: 0,
};

/** The latched state as GS/PS + hall reported it on 2026-10-21 shortly after 04:15 UTC. */
type SnapshotValues = {
  hallWatts?: number;
  batteryCurrent?: number;
  batteryVolts?: number;
  batteryDirection?: "Charging" | "Discharging" | "Idle";
  dcAcDirection?: "DC to AC" | "AC to DC" | "Idle";
  gridWatts?: number;
  pvVolts?: number;
  pvWatts?: number;
  mpptStatus?: "Working" | "Idle";
  averageSOC?: number;
  sunElevation?: number;
  commandedAmps?: number;
  acChargingEnabled?: boolean;
  inverterAgeMs?: number;
  hallAgeMs?: number;
};

function snapshotAt(nowMs: number, values: SnapshotValues = {}): InverterStuckSnapshot {
  const inverterTime = nowMs - (values.inverterAgeMs ?? 800);
  return {
    nowMs,
    inverter: {
      battery_current: timedReading(values.batteryCurrent ?? 0, inverterTime),
      battery_voltage: timedReading(values.batteryVolts ?? 53.2, inverterTime),
      battery_power_direction: timedReading(values.batteryDirection ?? "Idle", inverterTime),
      "dc/ac_power_direction": timedReading(values.dcAcDirection ?? "Idle", inverterTime),
      ac_input_total_active_power: timedReading(values.gridWatts ?? 320, inverterTime),
      solar_input_voltage_1: timedReading(values.pvVolts ?? 0, inverterTime),
      solar_input_voltage_2: timedReading(values.pvVolts ?? 0, inverterTime),
      solar_input_power_1: timedReading((values.pvWatts ?? 0) / 2, inverterTime),
      solar_input_power_2: timedReading((values.pvWatts ?? 0) / 2, inverterTime),
      solar_input_1_work_status: timedReading(values.mpptStatus ?? "Idle", inverterTime),
      solar_input_2_work_status: timedReading(values.mpptStatus ?? "Idle", inverterTime),
    },
    smoothedHallWatts: { value: values.hallWatts ?? -22, time: nowMs - (values.hallAgeMs ?? 250) },
    averageSOC: values.averageSOC ?? 37,
    sunElevationDegrees: values.sunElevation ?? -20,
    commandedChargingAmps: values.commandedAmps ?? 0,
    acChargingEnabledOnInverter: values.acChargingEnabled ?? false,
  };
}

const nowMs = ONSET_MS + 20 * 60_000;

// The reviewer's replays of #51: a November latch at 10:00 UTC (sun ~6° from 07:30 to 14:00 UTC,
// strings at 450 V), power-cycled at 15:30 UTC in the dark.
const WINTER_LATCH_MS = +new Date("2026-11-20T10:00:00Z");
const WINTER_FIX_MS = +new Date("2026-11-20T15:30:00Z");
const WINTER_RELATCH_MS = WINTER_FIX_MS + 3 * 86_400_000;
const BUY_WINDOW_START_MS = +new Date("2026-11-21T02:00:00Z");
const normalDischarge: SnapshotValues = {
  hallWatts: -650,
  batteryCurrent: -12,
  batteryDirection: "Discharging",
  dcAcDirection: "DC to AC",
  gridWatts: 20,
};

// ——— Rule B: DC side idle ———
check("incident signature → failing", evaluateDcSideIdle(snapshotAt(nowMs)).observation, "failing");
check(
  "incident ~2 A DC load step (hall −128 W) → still failing",
  evaluateDcSideIdle(snapshotAt(nowMs, { hallWatts: -128 })).observation,
  "failing"
);
check(
  "float hold (hall −140 W, SOC 99%) → indeterminate, not failing",
  evaluateDcSideIdle(snapshotAt(nowMs, { hallWatts: -140, batteryVolts: 54.0, averageSOC: 99 })).observation,
  "indeterminate"
);
check(
  "float hold with the usual −187 W self-draw → indeterminate (between bands)",
  evaluateDcSideIdle(snapshotAt(nowMs, { hallWatts: -187, batteryVolts: 54.2, averageSOC: 100 })).observation,
  "indeterminate"
);
check(
  "latch from a full pack (SOC 97%, hall −25 W) → failing: the ledger SOC barely falls during a latch",
  evaluateDcSideIdle(snapshotAt(nowMs, { hallWatts: -25, batteryVolts: 53.6, averageSOC: 97 })).observation,
  "failing"
);
check(
  "float hold as the inverter really reports it (0 A Charging/AC to DC, hall −183 W) → healthy",
  evaluateDcSideIdle(
    snapshotAt(nowMs, { hallWatts: -183, batteryDirection: "Charging", dcAcDirection: "AC to DC", averageSOC: 100 })
  ).observation,
  "healthy"
);
check(
  "float hold misreported as Idle/Idle at its lowest observed hall (−66 W, SOC 99%) → indeterminate",
  evaluateDcSideIdle(snapshotAt(nowMs, { hallWatts: -66, batteryVolts: 54.1, averageSOC: 99 })).observation,
  "indeterminate"
);
check(
  "low-voltage cut-off (49 V, hall −12 W) → indeterminate",
  evaluateDcSideIdle(snapshotAt(nowMs, { hallWatts: -12, batteryVolts: 49, averageSOC: 3, gridWatts: 450 }))
    .observation,
  "indeterminate"
);
check(
  "battery idle but house not importing (grid ≤ 100 W) → indeterminate",
  evaluateDcSideIdle(snapshotAt(nowMs, { gridWatts: 60 })).observation,
  "indeterminate"
);
check(
  "normal night discharge → healthy",
  evaluateDcSideIdle(
    snapshotAt(nowMs, {
      hallWatts: -645,
      batteryCurrent: -12,
      batteryDirection: "Discharging",
      dcAcDirection: "DC to AC",
      gridWatts: -250,
    })
  ).observation,
  "healthy"
);
check(
  "inverter reports current even though the hall reads ~0 → healthy",
  evaluateDcSideIdle(snapshotAt(nowMs, { batteryCurrent: -4, batteryDirection: "Discharging" })).observation,
  "healthy"
);
check(
  "inverter values 3 min old → indeterminate",
  evaluateDcSideIdle(snapshotAt(nowMs, { inverterAgeMs: 3 * 60_000 })).observation,
  "indeterminate"
);
check(
  "hall silent for a minute → indeterminate",
  evaluateDcSideIdle(snapshotAt(nowMs, { hallAgeMs: 60_000 })).observation,
  "indeterminate"
);

// ——— Rule A: PV stalled in daylight ———
check(
  "incident morning (sun 6°, strings 560 V, 0 W, both Idle) → failing",
  evaluatePvStalledInDaylight(snapshotAt(nowMs, { sunElevation: 6, pvVolts: 560 })).observation,
  "failing"
);
check(
  "dawn: strings at 450 V but sun only 1.5° → indeterminate",
  evaluatePvStalledInDaylight(snapshotAt(nowMs, { sunElevation: 1.5, pvVolts: 450 })).observation,
  "indeterminate"
);
check(
  "dull snowy day (35 W, Working) → healthy",
  evaluatePvStalledInDaylight(snapshotAt(nowMs, { sunElevation: 8, pvVolts: 380, pvWatts: 35, mpptStatus: "Working" }))
    .observation,
  "healthy"
);
check(
  "snow-covered strings below start-up voltage → indeterminate",
  evaluatePvStalledInDaylight(snapshotAt(nowMs, { sunElevation: 7, pvVolts: 120 })).observation,
  "indeterminate"
);
check(
  "dusk production below the sun gate still proves the MPPTs alive → healthy",
  evaluatePvStalledInDaylight(snapshotAt(nowMs, { sunElevation: 1, pvVolts: 420, pvWatts: 25, mpptStatus: "Working" }))
    .observation,
  "healthy"
);

// ——— Rule C: buy window not charging ———
const deadWindow = { commandedAmps: 281, acChargingEnabled: true, batteryVolts: 53.3, hallWatts: -20 };
check(
  "2026-10-21 05:00 window (281 A confirmed, 0 A taken) → failing",
  evaluateBuyWindowNotCharging(snapshotAt(nowMs, deadWindow)).observation,
  "failing"
);
check(
  "healthy window charging ~14.8 kW → healthy",
  evaluateBuyWindowNotCharging(
    snapshotAt(nowMs, {
      ...deadWindow,
      hallWatts: 14_800,
      batteryCurrent: 270,
      batteryDirection: "Charging",
      dcAcDirection: "AC to DC",
    })
  ).observation,
  "healthy"
);
check(
  "small 10 A command (~530 W) taking nothing → indeterminate, never failing",
  evaluateBuyWindowNotCharging(snapshotAt(nowMs, { ...deadWindow, commandedAmps: 10 })).observation,
  "indeterminate"
);
check(
  "1 A command (fuse headroom eaten by the house) → indeterminate",
  evaluateBuyWindowNotCharging(snapshotAt(nowMs, { ...deadWindow, commandedAmps: 1, hallWatts: 3 })).observation,
  "indeterminate"
);
check(
  "50 A command charging at 45 A → healthy",
  evaluateBuyWindowNotCharging(
    snapshotAt(nowMs, {
      ...deadWindow,
      commandedAmps: 50,
      hallWatts: 45 * 53.3,
      batteryCurrent: 45,
      batteryDirection: "Charging",
    })
  ).observation,
  "healthy"
);
check(
  "EDB1 not confirmed yet (still feeding the grid) → healthy via battery flow, not failing",
  evaluateBuyWindowNotCharging(
    snapshotAt(nowMs, {
      ...deadWindow,
      acChargingEnabled: false,
      hallWatts: -480,
      batteryCurrent: -9,
      batteryDirection: "Discharging",
    })
  ).observation,
  "healthy"
);
check(
  "window answered by discharging (−6 A, the switch-over never completed) → healthy, not this latch",
  evaluateBuyWindowNotCharging(
    snapshotAt(nowMs, { ...deadWindow, hallWatts: -560, batteryCurrent: -6, batteryDirection: "Discharging" })
  ).observation,
  "healthy"
);
check(
  "MUCHGC stuck at the 10 A idle default (inverter charging 10 A of 281) → healthy, a command-path problem",
  evaluateBuyWindowNotCharging(
    snapshotAt(nowMs, {
      ...deadWindow,
      hallWatts: 530,
      batteryCurrent: 10,
      batteryDirection: "Charging",
      dcAcDirection: "AC to DC",
    })
  ).observation,
  "healthy"
);
check(
  "hall sign inverted but the inverter reports 270 A charging → healthy",
  evaluateBuyWindowNotCharging(
    snapshotAt(nowMs, {
      ...deadWindow,
      hallWatts: -15_400,
      batteryCurrent: 270,
      batteryDirection: "Charging",
      dcAcDirection: "AC to DC",
    })
  ).observation,
  "healthy"
);
check(
  "idle window on a near-empty pack (50.1 V, SOC 4%) → not checked (low-voltage cut-off)",
  evaluateBuyWindowNotCharging(snapshotAt(nowMs, { ...deadWindow, batteryVolts: 50.1, averageSOC: 4, hallWatts: 72 }))
    .observation,
  "indeterminate"
);
check(
  "full pack held at the winter-2025/26 CV of 56.4 V, taking only the self-draw → not checked",
  evaluateBuyWindowNotCharging(
    snapshotAt(nowMs, { ...deadWindow, batteryVolts: 56.4, hallWatts: -230, averageSOC: 97 })
  ).observation,
  "indeterminate"
);
check(
  "BMS-stopped charge on a full pack, inverter's own draw still visible (hall −150 W, SOC 98%) → not checked",
  evaluateBuyWindowNotCharging(
    snapshotAt(nowMs, { ...deadWindow, batteryVolts: 54.1, hallWatts: -150, averageSOC: 98 })
  ).observation,
  "indeterminate"
);
check(
  "latch inside a buy window on a full pack (SOC 95%, hall −20 W) → failing",
  evaluateBuyWindowNotCharging(snapshotAt(nowMs, { ...deadWindow, batteryVolts: 53.8, averageSOC: 95 })).observation,
  "failing"
);

// ——— hall blindness (wiring warns once per streak) ———
check(
  "hall stale while the inverter talks → blind",
  hallBlindWhileInverterTalks(snapshotAt(nowMs, { hallAgeMs: 60_000 })),
  true
);
check("hall fresh → not blind", hallBlindWhileInverterTalks(snapshotAt(nowMs)), false);
check(
  "inverter silent too → not blind (the stale-mqtt rule owns that)",
  hallBlindWhileInverterTalks(snapshotAt(nowMs, { hallAgeMs: 60_000, inverterAgeMs: 5 * 60_000 })),
  false
);
check(
  "CV taper above 57 V → not checked",
  evaluateBuyWindowNotCharging(snapshotAt(nowMs, { ...deadWindow, batteryVolts: 57.6 })).observation,
  "indeterminate"
);

// ——— sustain tracker ———
const timing = { activateAfterMs: 30 * 60_000, clearAfterMs: 5 * 60_000 };
const failingFor29 = advanceSustainedCondition(
  advanceSustainedCondition(INACTIVE_SUSTAINED_CONDITION, "failing", 0, timing),
  "failing",
  29 * 60_000,
  timing
);
check("29 min of failing → not active yet", failingFor29.active, false);
const failingFor30 = advanceSustainedCondition(failingFor29, "failing", 30 * 60_000, timing);
check("30 min of failing → active, onset at the run start", [failingFor30.active, failingFor30.onsetMs], [true, 0]);
const brokenRun = advanceSustainedCondition(failingFor29, "indeterminate", 29.5 * 60_000, timing);
check(
  "an indeterminate tick restarts the run (no firing on unobserved time)",
  advanceSustainedCondition(brokenRun, "failing", 31 * 60_000, timing).active,
  false
);
const heldThroughNight = advanceSustainedCondition(failingFor30, "indeterminate", 8 * 3600_000, timing);
check("indeterminate holds an active condition (night for Rule A)", heldThroughNight.active, true);
const healthyFor4 = advanceSustainedCondition(
  advanceSustainedCondition(heldThroughNight, "healthy", 9 * 3600_000, timing),
  "healthy",
  9 * 3600_000 + 4 * 60_000,
  timing
);
check("4 min healthy → still active", healthyFor4.active, true);
check(
  "5 min healthy → cleared",
  advanceSustainedCondition(healthyFor4, "healthy", 9 * 3600_000 + 5 * 60_000, timing).active,
  false
);

// ——— hall smoothing: one 4 Hz spike must not break a run ———
const spikeWindow = createTrailingMeanWindow(60_000);
for (let sampleIndex = 0; sampleIndex < 240; sampleIndex++) {
  addTrailingSample(spikeWindow, { value: sampleIndex === 200 ? 6000 : -22, time: nowMs - 60_000 + sampleIndex * 250 });
}
const smoothedAfterSpike = trailingMean(spikeWindow, nowMs);
check(
  "a 6 kW single-sample spike leaves the 1-min mean inside the idle band",
  smoothedAfterSpike !== undefined && Math.abs(smoothedAfterSpike.value) < 150,
  true
);
check(
  "…so the smoothed evaluation stays failing",
  evaluateDcSideIdle({ ...snapshotAt(nowMs), smoothedHallWatts: smoothedAfterSpike }).observation,
  "failing"
);
check(
  "…whereas the raw spike would have read as healthy and restarted the 30 min",
  evaluateDcSideIdle(snapshotAt(nowMs, { hallWatts: 6000 })).observation,
  "healthy"
);
check("an emptied window has no mean", trailingMean(spikeWindow, nowMs + 120_000), undefined);

// ——— combined policy ———
const raisedAt = runPolicy(
  INVERTER_STUCK_IDLE_STATE,
  ONSET_MS,
  ONSET_MS + 40 * 60_000,
  tickMs => snapshotAt(tickMs),
  DEFAULT_SETTINGS
);
check(
  "B alone: one P2, 30 min after onset",
  raisedAt.actions.map(({ action, atMs }) => [action, (atMs - ONSET_MS) / 60_000]),
  [["raise_p2", 30]]
);
const withEscalation = runPolicy(
  raisedAt.state,
  ONSET_MS + 40 * 60_000 + 15_000,
  ONSET_MS + 4 * 3600_000,
  tickMs => snapshotAt(tickMs, tickMs > ONSET_MS + 2 * 3600_000 ? deadWindow : {}),
  { ...DEFAULT_SETTINGS, inverter_stuck_p1_after_minutes: 120 }
);
check(
  "C joining an active alert adds nothing; P1 once, 120 min after the P2",
  withEscalation.actions.map(({ action, atMs }) => [action, (atMs - ONSET_MS) / 60_000]),
  [["escalate_p1", 150]]
);
check(
  "p1_after_minutes 0 never escalates",
  runPolicy(
    raisedAt.state,
    ONSET_MS + 40 * 60_000 + 15_000,
    ONSET_MS + 10 * 3600_000,
    tickMs => snapshotAt(tickMs),
    DEFAULT_SETTINGS
  ).actions.length,
  0
);
const recovered = runPolicy(
  raisedAt.state,
  ONSET_MS + 50 * 60_000,
  ONSET_MS + 60 * 60_000,
  tickMs =>
    snapshotAt(tickMs, {
      hallWatts: -620,
      batteryCurrent: -11,
      batteryDirection: "Discharging",
      dcAcDirection: "DC to AC",
    }),
  DEFAULT_SETTINGS
);
check(
  "recovery: a quiet resolve after 5 min of battery flow",
  recovered.actions.map(({ action, atMs }) => [action, (atMs - ONSET_MS) / 60_000]),
  [["resolve", 55]]
);

check(
  "a small 10 A buy window charging under 30% never raises",
  runPolicy(
    INVERTER_STUCK_IDLE_STATE,
    ONSET_MS,
    ONSET_MS + 60 * 60_000,
    tickMs =>
      snapshotAt(tickMs, {
        ...deadWindow,
        commandedAmps: 10,
        hallWatts: 120,
        batteryCurrent: 2,
        batteryDirection: "Charging",
      }),
    DEFAULT_SETTINGS
  ).actions.length,
  0
);

// ——— episodes: evidence from one signature closes the ones that are only held (review of #51) ———
const winterSettings = { ...DEFAULT_SETTINGS, inverter_stuck_p1_after_minutes: 360 };
const winterDay = runPolicy(
  INVERTER_STUCK_IDLE_STATE,
  WINTER_LATCH_MS,
  WINTER_LATCH_MS + 20 * 3600_000,
  winterDaySnapshot,
  winterSettings
);
check(
  "winter-day latch, power-cycled in the dark with A held: resolved 5 min after the fix, and no P1 later",
  winterDay.actions.map(({ action, atMs }) => [action, new Date(atMs).toISOString().slice(11, 16)]),
  [
    ["raise_p2", "10:30"],
    ["resolve", "15:35"],
  ]
);
check(
  "…and the held PV signature was released with the episode",
  winterDay.state.rules.pv_stalled_in_daylight.active,
  false
);
const relatch = runPolicy(
  INVERTER_STUCK_IDLE_STATE,
  WINTER_LATCH_MS,
  WINTER_RELATCH_MS + 6 * 3600_000,
  snowyRelatchSnapshot,
  DEFAULT_SETTINGS
);
check(
  "snow after a night fix, latch again 3 days later: a fresh P2 for the new episode",
  relatch.actions.map(({ action, atMs }) => [action, new Date(atMs).toISOString().slice(5, 16)]),
  [
    ["raise_p2", "11-20T10:30"],
    ["resolve", "11-20T15:35"],
    ["raise_p2", "11-23T16:00"],
  ]
);
const windowEpisodes = runPolicyCollectingKeys(
  BUY_WINDOW_START_MS,
  BUY_WINDOW_START_MS + 40 * 60_000,
  relatchInsideWindowSnapshot
);
check(
  "Rule C recovers and re-latches inside one window: P2, resolve, and a second P2 on its own key",
  windowEpisodes.map(({ action, atMs }) => [action, new Date(atMs).toISOString().slice(11, 16)]),
  [
    ["raise_p2", "02:05"],
    ["resolve", "02:13"],
    ["raise_p2", "02:21"],
  ]
);
check(
  "…so the manager's per-key cooldown of the first P2 can't swallow the second",
  windowEpisodes[0].key !== windowEpisodes[2].key && windowEpisodes[2].key.startsWith("inverter-stuck:"),
  true
);
const heldOnly = runPolicy(
  raisedAt.state,
  ONSET_MS + 40 * 60_000 + 15_000,
  ONSET_MS + 3 * 3600_000,
  tickMs => snapshotAt(tickMs, { hallAgeMs: 60_000 }),
  { ...DEFAULT_SETTINGS, inverter_stuck_p1_after_minutes: 120 }
);
check("P1 time passes while the only active signature is held (hall stale) → no P1, no resolve", heldOnly.actions, []);
check(
  "…the P1 goes out on the first tick that observes it failing again",
  runPolicy(
    heldOnly.state,
    ONSET_MS + 3 * 3600_000 + 15_000,
    ONSET_MS + 3 * 3600_000 + 60_000,
    tickMs => snapshotAt(tickMs),
    {
      ...DEFAULT_SETTINGS,
      inverter_stuck_p1_after_minutes: 120,
    }
  ).actions.map(({ action, atMs }) => [action, (atMs - ONSET_MS) / 60_000]),
  [["escalate_p1", 180.25]]
);

// ——— the open episode survives a controller restart ———
const persisted = persistableEpisode(raisedAt.state);
check("an idle state persists nothing", persistableEpisode(INVERTER_STUCK_IDLE_STATE), undefined);
check("persisted: raise time, onset and the active signature's onset", persisted, {
  raised_at_ms: ONSET_MS + 30 * 60_000,
  onset_ms: ONSET_MS,
  escalated: false,
  active_rule_onsets: { dc_side_idle: ONSET_MS },
});
const restored = restoreEpisode(persisted);
check(
  "restored: B held active with its onset, runs start over",
  [restored.rules.dc_side_idle.active, restored.rules.dc_side_idle.onsetMs, restored.rules.dc_side_idle.failingSinceMs],
  [true, ONSET_MS, undefined]
);
const restartMs = ONSET_MS + 3 * 3600_000;
check(
  "still stuck after the restart: no second P2",
  runPolicy(restored, restartMs, restartMs + 45 * 60_000, tickMs => snapshotAt(tickMs), DEFAULT_SETTINGS).actions,
  []
);
check(
  "fixed during the downtime: resolved within 5 min of the restart",
  runPolicy(
    restored,
    restartMs,
    restartMs + 10 * 60_000,
    tickMs =>
      snapshotAt(tickMs, {
        hallWatts: -620,
        batteryCurrent: -11,
        batteryDirection: "Discharging",
        dcAcDirection: "DC to AC",
      }),
    DEFAULT_SETTINGS
  ).actions.map(({ action, atMs }) => [action, (atMs - restartMs) / 60_000]),
  [["resolve", 5]]
);
check("nothing persisted restores to idle", restoreEpisode(undefined), INVERTER_STUCK_IDLE_STATE);

// ——— messages (Europe/Stockholm: still CEST on 2026-10-21) ———
const p2Text = describeInverterStuckAlert(
  raisedAt.state,
  evaluateInverterStuckRules(snapshotAt(ONSET_MS + 30 * 60_000)),
  ONSET_MS + 30 * 60_000,
  "P2"
);
check("P2 title names the signature", p2Text.title, "Inverter stuck: DC side idle");
check(
  "P2 message gives local onset time and the power-cycle instruction",
  [p2Text.message.includes("since 06:15 (local time)"), p2Text.message.includes("power-cycle the inverter")],
  [true, true]
);
check("P2 fits Pushover's 1024-char cap", p2Text.message.length < 1024, true);
check(
  "resolve notice quotes the onset",
  describeInverterStuckResolved(ONSET_MS, ONSET_MS + 3600_000),
  "Power is flowing through the inverter's DC side again (stuck since 06:15, local time)."
);
check(
  "an onset on an earlier local day carries its date",
  formatStockholmTime(+new Date("2026-10-21T21:50:00Z"), +new Date("2026-10-22T06:00:00Z")),
  "2026-10-21 23:50"
);

// ——— the whole 2026-10-21 morning, 15 s ticks, hall at 4 Hz through the real trailing mean ———
const morningActions = replayIncidentMorning();
check(
  "incident replay: exactly one push, the P2 from Rule B ~30 min after the hall went quiet",
  morningActions.map(({ action, minutesAfterOnset }) => [action, minutesAfterOnset >= 30 && minutesAfterOnset <= 32]),
  [["raise_p2", true]]
);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll inverter-stuck checks passed");

function timedReading<Value>(value: Value, time: number) {
  return { value, time };
}

function runPolicy(
  initialState: InverterStuckAlertState,
  fromMs: number,
  toMs: number,
  snapshotFor: (tickMs: number) => InverterStuckSnapshot,
  settings: InverterStuckSettings
): { state: InverterStuckAlertState; actions: { action: InverterStuckAlertAction; atMs: number }[] } {
  let state = initialState;
  const actions: { action: InverterStuckAlertAction; atMs: number }[] = [];
  for (let tickMs = fromMs; tickMs <= toMs; tickMs += 15_000) {
    const step = stepInverterStuckAlert(state, evaluateInverterStuckRules(snapshotFor(tickMs)), tickMs, settings);
    state = step.state;
    if (step.action) actions.push({ action: step.action, atMs: tickMs });
  }
  return { state, actions };
}

function runPolicyCollectingKeys(
  fromMs: number,
  toMs: number,
  snapshotFor: (tickMs: number) => InverterStuckSnapshot
): { action: InverterStuckAlertAction; atMs: number; key: string }[] {
  let state = INVERTER_STUCK_IDLE_STATE;
  const actions: { action: InverterStuckAlertAction; atMs: number; key: string }[] = [];
  for (let tickMs = fromMs; tickMs <= toMs; tickMs += 15_000) {
    const step = stepInverterStuckAlert(
      state,
      evaluateInverterStuckRules(snapshotFor(tickMs)),
      tickMs,
      DEFAULT_SETTINGS
    );
    if (step.action) {
      // The wiring keys a resolve by the episode it closes, a P2/P1 by the episode it raises
      const key = inverterStuckAlertKey(step.action === "resolve" ? state : step.state);
      actions.push({ action: step.action, atMs: tickMs, key });
    }
    state = step.state;
  }
  return actions;
}

function winterSunElevation(atMs: number): number {
  const utcHours = new Date(atMs).getUTCHours() + new Date(atMs).getUTCMinutes() / 60;
  return utcHours >= 7.5 && utcHours <= 14 ? 6 : -10;
}

function winterDaySnapshot(atMs: number): InverterStuckSnapshot {
  const sunElevation = winterSunElevation(atMs);
  if (atMs < WINTER_FIX_MS) return snapshotAt(atMs, { sunElevation, pvVolts: sunElevation > 3 ? 450 : 0 });
  return snapshotAt(atMs, { ...normalDischarge, sunElevation });
}

/** After the night fix, snow keeps the strings under 300 V (Rule A can't judge), then it latches again */
function snowyRelatchSnapshot(atMs: number): InverterStuckSnapshot {
  if (atMs < WINTER_FIX_MS) return winterDaySnapshot(atMs);
  const sunElevation = winterSunElevation(atMs);
  const pvVolts = sunElevation > 3 ? 150 : 0;
  if (atMs < WINTER_RELATCH_MS) return snapshotAt(atMs, { ...normalDischarge, sunElevation, pvVolts });
  return snapshotAt(atMs, { sunElevation, pvVolts });
}

/** Dead buy window from 02:00, power-cycled at 02:08 (charging), latched again at 02:16 */
function relatchInsideWindowSnapshot(atMs: number): InverterStuckSnapshot {
  const minute = (atMs - BUY_WINDOW_START_MS) / 60_000;
  const window = { commandedAmps: minute < 60 ? 281 : 0, acChargingEnabled: minute < 60 };
  if (minute >= 8 && minute < 16) {
    return snapshotAt(atMs, {
      ...window,
      hallWatts: 14_800,
      batteryCurrent: 270,
      batteryDirection: "Charging",
      dcAcDirection: "AC to DC",
      batteryVolts: 54,
    });
  }
  return snapshotAt(atMs, window);
}

/**
 * 04:00–07:30 UTC: the 04:00 buy window charging at ~15 kW, the latch at 04:15:10, the dead
 * 05:00–05:15 window (EDB1 confirmed 05:01:40), ~2 A DC load steps, and sunrise lifting the
 * strings to 560 V while the MPPTs stay idle. Rules C and A activate on top of B silently.
 */
function replayIncidentMorning(): { action: InverterStuckAlertAction; minutesAfterOnset: number }[] {
  const startMs = +new Date("2026-10-21T04:00:00Z");
  const endMs = +new Date("2026-10-21T07:30:00Z");
  const hallWindow = createTrailingMeanWindow(60_000);
  let state = INVERTER_STUCK_IDLE_STATE;
  const actions: { action: InverterStuckAlertAction; minutesAfterOnset: number }[] = [];
  let nextHallSampleMs = startMs;
  for (let tickMs = startMs; tickMs <= endMs; tickMs += 15_000) {
    nextHallSampleMs = feedHallUntil(hallWindow, nextHallSampleMs, tickMs);
    const snapshot = {
      ...snapshotAt(tickMs, incidentValuesAt(tickMs)),
      smoothedHallWatts: trailingMean(hallWindow, tickMs),
    };
    const step = stepInverterStuckAlert(state, evaluateInverterStuckRules(snapshot), tickMs, DEFAULT_SETTINGS);
    state = step.state;
    if (step.action) actions.push({ action: step.action, minutesAfterOnset: (tickMs - ONSET_MS) / 60_000 });
  }
  check(
    "incident replay: B, C and A all active by 07:30",
    [
      state.rules.dc_side_idle.active,
      state.rules.buy_window_not_charging.active,
      state.rules.pv_stalled_in_daylight.active,
    ],
    [true, true, true]
  );
  return actions;
}

function feedHallUntil(hallWindow: TrailingMeanWindow, fromMs: number, untilMs: number): number {
  let sampleMs = fromMs;
  for (; sampleMs <= untilMs; sampleMs += 250) {
    addTrailingSample(hallWindow, { value: incidentHallWattsAt(sampleMs), time: sampleMs });
  }
  return sampleMs;
}

function incidentHallWattsAt(atMs: number): number {
  if (atMs < ONSET_MS) return 15_400;
  const dcLoadStepOn =
    (atMs >= +new Date("2026-10-21T04:57:00Z") && atMs < +new Date("2026-10-21T05:39:00Z")) ||
    atMs >= +new Date("2026-10-21T05:48:00Z");
  return dcLoadStepOn ? -128 : -22;
}

function incidentValuesAt(atMs: number): SnapshotValues {
  const sunElevation = sunElevationDegrees(atMs, 59.25, 15.22);
  if (atMs < ONSET_MS) {
    return {
      batteryCurrent: 270,
      batteryVolts: 55.2,
      batteryDirection: "Charging",
      dcAcDirection: "AC to DC",
      gridWatts: 15_900,
      commandedAmps: 281,
      acChargingEnabled: true,
      sunElevation,
    };
  }
  const inDeadWindow = atMs >= +new Date("2026-10-21T05:00:00Z") && atMs < +new Date("2026-10-21T05:15:00Z");
  const sunriseMs = +new Date("2026-10-21T05:50:00Z");
  return {
    batteryVolts: 53.3,
    gridWatts: 320,
    commandedAmps: inDeadWindow ? 281 : 0,
    acChargingEnabled: inDeadWindow && atMs >= +new Date("2026-10-21T05:01:40Z"),
    pvVolts: atMs < sunriseMs ? 0 : Math.min(560, ((atMs - sunriseMs) / (40 * 60_000)) * 560),
    sunElevation,
  };
}
