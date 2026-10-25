import { type Accessor, createEffect, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import {
  effectiveResumeBelowCelsius,
  type OverheatSellStopLimits,
  type OverheatSellStopSignals,
} from "../feeding/overheatSellStop.ts";
import type { AlertManager } from "./alertManager.ts";
import type { AlertRecord } from "./alerting.types.ts";
import { round1 } from "./alertingLogic.ts";

/**
 * The inverter-temperature P1 rides the overheat sell stop's edges instead of keeping a threshold
 * of its own: one limit, one hysteresis, and stale readings hold both alike.
 *
 * Episode keys: the stop makes a sawtooth inside one long window (stop at 97 °C, cool below 90 °C,
 * 14 kW again, stop again), and a cycle can be shorter than cooldown_minutes. So a stop that follows
 * a resume is a new episode keyed by its own onset, and the previous episode's cooldown can't
 * swallow it. "Follows a resume" survives restarts: the boot memory comes from the persisted
 * recentAlerts (alert_state.json), so a restart between the resume and the re-stop still pages the
 * P1 the resume notice promised. A stop already in force across a restart or main() crash loop
 * continues the episode the history ends on, under that episode's key, and its persisted cooldown
 * keeps the loop from re-paging (the plain "inverter-temp" key while nothing has resumed yet).
 * Keys with onsets age out of alert_state.json like any other key (expiredCooldownKeys).
 */
export function startOverheatSellStopAlerts(ctx: {
  config: Accessor<Config>;
  manager: AlertManager;
  overheatSellStop: OverheatSellStopSignals;
}) {
  // Seeded with "not stopped", not with the first state: a stop that is already in force when
  // alerting starts must still page (under the history's episode key, so a loop can't re-page).
  createEffect<OverheatAlertMemory>(
    memory => {
      const { sellingStopped, flipReading } = ctx.overheatSellStop.state();
      if (!flipReading || sellingStopped === memory.stopped) return memory;
      const limits = untrack(ctx.config).scheduled_power_selling;
      if (sellingStopped) {
        const episodeKey = memory.lastEdgeWasResume ? `${OVERHEAT_ALERT_KEY}:${flipReading.time}` : memory.episodeKey;
        void ctx.manager.raise(
          describeOverheatSellStop({
            ...limits,
            episodeKey,
            temperatureCelsius: flipReading.value,
            withheldSellWatts: untrack(ctx.overheatSellStop.withheldSellWatts),
          })
        );
        return { stopped: true, lastEdgeWasResume: false, episodeKey };
      }
      void ctx.manager.raise(
        describeOverheatSellResume({ ...limits, episodeKey: memory.episodeKey, temperatureCelsius: flipReading.value })
      );
      return { stopped: false, lastEdgeWasResume: true, episodeKey: memory.episodeKey };
    },
    bootMemoryFromHistory(untrack(ctx.manager.recentAlerts))
  );
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
    key: `${input.episodeKey}${RESOLVED_SUFFIX}`,
    severity: "P3",
    title: "Inverter cooled — selling resumed",
    message:
      `component_max_temperature is down to ${round1(input.temperatureCelsius)}°C (below ${effectiveResumeBelowCelsius(input)}°C), so scheduled selling is allowed again. ` +
      `Not an all-clear: if the room is still unventilated it heats up again, and selling stops again at ${input.only_sell_below_inverter_temp_celsius}°C with a new P1.`,
  };
}

/**
 * Where the previous process left off. recentAlerts is newest first and only holds alerts that were
 * actually sent (or dry-run): a raise swallowed by its cooldown isn't recorded, so a crash loop keeps
 * finding the episode's original P1. With no overheat alert in the history (or alerting off), the
 * first stop gets the plain key.
 */
function bootMemoryFromHistory(recentAlerts: readonly AlertRecord[]): OverheatAlertMemory {
  const newestOverheatRecord = recentAlerts.find(
    record => record.key === OVERHEAT_ALERT_KEY || record.key.startsWith(`${OVERHEAT_ALERT_KEY}:`)
  );
  if (!newestOverheatRecord) return { stopped: false, lastEdgeWasResume: false, episodeKey: OVERHEAT_ALERT_KEY };
  const wasResume = newestOverheatRecord.key.endsWith(RESOLVED_SUFFIX);
  return {
    stopped: false,
    lastEdgeWasResume: wasResume,
    episodeKey: wasResume ? newestOverheatRecord.key.slice(0, -RESOLVED_SUFFIX.length) : newestOverheatRecord.key,
  };
}

/** The key the inverter-temperature P1 has always used — persisted cooldowns in alert_state.json carry over */
export const OVERHEAT_ALERT_KEY = "inverter-temp";
const RESOLVED_SUFFIX = ":resolved";

type AlertToRaise = Parameters<AlertManager["raise"]>[0];

type OverheatAlertMemory = {
  stopped: boolean;
  /** The newest edge (this process, or the persisted history at boot) was a resume: the next stop is a repeat */
  lastEdgeWasResume: boolean;
  /** The current (or last) stop episode's key, which its resume notice derives from */
  episodeKey: string;
};
