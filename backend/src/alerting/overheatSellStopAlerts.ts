import { type Accessor, createEffect, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { OverheatSellStopLimits, OverheatSellStopState } from "../feeding/overheatSellStop.ts";
import type { AlertManager } from "./alertManager.ts";
import { round1 } from "./alertingLogic.ts";

type AlertToRaise = Parameters<AlertManager["raise"]>[0];

/**
 * The inverter-temperature P1 rides the overheat sell stop's edges instead of keeping a threshold
 * of its own, so the push can truthfully say selling was stopped: one limit, one hysteresis, and
 * stale readings hold both alike. Keys predate the sell stop so persisted cooldowns carry over.
 */
export function startOverheatSellStopAlerts(ctx: {
  config: Accessor<Config>;
  manager: AlertManager;
  overheatSellStop: Accessor<OverheatSellStopState>;
}) {
  // Seeded with "not stopped", not with the first state: a stop that is already in force when
  // alerting starts must still page.
  createEffect<boolean>(previouslyStopped => {
    const { sellingStopped, flipReading } = ctx.overheatSellStop();
    if (!flipReading || sellingStopped === previouslyStopped) return sellingStopped;
    const limits = untrack(ctx.config).scheduled_power_selling;
    void ctx.manager.raise(
      sellingStopped
        ? describeOverheatSellStop(flipReading.value, limits)
        : describeOverheatSellResume(flipReading.value, limits)
    );
    return sellingStopped;
  }, false);
}

export function describeOverheatSellStop(temperatureCelsius: number, limits: OverheatSellStopLimits): AlertToRaise {
  return {
    key: "inverter-temp",
    severity: "P1",
    title: "Inverter overheating — selling stopped",
    message:
      `component_max_temperature is ${round1(temperatureCelsius)}°C (limit ${limits.only_sell_below_inverter_temp_celsius}°C). ` +
      `Selling is stopped until it cools below ${limits.start_selling_again_below_inverter_temp_celsius}°C. ` +
      `At 100°C the inverter shuts down and stays off until power-cycled. ` +
      `Check the inverter room: is the door open and the ventilation running?`,
  };
}

export function describeOverheatSellResume(temperatureCelsius: number, limits: OverheatSellStopLimits): AlertToRaise {
  return {
    key: "inverter-temp:resolved",
    severity: "P3",
    title: "Inverter cooled — selling resumed",
    message: `component_max_temperature is down to ${round1(temperatureCelsius)}°C (below ${limits.start_selling_again_below_inverter_temp_celsius}°C), so scheduled selling is allowed again.`,
  };
}
