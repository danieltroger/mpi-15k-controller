import { type Accessor, createEffect, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import {
  effectiveResumeBelowCelsius,
  type OverheatSellStopLimits,
  type OverheatSellStopSignals,
} from "../feeding/overheatSellStop.ts";
import { warnLog } from "../utilities/logging.ts";
import type { AlertManager } from "./alertManager.ts";
import { round1 } from "./alertingLogic.ts";
import { loadOverheatEpisode, saveOverheatEpisode } from "./overheatEpisodeStore.ts";

/**
 * The inverter-temperature P1 rides the overheat sell stop's edges instead of keeping a threshold
 * of its own: one limit, one hysteresis, and stale readings hold both alike.
 *
 * Episode keys: the stop makes a sawtooth inside one long window (stop at 97 °C, cool below 90 °C,
 * 14 kW again, stop again), and a cycle can be shorter than cooldown_minutes. So a stop that follows
 * a resume is a new episode keyed by its own onset, and the previous episode's cooldown can't
 * swallow it. "Follows a resume" survives restarts: every edge is persisted (overheatEpisodeStore),
 * so a restart between the resume and the re-stop still pages the P1 the resume notice promised.
 * A stop already in force across a restart or main() crash loop continues the persisted episode,
 * under that episode's key, and its persisted cooldown keeps the loop from re-paging (the plain
 * "inverter-temp" key while nothing has resumed yet). Keys with onsets age out of alert_state.json
 * like any other key (expiredCooldownKeys).
 */
export function startOverheatSellStopAlerts(ctx: {
  config: Accessor<Config>;
  manager: AlertManager;
  overheatSellStop: OverheatSellStopSignals;
}) {
  // Seeded with "not stopped", not with the first state: a stop that is already in force when
  // alerting starts must still page (under the persisted episode key, so a loop can't re-page).
  createEffect<OverheatAlertMemory>(memory => {
    const { sellingStopped, flipReading } = ctx.overheatSellStop.state();
    if (!flipReading || sellingStopped === memory.stopped) return memory;
    const limits = untrack(ctx.config).scheduled_power_selling;
    const nextMemory: OverheatAlertMemory = sellingStopped
      ? {
          stopped: true,
          lastEdgeWasResume: false,
          episodeKey: memory.lastEdgeWasResume ? `${OVERHEAT_ALERT_KEY}:${flipReading.time}` : memory.episodeKey,
        }
      : { stopped: false, lastEdgeWasResume: true, episodeKey: memory.episodeKey };
    // Before raising: a push can sit in a 15 s Pushover timeout, and a restart meanwhile must still
    // know this edge happened
    saveOverheatEpisode({ last_edge_was_resume: nextMemory.lastEdgeWasResume, episode_key: nextMemory.episodeKey });
    void ctx.manager.raise(
      sellingStopped
        ? describeOverheatSellStop({
            ...limits,
            episodeKey: nextMemory.episodeKey,
            temperatureCelsius: flipReading.value,
            withheldSellWatts: untrack(ctx.overheatSellStop.withheldSellWatts),
          })
        : describeOverheatSellResume({
            ...limits,
            episodeKey: nextMemory.episodeKey,
            temperatureCelsius: flipReading.value,
          })
    );
    return nextMemory;
  }, bootMemoryFromStore());
}

/**
 * Worded by whether the stop actually curtailed an export: at 97 °C without a sell window (the heat
 * coming from AC charging, PV or house load) "selling stopped" would read as "the mitigation is in
 * effect" while nothing changed and the inverter keeps heating.
 */
export function describeOverheatSellStop(
  input: OverheatSellStopLimits & { episodeKey: string; temperatureCelsius: number; withheldSellWatts: number }
): AlertToRaise {
  const reading = `component_max_temperature is ${round1(input.temperatureCelsius)}°C (limit ${input.only_sell_below_inverter_temp_celsius}°C)`;
  const resumeBelow = `${effectiveResumeBelowCelsius(input)}°C`;
  const whatToCheck =
    "At 100°C the inverter shuts down and stays off until power-cycled. Check the inverter room: is the door open and the ventilation running?";
  if (input.withheldSellWatts > 0) {
    return {
      key: input.episodeKey,
      severity: "P1",
      title: "Inverter overheating — selling stopped",
      message: `${reading}, so selling stopped: the ${Math.round(input.withheldSellWatts)} W sell window feeds 0 until it cools below ${resumeBelow}. ${whatToCheck}`,
    };
  }
  return {
    key: input.episodeKey,
    severity: "P1",
    title: "Inverter overheating",
    message: `${reading}. No sell window was exporting, so stopping selling curtails nothing: the heat comes from charging, PV or house load. Sell windows stay at 0 until it cools below ${resumeBelow}. ${whatToCheck}`,
  };
}

export function describeOverheatSellResume(
  input: OverheatSellStopLimits & { episodeKey: string; temperatureCelsius: number }
): AlertToRaise {
  return {
    key: `${input.episodeKey}:resolved`,
    severity: "P3",
    title: "Inverter cooled — selling resumed",
    message:
      `component_max_temperature is down to ${round1(input.temperatureCelsius)}°C (below ${effectiveResumeBelowCelsius(input)}°C), so scheduled selling is allowed again. ` +
      `Not an all-clear: if the room is still unventilated it heats up again, and selling stops again at ${input.only_sell_below_inverter_temp_celsius}°C with a new P1.`,
  };
}

/** Where the previous process left off; no (or an unusable) file means the plain key's first episode */
function bootMemoryFromStore(): OverheatAlertMemory {
  const freshMemory: OverheatAlertMemory = { stopped: false, lastEdgeWasResume: false, episodeKey: OVERHEAT_ALERT_KEY };
  const persisted = loadOverheatEpisode();
  if (!persisted) return freshMemory;
  const { episode_key } = persisted;
  // A key outside the family (a hand edit) would let this alert borrow — and burn — another alert's cooldown
  if (episode_key !== OVERHEAT_ALERT_KEY && !episode_key.startsWith(`${OVERHEAT_ALERT_KEY}:`)) {
    warnLog("Overheat alerts: ignoring a persisted episode key outside the inverter-temp family", episode_key);
    return freshMemory;
  }
  return { stopped: false, lastEdgeWasResume: persisted.last_edge_was_resume, episodeKey: episode_key };
}

/** The key the inverter-temperature P1 has always used — persisted cooldowns in alert_state.json carry over */
export const OVERHEAT_ALERT_KEY = "inverter-temp";

type AlertToRaise = Parameters<AlertManager["raise"]>[0];

type OverheatAlertMemory = {
  stopped: boolean;
  /** The newest edge (this process, or the persisted one at boot) was a resume: the next stop is a repeat */
  lastEdgeWasResume: boolean;
  /** The current (or last) stop episode's key, which its resume notice derives from */
  episodeKey: string;
};
