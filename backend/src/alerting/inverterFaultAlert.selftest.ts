/**
 * Self-test for the inverter fault alerts: the policy on what the inverter reports about itself
 * (Fault / Bypass mode, new fault codes) and its hand-off with the stuck-inverter alert. Pure: the
 * status is built the way inverterStatusTracking.ts builds it, ticked every 15 s like the wiring.
 * Run from backend/ with:
 *   yarn node src/alerting/inverterFaultAlert.selftest.ts
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import process from "process";
import { default_config } from "../config/config.ts";
import type { InverterOperatingStatus, InverterWorkingModeCode } from "../inverterComms/inverterStatus.types.ts";
import { describeInverterFaultCode } from "../inverterComms/inverterFaultCodes.ts";
import { WORKING_MODE_TEXT_BY_CODE } from "../inverterComms/pi17FieldTables.ts";
import {
  describeActiveInverterFault,
  faultModeP1Open,
  type InverterFaultAlert,
  type InverterFaultAlertState,
  type InverterFaultSettings,
  INVERTER_FAULT_IDLE_STATE,
  type PersistedInverterFaultAlerts,
  persistableFaultAlerts,
  restoreFaultAlerts,
  stepInverterFaultAlerts,
} from "./inverterFaultAlertPolicy.ts";
import { describeInverterStuckAlert, INVERTER_STUCK_IDLE_STATE } from "./inverterStuckAlertPolicy.ts";
import {
  flushFaultAlertStateWrites,
  loadFaultAlertState,
  saveFaultAlertState,
  useFaultAlertStatePathForTests,
} from "./inverterFaultEpisodeStore.ts";
import { evaluateInverterStuckRules } from "./inverterStuckDetection.ts";

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

const DEFAULT_SETTINGS: InverterFaultSettings = default_config.alerting;
/** 2026-10-21 04:15:06 UTC, the fault 14 latch (06:15 in Stockholm) */
const LATCH_MS = +new Date("2026-10-21T04:15:06Z");
const TICK_MS = 15_000;
const GRID_PRESENT = { value: 236.7, time: 0 };

/** A reading as the tracker would publish it; values carry over between readings like the real status */
type Reading =
  | { atS: number; mode: InverterWorkingModeCode }
  | { atS: number; faultCode: number; recordId?: number }
  | { atS: number; warnings: string[] };

type Scenario = {
  readings: readonly Reading[];
  untilS: number;
  settings?: Partial<InverterFaultSettings>;
  gridVolts?: number;
  stuckP1Open?: boolean;
  /** What a restart brings back from the episode file (default: nothing, a first boot) */
  initialState?: InverterFaultAlertState;
};

/** Ticks the policy every 15 s from the first reading on; returns every alert with its tick time (s after LATCH_MS) */
function runScenario(scenario: Scenario): {
  alerts: (InverterFaultAlert & { atS: number })[];
  state: InverterFaultAlertState;
} {
  const settings = { ...DEFAULT_SETTINGS, ...scenario.settings };
  const sortedReadings = [...scenario.readings].sort((first, second) => first.atS - second.atS);
  const alerts: (InverterFaultAlert & { atS: number })[] = [];
  let state = scenario.initialState ?? INVERTER_FAULT_IDLE_STATE;
  let status: InverterOperatingStatus = {
    working_mode: undefined,
    latest_fault: undefined,
    warnings: undefined,
    fault_records: [],
  };
  let readingIndex = 0;
  for (let tickS = sortedReadings[0]!.atS; tickS <= scenario.untilS; tickS += TICK_MS / 1000) {
    while (readingIndex < sortedReadings.length && sortedReadings[readingIndex]!.atS <= tickS) {
      status = withReading(status, sortedReadings[readingIndex]!);
      readingIndex++;
    }
    const nowMs = LATCH_MS + tickS * 1000;
    const step = stepInverterFaultAlerts(
      state,
      {
        nowMs,
        status,
        gridVoltage: { value: scenario.gridVolts ?? GRID_PRESENT.value, time: nowMs - 1_000 },
        stuckP1Open: scenario.stuckP1Open ?? false,
      },
      settings
    );
    state = step.state;
    alerts.push(...step.alerts.map(alert => ({ ...alert, atS: tickS })));
  }
  return { alerts, state };
}

function withReading(status: InverterOperatingStatus, reading: Reading): InverterOperatingStatus {
  const atMs = LATCH_MS + reading.atS * 1000;
  if ("mode" in reading) {
    const sameMode = status.working_mode?.code === reading.mode;
    return {
      ...status,
      working_mode: {
        code: reading.mode,
        text: WORKING_MODE_TEXT_BY_CODE[reading.mode],
        since: sameMode ? status.working_mode!.since : atMs,
        since_is_onset: sameMode ? status.working_mode!.since_is_onset : status.working_mode !== undefined,
        time: atMs,
      },
    };
  }
  if ("faultCode" in reading) {
    const recordId = reading.recordId ?? 0;
    const sameFault = status.latest_fault?.code === reading.faultCode && status.latest_fault.record_id === recordId;
    return {
      ...status,
      latest_fault: {
        code: reading.faultCode,
        text: describeInverterFaultCode(reading.faultCode),
        record_id: recordId,
        since: sameFault ? status.latest_fault!.since : atMs,
        time: atMs,
      },
    };
  }
  return { ...status, warnings: { active: reading.warnings, time: atMs } };
}

/** Minute polls of one mode from `fromS` to `toS` */
function modeEveryMinute(mode: InverterWorkingModeCode, fromS: number, toS: number): Reading[] {
  const readings: Reading[] = [];
  for (let atS = fromS; atS <= toS; atS += 60) readings.push({ atS, mode });
  return readings;
}

function summary(alerts: readonly (InverterFaultAlert & { atS: number })[]) {
  return alerts.map(alert => [alert.severity, alert.title, alert.atS]);
}

const STARTUP_BASELINE: Reading[] = [
  { atS: -300, mode: "05" },
  { atS: -299, faultCode: 12 },
  { atS: -298, warnings: [] },
  ...modeEveryMinute("05", -240, -60),
];

// ——— 2026-10-21: the latch as the engine would have read it, and the recovery 59 h later ———
{
  const latch = runScenario({
    readings: [
      ...STARTUP_BASELINE,
      // DC-idle trigger: MOD at +8 s, the mode change pulls CFS at +9 s; then the minute polls
      { atS: 8, mode: "04" },
      { atS: 9, faultCode: 14 },
      ...modeEveryMinute("04", 50, 600),
    ],
    untilS: 600,
  });
  // The minute poll at +50 s comes too soon after the DC-idle read at +8 s; the one at +110 s pages
  check(
    "latch: one P1, at the first tick after Fault mode was read 60 s apart; no separate P2 for the new code",
    summary(latch.alerts),
    [["P1", "Inverter in Fault mode: F14", 120]]
  );
  const page = latch.alerts[0]!;
  check(
    "the P1 names the fault, the consequence and the power-cycle procedure",
    [
      page.message.includes("since 06:15 (local time)"),
      page.message.includes("F14 Inverter DC current exceed permit range when feed power"),
      page.message.includes("no backup"),
      page.message.includes(
        "switch off the battery, the utility (grid) and the PV; then switch on the battery, the PV and the utility"
      ),
      page.message.length < 1024,
    ],
    [true, true, true, true, true]
  );
  check("while it pages, the stuck alert sees the fault P1 as open", faultModeP1Open(latch.state), true);

  const recovered = runScenario({
    readings: [
      ...STARTUP_BASELINE,
      { atS: 8, mode: "04" },
      { atS: 9, faultCode: 14 },
      ...modeEveryMinute("04", 50, 59 * 3600),
      { atS: 59 * 3600 + 30, mode: "05" },
      // CFS stays 14: sticky, no new alert
      { atS: 59 * 3600 + 31, faultCode: 14 },
    ],
    untilS: 59 * 3600 + 120,
  });
  check("recovery: the P1, then a single quiet P3 once a reading says Hybrid", summary(recovered.alerts), [
    ["P1", "Inverter in Fault mode: F14", 120],
    ["P3", "Resolved: Inverter in Fault mode", 59 * 3600 + 30],
  ]);
  check(
    "the resolve notice says for how long",
    recovered.alerts[1]!.message.startsWith(
      "The inverter left Fault mode for Hybrid mode (Line mode, Grid mode) after 59.0 h (in Fault mode since 2026-10-21 06:15 (local time);"
    ),
    true
  );
  check(
    "each episode has its own key (a re-latch must not land in the previous page's cooldown)",
    [recovered.alerts[0]!.key, recovered.alerts[1]!.key],
    [`inverter-fault-mode:${LATCH_MS + 8_000}`, `inverter-fault-mode:${LATCH_MS + 8_000}:resolved`]
  );
  check("after the resolve the fault P1 no longer counts as open", faultModeP1Open(recovered.state), false);
}

// ——— the persistence rule ———
check(
  "two Fault-mode readings 59 s apart don't page; the reading at 60 s does",
  [
    summary(
      runScenario({ readings: [...STARTUP_BASELINE, { atS: 0, mode: "04" }, { atS: 59, mode: "04" }], untilS: 120 })
        .alerts
    ),
    summary(
      runScenario({ readings: [...STARTUP_BASELINE, { atS: 0, mode: "04" }, { atS: 60, mode: "04" }], untilS: 120 })
        .alerts
    ),
  ],
  [[], [["P1", "Inverter in Fault mode: F12", 60]]]
);
check(
  "a single Fault-mode reading never pages, however long the MOD poll then stays silent",
  summary(runScenario({ readings: [...STARTUP_BASELINE, { atS: 0, mode: "04" }], untilS: 3600 }).alerts),
  []
);
check(
  "Fault mode interrupted by another mode starts over",
  summary(
    runScenario({
      // 0 → 100 s would page as one run; the Battery-mode reading in between restarts it at 50 s
      readings: [
        ...STARTUP_BASELINE,
        { atS: 0, mode: "04" },
        { atS: 40, mode: "03" },
        { atS: 50, mode: "04" },
        { atS: 100, mode: "04" },
        { atS: 110, mode: "04" },
      ],
      untilS: 200,
    }).alerts
  ),
  [["P1", "Inverter in Fault mode: F12", 120]]
);
check(
  "with inverter_fault_mode_p1 off, Fault mode doesn't page",
  summary(
    runScenario({
      readings: [...STARTUP_BASELINE, ...modeEveryMinute("04", 0, 600)],
      untilS: 600,
      settings: { inverter_fault_mode_p1: false },
    }).alerts
  ),
  []
);
{
  const afterStuckPage = runScenario({
    readings: [...STARTUP_BASELINE, { atS: 9, faultCode: 14 }, ...modeEveryMinute("04", 0, 300)],
    untilS: 300,
    stuckP1Open: true,
  });
  check(
    "one P1 per episode: when the stuck alert already paged, Fault mode goes out as P2 and says why",
    [
      summary(afterStuckPage.alerts),
      afterStuckPage.alerts[0]!.message.endsWith(
        "(Sent as P2: the stuck-inverter alert already paged for this episode.)"
      ),
    ],
    [[["P2", "Inverter in Fault mode: F14", 60]], true]
  );
  check("a downgraded page doesn't count as the fault P1", faultModeP1Open(afterStuckPage.state), false);
}

// ——— new fault codes ———
check(
  "a restart is no new fault: the first CFS reading is a baseline",
  summary(runScenario({ readings: [{ atS: 0, faultCode: 14 }, ...modeEveryMinute("05", 0, 600)], untilS: 600 }).alerts),
  []
);
{
  // A fault the inverter got over within the minute (like the 2026-02-25 F12 blip)
  const blip = runScenario({
    readings: [...STARTUP_BASELINE, { atS: 0, mode: "04" }, { atS: 1, faultCode: 14 }, { atS: 30, mode: "05" }],
    untilS: 300,
  });
  check("a fault that clears before the P1 is due: one P2 once a reading shows it running", summary(blip.alerts), [
    ["P2", "Inverter recorded fault F14", 30],
  ]);
  check(
    "the P2 names the new and the previous fault and the current mode",
    blip.alerts[0]!.message,
    "The inverter recorded a new fault by 06:15 (local time): F14 Inverter DC current exceed permit range when feed power (the one before: F12 Leakage current exceed permit range (GFCI fault)). It is in Hybrid mode (Line mode, Grid mode) now, so it is running (it may have recovered by itself)."
  );
}
{
  // 2025-04-13: F23 overload during a grid outage — it stayed in Battery mode throughout
  const overload = runScenario({
    readings: [
      ...STARTUP_BASELINE,
      { atS: 0, faultCode: 23 },
      { atS: 1, mode: "03" },
      { atS: 2, warnings: ["Over load"] },
    ],
    untilS: 120,
  });
  check(
    "a new code with the inverter running on: one P2 at the next tick, warnings quoted",
    [
      summary(overload.alerts),
      overload.alerts[0]!.message.endsWith(
        "It is in Battery mode now, so it is running (it may have recovered by itself). Inverter warnings: Over load."
      ),
    ],
    [[["P2", "Inverter recorded fault F23", 15]], true]
  );
}
check(
  "a new code whose mode reading predates it waits for a fresh one",
  summary(
    runScenario({
      readings: [...STARTUP_BASELINE, { atS: 0, mode: "05" }, { atS: 10, faultCode: 57 }, { atS: 40, mode: "05" }],
      untilS: 120,
    }).alerts
  ),
  [["P2", "Inverter recorded fault F57", 45]]
);
{
  const modeUnreadable = runScenario({ readings: [...STARTUP_BASELINE, { atS: 0, faultCode: 14 }], untilS: 400 });
  check(
    "a new code with no mode reading after it is reported after 3 min, saying so",
    [
      summary(modeUnreadable.alerts),
      modeUnreadable.alerts[0]!.message.includes("Its working mode hasn't been read since."),
    ],
    [[["P2", "Inverter recorded fault F14", 180]], true]
  );
}
{
  const noFaultPage = runScenario({
    readings: [
      ...STARTUP_BASELINE,
      { atS: 0, mode: "04" },
      { atS: 1, faultCode: 14 },
      ...modeEveryMinute("04", 60, 300),
    ],
    untilS: 300,
    settings: { inverter_fault_mode_p1: false },
  });
  // The mode read at 0 s predates the code read at 1 s, so the P2 waits for the minute poll at 60 s
  check(
    "with the Fault-mode P1 off, the new code's P2 carries the power-cycle procedure instead",
    [
      summary(noFaultPage.alerts),
      noFaultPage.alerts[0]!.message.includes("It is in Fault mode: Check the LCD fault code, then power-cycle"),
    ],
    [[["P2", "Inverter recorded fault F14", 60]], true]
  );
}
check(
  "with inverter_fault_code_p2 off, a new code alone says nothing",
  summary(
    runScenario({
      readings: [...STARTUP_BASELINE, { atS: 0, faultCode: 23 }, { atS: 1, mode: "03" }],
      untilS: 300,
      settings: { inverter_fault_code_p2: false },
    }).alerts
  ),
  []
);

// ——— Bypass ———
{
  // 2024-08-19: the battery dropped out and the inverter fell back to Bypass at dusk
  const bypass = runScenario({
    readings: [
      ...STARTUP_BASELINE,
      { atS: 0, warnings: ["Battery disconnected"] },
      ...modeEveryMinute("02", 0, 3 * 3600),
      { atS: 3 * 3600 + 30, mode: "05" },
    ],
    untilS: 3 * 3600 + 60,
  });
  check("Bypass with the grid present: a P2 once read for 2 min, a quiet P3 when it ends", summary(bypass.alerts), [
    ["P2", "Inverter in Bypass mode", 120],
    ["P3", "Resolved: Inverter in Bypass mode", 3 * 3600 + 30],
  ]);
  check(
    "the Bypass P2 points at the disconnected battery",
    bypass.alerts[0]!.message,
    "The inverter has been in Bypass mode since 06:15 (local time) with the grid at 237 V: the house runs straight off the grid, with the battery and PV unused and no backup. Every Bypass so far was a disconnected battery. The inverter also warns the battery is disconnected: check the battery breaker and the BMS."
  );
}
check(
  "a Bypass blip under 2 min says nothing",
  summary(
    runScenario({
      readings: [...STARTUP_BASELINE, ...modeEveryMinute("02", 0, 60), { atS: 100, mode: "05" }],
      untilS: 300,
    }).alerts
  ),
  []
);
check(
  "Bypass without the grid is the grid-out alert's business",
  summary(
    runScenario({ readings: [...STARTUP_BASELINE, ...modeEveryMinute("02", 0, 600)], untilS: 600, gridVolts: 0 }).alerts
  ),
  []
);

// ——— restarts: the episode survives them (inverterFaultEpisodeStore.ts round-trips it as JSON) ———
/**
 * One latch, the controller restarting every 5 min (a main() crash loop): each boot starts with an
 * empty tracker (its first MOD reading 2 s after boot, then one a minute) and whatever the episode
 * file held at the previous shutdown.
 */
function runAcrossRestarts(boots: readonly { bootS: number; untilS: number; mode: InverterWorkingModeCode }[]) {
  let persisted: PersistedInverterFaultAlerts | undefined;
  const alerts: (InverterFaultAlert & { atS: number })[] = [];
  for (const [bootIndex, boot] of boots.entries()) {
    const restored = persisted && restoreFaultAlerts(JSON.parse(JSON.stringify(persisted)));
    // The very first boot still has its Hybrid baseline, so the onset of the latch is known
    const baseline: Reading[] =
      bootIndex === 0
        ? [
            { atS: boot.bootS + 2, mode: "05" },
            { atS: boot.bootS + 3, faultCode: 12 },
          ]
        : [];
    const latchReadings: Reading[] =
      bootIndex === 0
        ? [{ atS: 8, mode: "04" }, { atS: 9, faultCode: 14 }, ...modeEveryMinute("04", 68, boot.untilS)]
        : [{ atS: boot.bootS + 3, faultCode: 14 }, ...modeEveryMinute(boot.mode, boot.bootS + 2, boot.untilS)];
    const run = runScenario({ readings: [...baseline, ...latchReadings], untilS: boot.untilS, initialState: restored });
    alerts.push(...run.alerts);
    persisted = persistableFaultAlerts(run.state);
  }
  return { alerts, persisted };
}
{
  const crashLoop = runAcrossRestarts([
    { bootS: -60, untilS: 290, mode: "04" },
    { bootS: 300, untilS: 590, mode: "04" },
    { bootS: 600, untilS: 890, mode: "04" },
    { bootS: 900, untilS: 1190, mode: "04" },
    { bootS: 1200, untilS: 1490, mode: "04" },
    { bootS: 1500, untilS: 1700, mode: "05" },
  ]);
  check(
    "restarts every 5 min during a latch: one P1 in all, and one P3 when a boot finds it running again",
    summary(crashLoop.alerts),
    [
      ["P1", "Inverter in Fault mode: F14", 77],
      ["P3", "Resolved: Inverter in Fault mode", 1502],
    ]
  );
  check(
    "the P3 carries the first episode's key and onset across the restarts",
    [crashLoop.alerts[1]!.key, crashLoop.alerts[1]!.message.includes("in Fault mode since 06:15 (local time)")],
    [`inverter-fault-mode:${LATCH_MS + 8_000}:resolved`, true]
  );
  check(
    "nothing stays open after the resolve",
    [crashLoop.persisted?.fault_mode, crashLoop.persisted?.bypass],
    [null, null]
  );
}
{
  // Down longer than the 30-min alert cooldown: the restored episode is not continued, the latch pages again
  const longDowntime = runAcrossRestarts([
    { bootS: -60, untilS: 290, mode: "04" },
    { bootS: 290 + 45 * 60, untilS: 290 + 50 * 60, mode: "04" },
  ]);
  check(
    "latch, controller down 45 min, boot still in Fault: a second P1 with its own key, 60 s after the boot's first reading",
    [
      summary(longDowntime.alerts),
      longDowntime.alerts[1]?.key,
      longDowntime.alerts[1]?.message.includes("in Fault mode at least since 07:04 (local time)"),
    ],
    [
      [
        ["P1", "Inverter in Fault mode: F14", 77],
        ["P1", "Inverter in Fault mode: F14", 2992 + 60],
      ],
      `inverter-fault-mode:${LATCH_MS + 2992 * 1000}`,
      true,
    ]
  );
  const shortRestart = runAcrossRestarts([
    { bootS: -60, untilS: 290, mode: "04" },
    { bootS: 300, untilS: 900, mode: "04" },
  ]);
  check("a 5-min restart in the same latch continues the episode: no second P1", summary(shortRestart.alerts), [
    ["P1", "Inverter in Fault mode: F14", 77],
  ]);
  // The pi boots on a clock 10 min behind (fake-hwclock's last save), before NTP: still a short restart
  const clockBehind = runAcrossRestarts([
    { bootS: -60, untilS: 290, mode: "04" },
    { bootS: 248 - 600, untilS: 0, mode: "04" },
  ]);
  check(
    "a boot clock behind by less than the cooldown is taken as a short restart: no second P1",
    summary(clockBehind.alerts),
    [["P1", "Inverter in Fault mode: F14", 77]]
  );
}
{
  // Adopted on a pre-NTP clock that reads "just after the shutdown", then NTP steps it 45 min forward:
  // the step itself splits the episode, so the long downtime still pages again
  const beforeShutdown = runAcrossRestarts([{ bootS: -60, untilS: 290, mode: "04" }]);
  const afterBoot = runScenario({
    readings: [
      { atS: 303, faultCode: 14 },
      ...modeEveryMinute("04", 302, 422),
      ...modeEveryMinute("04", 422 + 45 * 60, 422 + 50 * 60),
    ],
    untilS: 422 + 50 * 60,
    initialState: restoreFaultAlerts(JSON.parse(JSON.stringify(beforeShutdown.persisted))),
  });
  check(
    "an NTP step of 45 min after a pre-NTP adoption opens a new episode and pages after its 60 s",
    summary(afterBoot.alerts),
    [["P1", "Inverter in Fault mode: F14", 422 + 45 * 60 + 60]]
  );
}
{
  // Paged, then the controller is down while someone power-cycles; the first reading after the boot says Hybrid
  const pagedThenDown = runAcrossRestarts([
    { bootS: -60, untilS: 200, mode: "04" },
    { bootS: 900, untilS: 1000, mode: "05" },
  ]);
  check(
    "a latch that cleared while the controller was down is resolved by the first reading after the boot",
    summary(pagedThenDown.alerts),
    [
      ["P1", "Inverter in Fault mode: F14", 77],
      ["P3", "Resolved: Inverter in Fault mode", 902],
    ]
  );
  check(
    'it cleared at an unknown point of the downtime, so the P3 says "within"',
    pagedThenDown.alerts[1]?.message.startsWith(
      "The inverter left Fault mode for Hybrid mode (Line mode, Grid mode) within 15 min, while the controller was down"
    ),
    true
  );
}
{
  // Down before the page went out: the pre-restart readings count towards the 60 s
  const downBeforeThePage = runAcrossRestarts([
    { bootS: -60, untilS: 40, mode: "04" },
    { bootS: 70, untilS: 200, mode: "04" },
  ]);
  check(
    "a restart before the page keeps the onset: the first readings after the boot (64 s past it) page, not one a minute later",
    summary(downBeforeThePage.alerts),
    [["P1", "Inverter in Fault mode: F14", 87]]
  );
}
{
  const firstBootInFault = runScenario({
    readings: [{ atS: 0, faultCode: 14 }, ...modeEveryMinute("04", 0, 120)],
    untilS: 120,
  });
  check(
    'a controller that starts with the inverter already in Fault mode says "at least since"',
    [
      summary(firstBootInFault.alerts),
      firstBootInFault.alerts[0]!.message.includes("in Fault mode at least since 06:15 (local time)"),
    ],
    [[["P1", "Inverter in Fault mode: F14", 60]], true]
  );
}
{
  const faultDuringOutage = runScenario({
    readings: [...STARTUP_BASELINE, ...modeEveryMinute("04", 0, 120)],
    untilS: 120,
    gridVolts: 0,
  });
  check(
    "Fault mode during a grid outage doesn't claim the house runs on the grid",
    [
      faultDuringOutage.alerts[0]!.message.includes(
        "Battery and PV are off and the grid is down: the house has no power."
      ),
      faultDuringOutage.alerts[0]!.message.includes("runs on the grid"),
    ],
    [true, false]
  );
}
{
  const nightlyFlags = ["Solar input 1 loss", "Solar input 2 loss", "Equalization state"];
  const atNight = runScenario({
    readings: [...STARTUP_BASELINE, { atS: -1, warnings: nightlyFlags }, ...modeEveryMinute("04", 0, 120)],
    untilS: 120,
  });
  const overheated = runScenario({
    readings: [
      ...STARTUP_BASELINE,
      { atS: -1, warnings: [...nightlyFlags, "Over temperature"] },
      ...modeEveryMinute("04", 0, 120),
    ],
    untilS: 120,
  });
  check(
    "the flags set every night stay out of the page; a telling one is still quoted",
    [
      atNight.alerts[0]!.message.includes("Inverter warnings"),
      overheated.alerts[0]!.message.endsWith("Inverter warnings: Over temperature."),
    ],
    [false, true]
  );
}
{
  // Paged for F14; 10 min later the latest code turns 23 while it is still in Fault mode
  const secondCode = runScenario({
    readings: [
      ...STARTUP_BASELINE,
      { atS: 8, mode: "04" },
      { atS: 9, faultCode: 14 },
      ...modeEveryMinute("04", 68, 900),
      { atS: 600, faultCode: 23 },
    ],
    untilS: 900,
  });
  check(
    "a new code during an already-paged Fault episode gets its own P2, naming it and the page",
    [
      summary(secondCode.alerts),
      secondCode.alerts[1]?.message.includes("F23 Overload"),
      secondCode.alerts[1]?.message.includes(
        "It came while the inverter is still in Fault mode, paged at 06:16 for F14."
      ),
    ],
    [
      [
        ["P1", "Inverter in Fault mode: F14", 75],
        ["P2", "Inverter recorded fault F23", 600],
      ],
      true,
      true,
    ]
  );
}
{
  // A new code read with Fault mode, then the MOD poll stops: the last reading went stale, but it was read
  const staleMode = runScenario({
    readings: [...STARTUP_BASELINE, { atS: 0, faultCode: 14 }, { atS: 2, mode: "04" }],
    untilS: 400,
  });
  check(
    'a mode reading that only went stale is quoted as such, not as "not read"',
    [
      summary(staleMode.alerts),
      staleMode.alerts[0]!.message.includes("Its working mode was last read at 06:15, as Fault mode."),
    ],
    [[["P2", "Inverter recorded fault F14", 195]], true]
  );
}
{
  const restoredFromBefore = restoreFaultAlerts({
    fault_mode: null,
    bypass: null,
    last_seen_latest_fault: { code: 12, record_id: 0 },
    pending_new_fault: null,
  });
  const recordedWhileDown = runScenario({
    readings: [{ atS: 0, faultCode: 14 }, ...modeEveryMinute("05", 1, 120)],
    untilS: 120,
    initialState: restoredFromBefore,
  });
  check(
    "a fault recorded while the controller was down is new against the last code seen before",
    summary(recordedWhileDown.alerts),
    [["P2", "Inverter recorded fault F14", 15]]
  );
}

// ——— the continuity window never drops below what the policy still acts on ———
for (const cooldownMinutes of [0, 1]) {
  const shortCooldown = runScenario({
    readings: [
      ...STARTUP_BASELINE,
      { atS: 8, mode: "04" },
      { atS: 9, faultCode: 14 },
      ...modeEveryMinute("04", 68, 600),
    ],
    untilS: 600,
    settings: { cooldown_minutes: cooldownMinutes },
  });
  check(
    `cooldown_minutes ${cooldownMinutes}: minute readings stay one episode, and Fault mode still pages`,
    summary(shortCooldown.alerts),
    [["P1", "Inverter in Fault mode: F14", 75]]
  );
}

// ——— the review's replay: a 3-min power cut, then a boot on a clock 40 min behind the last reading ———
{
  const ntpAfter4Min = replayBootOnLaggingClock(40 * 60_000, 4 * 60_000);
  const ntpAfter30s = replayBootOnLaggingClock(40 * 60_000, 30_000);
  check(
    "a boot clock 40 min behind adopts the episode: no page with an onset before the latch",
    [ntpAfter4Min, ntpAfter30s].map(pages => pages.some(page => page.message.includes("since 05:"))),
    [false, false]
  );
  // The NTP step itself is lag + downtime (43 min here): with wall-clock data alone it still reads as
  // a blind spot past the cooldown once — at most one more page, with an onset after the latch
  check(
    "at most one page after such a boot, whenever NTP arrives",
    [ntpAfter4Min, ntpAfter30s].map(pages => pages.filter(page => page.afterBoot).length <= 1),
    [true, true]
  );
}

{
  // Paged, the link silent for 5 min (the power-cycle with the pi still up), Hybrid read the moment it
  // answers again, then a re-latch: a P3, and the re-latch pages as a new episode
  const relatchAfterOutage = runScenario({
    readings: [
      ...STARTUP_BASELINE,
      { atS: 8, mode: "04" },
      { atS: 9, faultCode: 14 },
      ...modeEveryMinute("04", 68, 188),
      { atS: 501, mode: "05" },
      ...modeEveryMinute("04", 620, 800),
    ],
    untilS: 800,
  });
  check(
    "a re-latch right after a link outage still pages: P1, P3 when Hybrid is read, a new P1",
    summary(relatchAfterOutage.alerts),
    [
      ["P1", "Inverter in Fault mode: F14", 75],
      ["P3", "Resolved: Inverter in Fault mode", 510],
      ["P1", "Inverter in Fault mode: F14", 690],
    ]
  );
}

// ——— what the stuck-inverter alert borrows ———
{
  const nowMs = LATCH_MS + 31 * 60_000;
  const inFault: InverterOperatingStatus = {
    working_mode: {
      code: "04",
      text: "Fault mode",
      since: LATCH_MS + 8_000,
      since_is_onset: true,
      time: nowMs - 20_000,
    },
    latest_fault: {
      code: 14,
      text: describeInverterFaultCode(14),
      record_id: 0,
      since: LATCH_MS + 9_000,
      time: nowMs - 19_000,
    },
    warnings: { active: [], time: nowMs - 18_000 },
    fault_records: [],
  };
  const sentence = describeActiveInverterFault(inFault, nowMs);
  check(
    "the stuck alert's fault sentence while the inverter reports Fault mode",
    sentence,
    "The inverter itself reports Fault mode since 06:15 (local time), latest recorded fault F14 Inverter DC current exceed permit range when feed power."
  );
  check(
    "no fault sentence in Hybrid mode, or from a stale reading",
    [
      describeActiveInverterFault(
        {
          ...inFault,
          working_mode: { ...inFault.working_mode!, code: "05", text: "Hybrid mode (Line mode, Grid mode)" },
        },
        nowMs
      ),
      describeActiveInverterFault(inFault, nowMs + 10 * 60_000),
    ],
    [undefined, undefined]
  );
  const stuckMessage = describeInverterStuckAlert(
    INVERTER_STUCK_IDLE_STATE,
    evaluateInverterStuckRules({
      nowMs,
      inverter: {},
      smoothedHallWatts: undefined,
      averageSOC: 76,
      sunElevationDegrees: -20,
      commandedChargingAmps: 0,
      acChargingEnabledOnInverter: false,
    }),
    nowMs,
    "P2",
    sentence
  ).message;
  check(
    "the stuck alert quotes the fault code and gives the same power-cycle procedure",
    [
      stuckMessage.includes("F14 Inverter DC current exceed permit range"),
      stuckMessage.includes("then switch on the battery, the PV and the utility"),
    ],
    [true, true]
  );
}

// ——— the real store: atomic writes (temp file + rename), a torn file is ignored loudly ———
{
  const scratchDirectory = mkdtempSync(path.join(tmpdir(), "inverter-fault-store-selftest-"));
  const statePath = path.join(scratchDirectory, "inverter_fault_state.json");
  useFaultAlertStatePathForTests(statePath);
  const latchPersisted = runAcrossRestarts([{ bootS: -60, untilS: 290, mode: "04" }]).persisted!;
  saveFaultAlertState({ ...latchPersisted, pending_new_fault: null });
  saveFaultAlertState(latchPersisted);
  await flushFaultAlertStateWrites();
  check(
    "the store round-trips the latest state, written through a temp file that is gone afterwards",
    [loadFaultAlertState(), existsSync(`${statePath}.tmp`)],
    [latchPersisted, false]
  );
  writeFileSync(statePath, '{"fault_mode": {"onset_ms": 1');
  check("a torn file starts without a state (and warns) instead of throwing", loadFaultAlertState(), undefined);
  rmSync(scratchDirectory, { recursive: true });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll inverter fault alert checks passed");

/**
 * The review's clock replay: the latch pages, the pi loses power for 3 min and boots on a clock that
 * reads `bootClockBehindMs` behind the last persisted reading; NTP steps it right `ntpAfterMs` after
 * the boot. Times are real; the policy only ever sees the pi's wall clock.
 */
function replayBootOnLaggingClock(bootClockBehindMs: number, ntpAfterMs: number) {
  const pages: (InverterFaultAlert & { afterBoot: boolean })[] = [];
  let state = INVERTER_FAULT_IDLE_STATE;
  let status: InverterOperatingStatus = {
    working_mode: {
      code: "05",
      text: WORKING_MODE_TEXT_BY_CODE["05"],
      since: LATCH_MS - 60_000,
      since_is_onset: false,
      time: LATCH_MS - 60_000,
    },
    latest_fault: {
      code: 14,
      text: describeInverterFaultCode(14),
      record_id: 0,
      since: LATCH_MS - 59_000,
      time: LATCH_MS,
    },
    warnings: undefined,
    fault_records: [],
  };
  for (let tickMs = LATCH_MS + 15_000; tickMs <= LATCH_MS + 290_000; tickMs += 15_000) {
    const latestReadingMs = LATCH_MS + 8_000 + Math.floor((tickMs - LATCH_MS - 8_000) / 60_000) * 60_000;
    status = {
      ...status,
      working_mode: {
        code: "04",
        text: "Fault mode",
        since: LATCH_MS + 8_000,
        since_is_onset: true,
        time: latestReadingMs,
      },
    };
    const step = stepInverterFaultAlerts(state, faultSnapshotAt(tickMs, status), DEFAULT_SETTINGS);
    state = step.state;
    pages.push(...step.alerts.map(alert => ({ ...alert, afterBoot: false })));
  }
  state = restoreFaultAlerts(JSON.parse(JSON.stringify(persistableFaultAlerts(state))));
  const bootRealMs = LATCH_MS + 290_000 + 3 * 60_000;
  // Before NTP the clock reads about the last save, itself behind: the downtime doesn't show either
  const offsetBeforeNtpMs = -bootClockBehindMs - 3 * 60_000;
  const firstReadingRealMs = bootRealMs + 2_000;
  const firstReadingWallMs = wallClockAt(firstReadingRealMs, bootRealMs, ntpAfterMs, offsetBeforeNtpMs);
  for (let tickRealMs = bootRealMs + 15_000; tickRealMs <= bootRealMs + 15 * 60_000; tickRealMs += 15_000) {
    const readingRealMs = firstReadingRealMs + Math.floor((tickRealMs - firstReadingRealMs) / 60_000) * 60_000;
    const readingWallMs = wallClockAt(readingRealMs, bootRealMs, ntpAfterMs, offsetBeforeNtpMs);
    status = {
      working_mode: {
        code: "04",
        text: "Fault mode",
        since: firstReadingWallMs,
        since_is_onset: false,
        time: readingWallMs,
      },
      latest_fault: {
        code: 14,
        text: describeInverterFaultCode(14),
        record_id: 0,
        since: firstReadingWallMs,
        time: readingWallMs,
      },
      warnings: undefined,
      fault_records: [],
    };
    const tickWallMs = wallClockAt(tickRealMs, bootRealMs, ntpAfterMs, offsetBeforeNtpMs);
    const step = stepInverterFaultAlerts(state, faultSnapshotAt(tickWallMs, status), DEFAULT_SETTINGS);
    state = step.state;
    pages.push(...step.alerts.map(alert => ({ ...alert, afterBoot: true })));
  }
  return pages;
}

function wallClockAt(realMs: number, bootRealMs: number, ntpAfterMs: number, offsetBeforeNtpMs: number): number {
  return realMs + (realMs - bootRealMs < ntpAfterMs ? offsetBeforeNtpMs : 0);
}

function faultSnapshotAt(nowMs: number, status: InverterOperatingStatus) {
  return { nowMs, status, gridVoltage: { value: 236, time: nowMs }, stuckP1Open: false };
}
