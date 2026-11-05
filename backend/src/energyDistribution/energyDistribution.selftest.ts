/**
 * Self-test of the energy-distribution enforcement: the profiles and their setters, the pure decisions, and
 * the live wiring (createEnergyDistributionEnforcement) with plain signals standing in for the inverter
 * session and the clock. No hardware. Run from backend/ with:
 *   yarn node src/energyDistribution/energyDistribution.selftest.ts
 */
import process from "process";
import { createRoot, createSignal } from "solid-js";
import { default_config, mergeWithDefaults } from "../config/config.ts";
import type { Config, EnergyDistributionProfile } from "../config/config.types.ts";
import type { DecodedFields, DecodedRound, MachineModelCode } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem } from "../inverterComms/inverterComms.types.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { expectedReadbackChecksForSetter } from "../inverterComms/setterConfirmation.ts";
import {
  DEFAULT_NORMAL_HYBRID_PROFILE,
  DEFAULT_OFF_GRID_III_PROFILE,
  effectiveEnergyDistributionProfile,
  energyDistributionDivergences,
  setterForDivergence,
} from "./energyDistributionProfile.ts";
import { effectiveEnergyDistributionSettings } from "./energyDistributionSettings.ts";
import {
  CHANGE_TRIGGERED_RETRIES_PER_EPISODE,
  type DivergenceEpisode,
  ENFORCEMENT_FALLBACK_RETRY_MS,
  type EnforcementSituation,
  type EnforcementTiming,
  nextEnforcementStep,
  profileInForce,
} from "./energyDistributionEnforcementDecisions.ts";
import { createEnergyDistributionEnforcement } from "./useEnergyDistributionEnforcement.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

/** HECS as the live inverter read it before the DM050 of 2026-11-05 */
const LIVE_HECS: DecodedFields = {
  solar_energy_distribution_priority: "Load-Battery-Grid",
  solar_charge_battery: "enabled",
  ac_charge_battery: "disabled",
  feed_power_to_utility: "enabled",
  battery_discharge_to_loads_when_solar_input_normal: "enabled",
  battery_discharge_to_loads_when_solar_input_loss: "enabled",
  battery_discharge_to_feed_grid_when_solar_input_normal: "enabled",
  battery_discharge_to_feed_grid_when_solar_input_loss: "enabled",
};
/** …and once DM050 had applied: the factory defaults */
const RESET_HECS: DecodedFields = {
  ...LIVE_HECS,
  solar_energy_distribution_priority: "Battery-Load-Grid",
  ac_charge_battery: "enabled",
  battery_discharge_to_loads_when_solar_input_normal: "disabled",
  battery_discharge_to_loads_when_solar_input_loss: "disabled",
  battery_discharge_to_feed_grid_when_solar_input_normal: "disabled",
  battery_discharge_to_feed_grid_when_solar_input_loss: "disabled",
};
const RESTORED_COMMANDS = "SEP01,EDD1,EDE1";

// ---------- the profiles and their setters ----------
{
  check(
    "normal_hybrid defaults to the live profile of 2026-11-05",
    energyDistributionDivergences(DEFAULT_NORMAL_HYBRID_PROFILE, LIVE_HECS).length === 0
  );
  check(
    "off_grid_iii defaults to all unmanaged: nothing differs, whatever HECS reads",
    Object.values(DEFAULT_OFF_GRID_III_PROFILE).every(value => value === "unmanaged") &&
      energyDistributionDivergences(DEFAULT_OFF_GRID_III_PROFILE, RESET_HECS).length === 0
  );
  const divergences = energyDistributionDivergences(DEFAULT_NORMAL_HYBRID_PROFILE, RESET_HECS);
  check(
    "after the reset: SEP01, EDD1, EDE1 in write order; EDB/EDF/EDG aren't the enforcement's",
    divergences.map(divergence => setterForDivergence(divergence).command).join(",") === RESTORED_COMMANDS,
    JSON.stringify(divergences)
  );
  check(
    "each setter replaces only its own parameter",
    divergences.map(divergence => setterForDivergence(divergence).replacesPrefix).join(",") === "SEP,EDD,EDE"
  );
  const partlyManaged: EnergyDistributionProfile = {
    ...DEFAULT_NORMAL_HYBRID_PROFILE,
    solar_energy_distribution_priority: "unmanaged",
    solar_charge_battery: "disabled",
  };
  check(
    "an unmanaged field is never a divergence; a managed one is, with its setter (EDA0)",
    energyDistributionDivergences(partlyManaged, RESET_HECS)
      .map(divergence => setterForDivergence(divergence).command)
      .join(",") === "EDD1,EDE1,EDA0"
  );
  check(
    "SEPnn and EDA/EDC/EDD/EDE are confirmed by their HECS fields",
    ["SEP00", "SEP02", "EDA1", "EDC0", "EDD1", "EDE0"]
      .map(command => expectedReadbackChecksForSetter(command)[0])
      .map(readbackCheck => `${readbackCheck?.field}=${readbackCheck?.expectedValue}`)
      .join(",") ===
      "solar_energy_distribution_priority=Battery-Load-Grid,solar_energy_distribution_priority=Load-Grid-Battery,solar_charge_battery=enabled,feed_power_to_utility=disabled,battery_discharge_to_loads_when_solar_input_normal=enabled,battery_discharge_to_loads_when_solar_input_loss=disabled"
  );
  check("SEP03 has no readback (not a priority)", expectedReadbackChecksForSetter("SEP03").length === 0);
  const corrected = effectiveEnergyDistributionProfile(
    {
      solar_energy_distribution_priority: "Grid-First",
      solar_charge_battery: true,
      feed_power_to_utility: "unmanaged",
    },
    DEFAULT_NORMAL_HYBRID_PROFILE,
    "inverter_energy_distribution.normal_hybrid"
  );
  check(
    "a hand-edited profile is corrected field by field; unmanaged is a valid value",
    corrected.profile.solar_energy_distribution_priority === "Load-Battery-Grid" &&
      corrected.profile.solar_charge_battery === "enabled" &&
      corrected.profile.feed_power_to_utility === "unmanaged" &&
      corrected.corrections.length === 4,
    corrected.corrections.join(" | ")
  );
  const settings = effectiveEnergyDistributionSettings({ normal_hybrid: "on", p2_after_minutes: 0.5 });
  check(
    "a profile that isn't an object takes the defaults; p2_after_minutes is clamped",
    settings.settings.normal_hybrid.solar_energy_distribution_priority === "Load-Battery-Grid" &&
      settings.settings.p2_after_minutes === 2 &&
      settings.corrections.length === 3,
    settings.corrections.join(" | ")
  );
  check(
    "the defaults pass uncorrected",
    effectiveEnergyDistributionSettings(default_config.inverter_energy_distribution).corrections.length === 0
  );
  const merged = mergeWithDefaults({
    inverter_energy_distribution: { normal_hybrid: { solar_charge_battery: "unmanaged" } },
  } as unknown as Partial<Config>);
  check(
    "a partial profile in config.json merges key by key",
    merged.inverter_energy_distribution.normal_hybrid.solar_charge_battery === "unmanaged" &&
      merged.inverter_energy_distribution.normal_hybrid.solar_energy_distribution_priority === "Load-Battery-Grid" &&
      merged.inverter_energy_distribution.off_grid_iii.feed_power_to_utility === "unmanaged" &&
      merged.inverter_energy_distribution.p2_after_minutes === 10
  );
  check(
    "a config.json from before the section gets it whole",
    JSON.stringify(mergeWithDefaults({} as Partial<Config>).inverter_energy_distribution) ===
      JSON.stringify(default_config.inverter_energy_distribution)
  );
}

// ---------- the pure decisions ----------
/** Steps the decisions as the wiring does: what a step sends is recorded as queued, for the session's gate */
type PureRun = { episode: DivergenceEpisode | undefined; lastQueuedAtByCommand: Record<string, number> };

function pureStep(run: PureRun, situation: EnforcementSituation, timing: EnforcementTiming) {
  const step = nextEnforcementStep(
    run.episode,
    { ...situation, lastQueuedAtByCommand: run.lastQueuedAtByCommand },
    timing
  );
  run.episode = step.episode;
  const commands = (step.send ?? []).map(divergence => setterForDivergence(divergence).command);
  for (const command of commands) run.lastQueuedAtByCommand[command] = situation.nowMs;
  return { step, commands };
}

{
  const START_MS = 1_000_000_000;
  const timing: EnforcementTiming = { p2AfterMs: 600_000, fallbackRetryMs: ENFORCEMENT_FALLBACK_RETRY_MS };
  const profiles = default_config.inverter_energy_distribution;
  const situationAt = (nowMs: number, overrides: Partial<EnforcementSituation> = {}): EnforcementSituation => ({
    nowMs,
    machineModel: { model: "050", atMs: nowMs - 1_000 },
    workingModeCode: "05",
    machineModelSwitchPending: false,
    hecs: { fields: RESET_HECS, decodedAtMs: nowMs - 500 },
    settingsReadbackMaxAgeMs: 660_000,
    profiles,
    lastQueuedAtByCommand: {},
    ...overrides,
  });
  const hecsAt = (nowMs: number, fields: DecodedFields) => ({ hecs: { fields, decodedAtMs: nowMs } });
  check(
    "no DM readback: no profile",
    "noProfileReason" in profileInForce(situationAt(START_MS, { machineModel: undefined }))
  );
  check(
    "a stale DM readback: no profile",
    "noProfileReason" in
      profileInForce(situationAt(START_MS, { machineModel: { model: "050", atMs: START_MS - 700_000 } }))
  );
  check(
    "an unexpected model: no profile",
    "noProfileReason" in profileInForce(situationAt(START_MS, { machineModel: { model: "061", atMs: START_MS } }))
  );
  const offGrid = profileInForce(situationAt(START_MS, { machineModel: { model: "151", atMs: START_MS } }));
  check("151 puts off_grid_iii in force", "profileName" in offGrid && offGrid.profileName === "off_grid_iii");

  const matching = nextEnforcementStep(undefined, situationAt(START_MS, hecsAt(START_MS, LIVE_HECS)), timing);
  check(
    "a matching readback writes nothing and opens nothing",
    !matching.send && !matching.episode && !matching.started
  );
  check(
    "no DM readback: nothing written though HECS differs",
    !nextEnforcementStep(undefined, situationAt(START_MS, { machineModel: undefined }), timing).send
  );
  check(
    "a DM switch pending (the HECS beside its confirm shows the reset first): nothing written",
    !nextEnforcementStep(undefined, situationAt(START_MS, { machineModelSwitchPending: true }), timing).send
  );
  check(
    "a stale HECS readback: nothing written",
    !nextEnforcementStep(undefined, situationAt(START_MS, hecsAt(START_MS - 700_000, RESET_HECS)), timing).send
  );
  const { solar_energy_distribution_priority: _missingPriority, ...withoutPriority } = RESET_HECS;
  const unread = nextEnforcementStep(undefined, situationAt(START_MS, hecsAt(START_MS, withoutPriority)), timing);
  check(
    "a readback lacking a managed field can't be judged: nothing written (no SEP on a guess)",
    !unread.send && !unread.judged
  );
  const openEpisode = nextEnforcementStep(undefined, situationAt(START_MS), timing).episode;
  const unreadWhileOpen = nextEnforcementStep(
    openEpisode,
    situationAt(START_MS + 60_000, hecsAt(START_MS + 60_000, withoutPriority)),
    timing
  );
  check(
    "…an open episode stays open, saying why",
    unreadWhileOpen.episode !== undefined && unreadWhileOpen.waitingReason?.includes("lacks Solar priority") === true,
    unreadWhileOpen.waitingReason
  );
  check(
    "an out-of-domain value is a real difference and is written back",
    nextEnforcementStep(
      undefined,
      situationAt(START_MS, hecsAt(START_MS, { ...LIVE_HECS, solar_energy_distribution_priority: "Unknown key: 03" })),
      timing
    ).send?.[0]?.field === "solar_energy_distribution_priority"
  );
  const first = nextEnforcementStep(undefined, situationAt(START_MS), timing);
  check(
    "a differing readback is written at once, no settle delay",
    first.started &&
      first.send?.map(divergence => setterForDivergence(divergence).command).join(",") === RESTORED_COMMANDS
  );

  // A firmware that refuses everything, the readback never changing: the fallback alone retries
  {
    const run: PureRun = { episode: undefined, lastQueuedAtByCommand: {} };
    const sendTimesMs: number[] = [];
    let p2Count = 0;
    for (let nowMs = START_MS; nowMs <= START_MS + 3_600_000; nowMs += 10_000) {
      const { step } = pureStep(run, situationAt(nowMs), timing);
      if (step.send) sendTimesMs.push(nowMs - START_MS);
      if (step.raiseP2) p2Count++;
    }
    check(
      "a steady persistent NAK writes at most once per fallback interval (10 min)",
      sendTimesMs.length === 7 &&
        sendTimesMs.every((sentAt, index) => sentAt === index * ENFORCEMENT_FALLBACK_RETRY_MS),
      sendTimesMs.join(",")
    );
    check("…and pages exactly once (P2 after p2_after_minutes)", p2Count === 1);
  }

  // What re-arms an attempt (past the session's gate, so only the trigger is judged)
  const afterNak = nextEnforcementStep(undefined, situationAt(START_MS), timing).episode;
  const later = START_MS + 90_000;
  check(
    "after a NAK, the same readback doesn't retry",
    !nextEnforcementStep(afterNak, situationAt(later), timing).send
  );
  check(
    "…a working mode change does",
    nextEnforcementStep(afterNak, situationAt(later, { workingModeCode: "03" }), timing).send !== undefined
  );
  check(
    "…so does an enforced HECS field changing (EDA, even though it's right)",
    nextEnforcementStep(
      afterNak,
      situationAt(later, hecsAt(later, { ...RESET_HECS, solar_charge_battery: "disabled" })),
      timing
    ).send !== undefined
  );
  check(
    "…but not buying's or feeding's fields moving (EDB, EDG): SEP's own side effects can't re-arm SEP",
    !nextEnforcementStep(
      afterNak,
      situationAt(
        later,
        hecsAt(later, {
          ...RESET_HECS,
          ac_charge_battery: "disabled",
          battery_discharge_to_feed_grid_when_solar_input_loss: "enabled",
        })
      ),
      timing
    ).send
  );
  check(
    "…and a profile change (config) does",
    nextEnforcementStep(
      afterNak,
      situationAt(later, {
        profiles: {
          ...profiles,
          normal_hybrid: { ...profiles.normal_hybrid, solar_energy_distribution_priority: "Load-Grid-Battery" },
        },
      }),
      timing
    ).send?.[0]?.desired === "Load-Grid-Battery"
  );
  const landed = nextEnforcementStep(afterNak, situationAt(later, hecsAt(later, LIVE_HECS)), timing);
  check("a matching readback ends the episode", landed.landed !== undefined && landed.episode === undefined);
  const blind = nextEnforcementStep(
    { ...afterNak!, onsetMs: START_MS - 700_000 },
    situationAt(START_MS, { machineModel: undefined }),
    timing
  );
  check(
    "an episode that can't be judged any more still pages once overdue, and writes nothing",
    blind.raiseP2 && !blind.send && blind.waitingReason?.includes("DM") === true
  );

  // Review #1: a re-arm inside the session's gate, then a hold. Nothing may sit gated in the queue and reach
  // the wire after the enforcement decided to hold (SEP01 into a 151 transition resets EDB/EDC/EDG)
  {
    const run: PureRun = { episode: undefined, lastQueuedAtByCommand: {} };
    const t0 = pureStep(run, situationAt(START_MS), timing);
    check("t=0: SEP01, EDD1, EDE1 (SEP01 NAKed)", t0.commands.join(",") === RESTORED_COMMANDS);
    const eddLanded = { ...RESET_HECS, battery_discharge_to_loads_when_solar_input_normal: "enabled" };
    const t10 = pureStep(run, situationAt(START_MS + 10_000, hecsAt(START_MS + 10_000, eddLanded)), timing);
    check(
      "t=10 s: EDD1 landed re-arms, but SEP01/EDE1 went out 10 s ago: nothing queued for the gate to hold",
      t10.commands.length === 0 && run.episode?.deferredCommands.join(",") === "SEP01,EDE1",
      t10.step.waitingReason
    );
    const queuedAfterHold: string[] = [];
    for (let nowMs = START_MS + 30_000; nowMs <= START_MS + 300_000; nowMs += 10_000) {
      const held = pureStep(
        run,
        situationAt(nowMs, { ...hecsAt(nowMs, eddLanded), machineModelSwitchPending: true }),
        timing
      );
      queuedAfterHold.push(...held.commands);
    }
    check("t=30 s on, DM151 pending: nothing reaches the queue, gate open or not", queuedAfterHold.length === 0);
    const in151 = pureStep(
      run,
      situationAt(START_MS + 310_000, {
        ...hecsAt(START_MS + 310_000, RESET_HECS),
        machineModel: { model: "151", atMs: START_MS + 310_000 },
      }),
      timing
    );
    check(
      "…and in 151 (all unmanaged) the episode ends without a write",
      in151.commands.length === 0 && run.episode === undefined
    );
  }

  // …and a field made unmanaged inside the gate's window is never written
  {
    const run: PureRun = { episode: undefined, lastQueuedAtByCommand: {} };
    pureStep(run, situationAt(START_MS), timing);
    const eddLanded = { ...RESET_HECS, battery_discharge_to_loads_when_solar_input_normal: "enabled" };
    pureStep(run, situationAt(START_MS + 10_000, hecsAt(START_MS + 10_000, eddLanded)), timing);
    const priorityUnmanaged = {
      ...profiles,
      normal_hybrid: { ...profiles.normal_hybrid, solar_energy_distribution_priority: "unmanaged" as const },
    };
    const queued: string[] = [];
    for (let nowMs = START_MS + 20_000; nowMs <= START_MS + 200_000; nowMs += 10_000) {
      queued.push(
        ...pureStep(run, situationAt(nowMs, { ...hecsAt(nowMs, eddLanded), profiles: priorityUnmanaged }), timing)
          .commands
      );
    }
    check(
      "SEP made unmanaged within the window: never written again; the still-differing EDE1 goes out once the gate is open",
      !queued.includes("SEP01") && queued.join(",") === "EDE1",
      queued.join(",")
    );
  }

  // Review #2: the firmware ACKs SEP01 and applies its side effects (EDB on, EDC/EDG off) but not the
  // priority; EDC1 lands, buying and feeding put EDB/EDG back. The change-triggered rounds stay bounded.
  {
    const run: PureRun = { episode: undefined, lastQueuedAtByCommand: {} };
    let hecsFields: DecodedFields = { ...LIVE_HECS, solar_energy_distribution_priority: "Battery-Load-Grid" };
    const sepSendTimesMs: number[] = [];
    const pendingEffects: { atMs: number; apply: (fields: DecodedFields) => DecodedFields }[] = [];
    for (let nowMs = START_MS; nowMs <= START_MS + 3_600_000; nowMs += 5_000) {
      for (const effect of pendingEffects.filter(candidate => candidate.atMs <= nowMs))
        hecsFields = effect.apply(hecsFields);
      pendingEffects.splice(0, pendingEffects.length, ...pendingEffects.filter(candidate => candidate.atMs > nowMs));
      const { commands } = pureStep(run, situationAt(nowMs, hecsAt(nowMs, hecsFields)), timing);
      for (const command of commands) {
        if (command === "SEP01") {
          sepSendTimesMs.push(nowMs - START_MS);
          pendingEffects.push({
            atMs: nowMs + 10_000,
            apply: fields => ({
              ...fields,
              ac_charge_battery: "enabled",
              feed_power_to_utility: "disabled",
              battery_discharge_to_feed_grid_when_solar_input_loss: "disabled",
            }),
          });
          // Buying's EDB0 and feeding's EDG1, a little later
          pendingEffects.push({
            atMs: nowMs + 25_000,
            apply: fields => ({
              ...fields,
              ac_charge_battery: "disabled",
              battery_discharge_to_feed_grid_when_solar_input_loss: "enabled",
            }),
          });
        }
        if (command === "EDC1")
          pendingEffects.push({
            atMs: nowMs + 10_000,
            apply: fields => ({ ...fields, feed_power_to_utility: "enabled" }),
          });
      }
    }
    const lateGapsMs = sepSendTimesMs
      .slice(1)
      .map((sentAt, index) => sentAt - sepSendTimesMs[index]!)
      .slice(3);
    check(
      `SEP's side effects re-arm at most ${CHANGE_TRIGGERED_RETRIES_PER_EPISODE} times: then SEP01 only every fallback (10 min)`,
      sepSendTimesMs.length <= 3 + 6 && lateGapsMs.every(gapMs => gapMs >= ENFORCEMENT_FALLBACK_RETRY_MS),
      `SEP01 at ${sepSendTimesMs.map(sentAt => `${sentAt / 1000}s`).join(", ")}`
    );
    check(
      "…and the episode says the fallback is all that's left",
      run.episode?.changeTriggeredRetries === CHANGE_TRIGGERED_RETRIES_PER_EPISODE
    );
  }
}

// ---------- the live wiring ----------
const WIRING_START_MS = Date.parse("2026-11-05T12:00:00Z");

type Harness = ReturnType<typeof startHarness>;

function startHarness() {
  const clock = { nowMs: WIRING_START_MS };
  const [config, setConfig] = createSignal<Config>(default_config);
  const [lastDecodedRound, setLastDecodedRound] = createSignal<DecodedRound | undefined>(undefined);
  const [workingModeCode, setWorkingModeCode] = createSignal<string | undefined>("05");
  const [requestedMachineModel, setRequestedMachineModel] = createSignal<MachineModelCode>("050");
  const queued: SetterQueueItem[] = [];
  const readbackRequests: string[] = [];
  const raised: Parameters<AlertManager["raise"]>[0][] = [];
  const raise: AlertManager["raise"] = async alert => {
    raised.push(alert);
    return { ...alert, at: new Date(clock.nowMs).toISOString(), delivery: "dry_run" };
  };
  let enforcement: ReturnType<typeof createEnergyDistributionEnforcement> | undefined;
  const dispose = createRoot(disposeRoot => {
    enforcement = createEnergyDistributionEnforcement({
      config,
      queueSetter: item => queued.push(item),
      requestSettingsReadback: query => readbackRequests.push(query),
      lastDecodedRound,
      workingModeCode,
      requestedMachineModel,
      raise,
      wallClockNowMs: () => clock.nowMs,
      timingOverrides: undefined,
    });
    return disposeRoot;
  });
  if (!enforcement) throw new Error("createEnergyDistributionEnforcement returned nothing");
  const readDm = (model: string) =>
    setLastDecodedRound({ command: "DM", wireCommand: "DM", fields: { machine_model: model }, decodedAt: clock.nowMs });
  const readHecs = (fields: DecodedFields) =>
    setLastDecodedRound({ command: "HECS", wireCommand: "HECS", fields: { ...fields }, decodedAt: clock.nowMs });
  /** A settings round as the session reads it: HECS, then DM */
  const settingsRound = (fields: DecodedFields, model: string) => {
    readHecs(fields);
    readDm(model);
  };
  return {
    clock,
    config,
    setConfig,
    setWorkingModeCode,
    setRequestedMachineModel,
    queued,
    readbackRequests,
    raised,
    settingsRound,
    readHecs,
    readDm,
    enforcement,
    dispose,
  };
}

function advance(harness: Harness, milliseconds: number): void {
  harness.clock.nowMs += milliseconds;
}

function commands(harness: Harness, fromIndex = 0): string {
  return harness.queued
    .slice(fromIndex)
    .map(item => item.command)
    .join(",");
}

function withNormalHybrid(harness: Harness, changes: Partial<EnergyDistributionProfile>): void {
  const current = harness.config();
  harness.setConfig({
    ...current,
    inverter_energy_distribution: {
      ...current.inverter_energy_distribution,
      normal_hybrid: { ...current.inverter_energy_distribution.normal_hybrid, ...changes },
    },
  });
}

// Identity: a matching inverter is never written, startup included
{
  const harness = startHarness();
  for (let minute = 0; minute < 60; minute++) {
    if (minute % 5 === 0) harness.settingsRound(LIVE_HECS, "050");
    advance(harness, 60_000);
  }
  check(
    "an hour of matching readbacks: nothing queued, nothing asked for",
    harness.queued.length === 0 && harness.readbackRequests.length === 0
  );
  const status = harness.enforcement.status();
  check(
    "status: normal_hybrid in force, every field desired = inverter, no divergence",
    status.profile_name === "normal_hybrid" &&
      status.fields.every(field => field.desired === field.inverter) &&
      status.divergence === undefined
  );
  harness.dispose();
}

// Startup on a reset inverter, unknown DM first; then a DM switch round trip
{
  const harness = startHarness();
  harness.readHecs(RESET_HECS);
  check("HECS before any DM readback: nothing written", harness.queued.length === 0);
  harness.settingsRound(RESET_HECS, "050");
  check(
    "startup applies too: the first DM readback writes SEP01, EDD1, EDE1 at once",
    commands(harness) === RESTORED_COMMANDS
  );
  check(
    "…each with a HECS refresh and its own prefix",
    harness.queued.every(item => item.refreshAfterSend.join(",") === "HECS") &&
      harness.queued.map(item => item.replacesPrefix).join(",") === "SEP,EDD,EDE"
  );
  check("the first DM readback asks for no extra readback", harness.readbackRequests.length === 0);
  for (const item of harness.queued) item.onResult?.({ acknowledged: true });
  advance(harness, 10_000);
  harness.readHecs(LIVE_HECS);
  check("the readback matches: the episode ends", harness.enforcement.status().divergence === undefined);

  // To 151: the confirm reads the reset HECS while DM still reads 050, then 151; off_grid_iii is all
  // unmanaged, so the reset HECS there is left alone
  const sentBefore = harness.queued.length;
  advance(harness, 60_000);
  harness.setRequestedMachineModel("151");
  harness.readHecs(RESET_HECS);
  check(
    "a HECS showing the reset before the DM readback does, while DM151 is pending: nothing written",
    harness.queued.length === sentBefore
  );
  harness.readDm("151");
  check(
    "a DM change asks for a fresh HECS (the one beside it can predate the reset)",
    harness.readbackRequests.join(",") === "HECS"
  );
  harness.setWorkingModeCode("03");
  advance(harness, 5_000);
  harness.readHecs(RESET_HECS);
  for (let step = 0; step < 60; step++) {
    advance(harness, 10_000);
    harness.readHecs(RESET_HECS);
  }
  check("in 151 with everything unmanaged nothing is written", harness.queued.length === sentBefore);
  check(
    "…and the status says off_grid_iii, nothing differing",
    harness.enforcement.status().profile_name === "off_grid_iii" && !harness.enforcement.status().divergence
  );

  // Back to 050: the confirm's HECS still shows the 151 values, then the reset is read
  advance(harness, 60_000);
  harness.setRequestedMachineModel("050");
  harness.settingsRound(RESET_HECS, "050");
  check("back on 050 the difference is written at once", commands(harness, sentBefore) === RESTORED_COMMANDS);
  harness.dispose();
}

// A NAK: retried on a change, not on every readback; one P2; a P3 when it lands
{
  const harness = startHarness();
  harness.settingsRound(RESET_HECS, "050");
  for (const item of harness.queued) item.onResult?.({ acknowledged: false });
  let sent = harness.queued.length;
  for (let step = 0; step < 30; step++) {
    advance(harness, 10_000);
    harness.readHecs(RESET_HECS);
  }
  check("NAKed, the readback unchanged for 5 min: no retry (not one a minute)", harness.queued.length === sent);
  harness.setWorkingModeCode("03");
  check("the working mode changing retries at once", commands(harness, sent) === RESTORED_COMMANDS);
  sent = harness.queued.length;
  advance(harness, 10_000);
  harness.readHecs({ ...RESET_HECS, battery_discharge_to_loads_when_solar_input_normal: "enabled" });
  check(
    "a HECS field changing (EDD landed) re-arms, but SEP01/EDE1 went out 10 s ago: deferred, not queued for the gate",
    commands(harness, sent) === "" &&
      harness.enforcement.status().waiting_reason?.includes("identical-setter gate") === true,
    harness.enforcement.status().waiting_reason
  );
  for (let step = 0; step < 60; step++) {
    advance(harness, 10_000);
    // Settings rounds every 10 s here: the DM readback must stay fresh, or nothing is judged at all
    harness.settingsRound({ ...RESET_HECS, battery_discharge_to_loads_when_solar_input_normal: "enabled" }, "050");
  }
  const p2s = harness.raised.filter(alert => alert.severity === "P2");
  check(
    "10 min of it: exactly one P2, on its own key",
    p2s.length === 1 && p2s[0]?.key.startsWith("energy-distribution-divergence:") === true
  );
  check(
    "…they go out once the gate is open, and not again before the 10 min fallback",
    commands(harness, sent) === "SEP01,EDE1",
    commands(harness, sent)
  );
  harness.settingsRound(LIVE_HECS, "050");
  check("landing sends one P3", harness.raised.filter(alert => alert.severity === "P3").length === 1);
  harness.dispose();
}

// SEP01's own reset (live, 2026-11-05: EDB on, EDC off, EDG off): re-diffed, only EDC is ours, SEP isn't rewritten
{
  const harness = startHarness();
  harness.settingsRound(RESET_HECS, "050");
  for (const item of harness.queued) item.onResult?.({ acknowledged: true });
  const sent = harness.queued.length;
  advance(harness, 10_000);
  const afterSepReset: DecodedFields = {
    ...LIVE_HECS,
    ac_charge_battery: "enabled",
    feed_power_to_utility: "disabled",
    battery_discharge_to_feed_grid_when_solar_input_normal: "disabled",
    battery_discharge_to_feed_grid_when_solar_input_loss: "disabled",
  };
  harness.readHecs(afterSepReset);
  check(
    "SEP01's reset of EDC is re-diffed: EDC1 alone goes out",
    commands(harness, sent) === "EDC1",
    commands(harness, sent)
  );
  harness.queued.at(-1)?.onResult?.({ acknowledged: true });
  advance(harness, 10_000);
  // Buying's EDB0 and feeding's EDF1/EDG1 land in their own time: HECS changes, nothing of ours differs
  harness.readHecs({ ...LIVE_HECS, ac_charge_battery: "enabled" });
  advance(harness, 10_000);
  harness.readHecs(LIVE_HECS);
  check(
    "…and it converges: nothing more written, the episode over",
    commands(harness, sent) === "EDC1" && !harness.enforcement.status().divergence
  );
  harness.dispose();
}

// Config is the source of truth: an edit propagates at once, unmanaged is left alone; a display change is reverted
{
  const harness = startHarness();
  harness.settingsRound(LIVE_HECS, "050");
  withNormalHybrid(harness, { solar_charge_battery: "disabled" });
  check("a config edit propagates at once (EDA0)", commands(harness) === "EDA0");
  harness.queued.at(-1)?.onResult?.({ acknowledged: true });
  advance(harness, 10_000);
  harness.readHecs({ ...LIVE_HECS, solar_charge_battery: "disabled" });
  check("…and ends once read back", harness.enforcement.status().divergence === undefined);
  const sent = harness.queued.length;
  withNormalHybrid(harness, { feed_power_to_utility: "unmanaged" });
  advance(harness, 60_000);
  harness.readHecs({ ...LIVE_HECS, solar_charge_battery: "disabled", feed_power_to_utility: "disabled" });
  check("an unmanaged field changed on the display is never written", harness.queued.length === sent);
  advance(harness, 60_000);
  harness.readHecs({
    ...LIVE_HECS,
    solar_charge_battery: "disabled",
    feed_power_to_utility: "disabled",
    battery_discharge_to_loads_when_solar_input_loss: "disabled",
  });
  check("a managed field changed on the display is reverted (EDE1)", commands(harness, sent) === "EDE1");
  harness.dispose();
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all energyDistribution selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
