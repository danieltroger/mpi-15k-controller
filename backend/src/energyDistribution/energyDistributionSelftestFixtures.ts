/**
 * Shared by the energy-distribution selftests: HECS as the live inverter read it on 2026-11-05, and the pure
 * decisions stepped the way the wiring steps them, against an emulated session's identical-setter gate.
 */
import { default_config } from "../config/config.ts";
import type { DecodedFields } from "../inverterComms/pi17Protocol.types.ts";
import { IDENTICAL_SETTER_MIN_INTERVAL_MS } from "../inverterComms/schedulerTiming.ts";
import { setterForDivergence } from "./energyDistributionProfile.ts";
import {
  type DivergenceEpisode,
  ENFORCEMENT_FALLBACK_RETRY_MS,
  type EnforcementSituation,
  type EnforcementStep,
  type EnforcementTiming,
  nextEnforcementStep,
} from "./energyDistributionEnforcementDecisions.ts";

/** HECS as the live inverter read it before the DM050 of 2026-11-05 */
export const LIVE_HECS: DecodedFields = {
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
export const RESET_HECS: DecodedFields = {
  ...LIVE_HECS,
  solar_energy_distribution_priority: "Battery-Load-Grid",
  ac_charge_battery: "enabled",
  battery_discharge_to_loads_when_solar_input_normal: "disabled",
  battery_discharge_to_loads_when_solar_input_loss: "disabled",
  battery_discharge_to_feed_grid_when_solar_input_normal: "disabled",
  battery_discharge_to_feed_grid_when_solar_input_loss: "disabled",
};
export const RESTORED_COMMANDS = "SEP01,EDD1,EDE1";

/** The pure runs' wall clock starts here… */
export const PURE_START_MS = 1_000_000_000;
/** …and the session's monotonic clock here: a decision that mixed the two up would show */
export const MONOTONIC_START_MS = 5_000;
export const PURE_TIMING: EnforcementTiming = { p2AfterMs: 600_000, fallbackRetryMs: ENFORCEMENT_FALLBACK_RETRY_MS };

/**
 * An episode, and the emulated session: what a step sends goes out at once, and the session's
 * identical-setter gate then holds that command for IDENTICAL_SETTER_MIN_INTERVAL_MS (monotonic)
 */
export type PureRun = {
  episode: DivergenceEpisode | undefined;
  gateOpensAtByCommand: Record<string, number>;
  /** Setters a step sent while the emulated gate still held them: must stay empty */
  queuedWhileGated: string[];
};

export function newPureRun(): PureRun {
  return { episode: undefined, gateOpensAtByCommand: {}, queuedWhileGated: [] };
}

/** One step as the wiring takes it, the session's gate answering from the run */
export function pureStep(
  run: PureRun,
  situation: EnforcementSituation,
  timing: EnforcementTiming = PURE_TIMING
): { step: EnforcementStep; commands: string[] } {
  const step = nextEnforcementStep(
    run.episode,
    { ...situation, identicalSetterGateOpensAtMs: command => run.gateOpensAtByCommand[command] },
    timing
  );
  run.episode = step.episode;
  const commands = (step.send ?? []).map(divergence => setterForDivergence(divergence).command);
  for (const command of commands) {
    const gateOpensAtMs = run.gateOpensAtByCommand[command];
    if (gateOpensAtMs !== undefined && situation.monotonicNowMs < gateOpensAtMs) run.queuedWhileGated.push(command);
    run.gateOpensAtByCommand[command] = situation.monotonicNowMs + IDENTICAL_SETTER_MIN_INTERVAL_MS;
  }
  return { step, commands };
}

/**
 * The reset inverter on 050, read just now, at wall-clock `nowMs`; the monotonic clock has run as long since
 * PURE_START_MS. Nothing is gated unless a run (pureStep) or the overrides say so.
 */
export function situationAt(nowMs: number, overrides: Partial<EnforcementSituation> = {}): EnforcementSituation {
  return {
    nowMs,
    monotonicNowMs: MONOTONIC_START_MS + (nowMs - PURE_START_MS),
    machineModel: { model: "050", atMs: nowMs - 1_000 },
    workingModeCode: "05",
    machineModelSwitchPending: false,
    hecs: { fields: RESET_HECS, decodedAtMs: nowMs - 500 },
    settingsReadbackMaxAgeMs: 660_000,
    profiles: default_config.inverter_energy_distribution,
    identicalSetterGateOpensAtMs: () => undefined,
    ...overrides,
  };
}

export function hecsAt(nowMs: number, fields: DecodedFields): Pick<EnforcementSituation, "hecs"> {
  return { hecs: { fields, decodedAtMs: nowMs } };
}
