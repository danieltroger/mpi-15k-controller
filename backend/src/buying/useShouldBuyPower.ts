import { type Accessor, createEffect, createMemo } from "solid-js";
import { logLog } from "../utilities/logging.ts";
import { calculateChargingAmperage } from "./calculateChargingAmperage.ts";
import { reactiveBatteryVoltage } from "../mqttValues/mqttHelpers.ts";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import { useBatteryValuesProvider } from "../battery/BatteryValuesProvider.ts";
import { inverterIdleWatts } from "../battery/ahLedgerDerivedValues.ts";
import type { Config } from "../config/config.types.ts";
import type { useTemperatures } from "../temperatureMeasuring/useTemperatures.ts";
import { decideScheduledBuy, type ScheduledBuy, wattsForInverter } from "./scheduledBuyDecision.ts";
import { useHoldWindowGuard } from "./useHoldWindowGuard.ts";
import { scheduledBuyWattsPerEntry } from "./scheduledBuyWatts.ts";
import { holdEnabledKnob } from "../autoTrading/plannerKnobs.ts";

/**
 * The battery-side amps the buy schedule asks for, and whether a hold window (a buy window at hold power,
 * scheduledBuyDecision.ts) is what it asks for right now: the stuck-inverter alert must not read a hold's
 * near-idle battery as a latch.
 */
export function useShouldBuyPower({
  config,
  temperatures,
}: {
  config: Accessor<Config>;
  temperatures: ReturnType<typeof useTemperatures>;
}) {
  const { clampedSocAh } = useBatteryValuesProvider();
  // Inverter idle draw the grid-charge sizing must leave headroom for; from the Ah ledger (drain_a × v_discharge).
  const idleConsumptionWatts = createMemo(() => inverterIdleWatts(config()));
  const scheduleOutput = scheduledBuyWattsPerEntry(() => config().scheduled_power_buying.schedule);

  let hitSOCLimit = false;

  // The SOC gate stops charging windows; with hold_enabled on, hold windows are exempt (scheduledBuyDecision.ts
  // says why). Off, every window is gated as before holds existed.
  const holdEnabled = createMemo(() => holdEnabledKnob(config().automatic_trading.hold_enabled));
  const scheduledBuy = createMemo<ScheduledBuy | undefined>(() => {
    const soc = clampedSocAh();
    if (soc === undefined) return;
    const decision = decideScheduledBuy({
      ...config().scheduled_power_buying,
      scheduledWattsPerWindow: scheduleOutput().map(schedule => schedule()()),
      soc,
      hitSocLimit: hitSOCLimit,
      holdEnabled: holdEnabled(),
    });
    hitSOCLimit = decision.hitSocLimit;
    return decision;
  });
  const holdWatts = createMemo(() => scheduledBuy()?.holdWatts ?? 0);
  const holdWanted = createMemo(() => holdWatts() > 0);
  const { holdAllowed } = useHoldWindowGuard({
    config,
    holdWanted,
    holdWatts,
    idleConsumptionWatts,
    temperatures,
  });
  const holdWindowInForce = createMemo(() => holdWanted() && holdAllowed());

  const powerFromSchedule = createMemo(() => {
    const decision = scheduledBuy();
    if (!decision) return;
    return wattsForInverter(decision, holdAllowed());
  });

  const maxGridAmps = createMemo(() => config().scheduled_power_buying.max_grid_input_amperage);

  // Max amperage we can charge at battery (~50v) without blowing the fuse to the grid
  const maxBatteryChargingAmperage = createMemo(() => calculateChargingAmperage(maxGridAmps(), idleConsumptionWatts));

  // Charging amperage at the battery (at ~50v)
  const chargingAmperageForBuyingUnlimited = createMemo(() => {
    const userSpecifiedPower = powerFromSchedule();
    if (!userSpecifiedPower) return userSpecifiedPower;
    const batteryVoltage = reactiveBatteryVoltage();
    if (batteryVoltage == undefined) return undefined;
    const unlimitedAmperage = userSpecifiedPower / batteryVoltage;
    const maxAmperage = maxBatteryChargingAmperage();
    // Limit to hardcoded 50A so we're still charging a bit if this happens and so we can diagnose this case, because we have some bug that periodically makes this memo return undefined when it shouldn't
    if (maxAmperage == undefined) return Math.min(unlimitedAmperage, 50);
    return Math.min(unlimitedAmperage, maxAmperage);
  });

  // Whole amps, at least 1 (a hold at 50 W is MUCHGC0010, at 100 W MUCHGC0020): the write throttle
  // (setterChangeThrottle.ts) is what keeps the per-phase load noise from reaching the inverter
  const chargingAmperageForBuying = createMemo(() => {
    const amperage = chargingAmperageForBuyingUnlimited();
    if (!amperage) return amperage;
    // Hardcoded because our inverter can AC charge with 300A max
    return Math.max(
      Math.min(Math.round(amperage), 300),
      // Above if-statement should let through when we shouldn't buy, this is so any small amount of buying still results in 1 amp buying
      1
    );
  });

  createEffect(() =>
    logLog(
      "AC Charging due to scheduled power buying wants to AC charge with",
      chargingAmperageForBuying(),
      "ampere(s)"
    )
  );

  useLogGridAmperageEvaluation({ maxBatteryChargingAmperage, chargingAmperageForBuying });

  return { chargingAmperageForBuying, holdWindowInForce };
}

export function useLogGridAmperageEvaluation({
  maxBatteryChargingAmperage,
  chargingAmperageForBuying,
}: {
  maxBatteryChargingAmperage: Accessor<number | undefined>;
  chargingAmperageForBuying: Accessor<number | undefined>;
}) {
  const { mqttClient } = useFromMqttProvider();
  const table = "input_amp_experiment";

  createEffect(() => {
    const client = mqttClient();
    if (!client) return;

    createEffect(() => {
      const value = maxBatteryChargingAmperage();
      if (value == undefined) return;
      const influx_entry = `${table} max_battery_charging_amperage=${value}`;
      if (client.connected) {
        client.publish(table, influx_entry).catch(e => {
          logLog("Couldn't publish message", influx_entry, e);
        });
      }
    });

    createEffect(() => {
      const value = chargingAmperageForBuying();
      if (value == undefined) return;
      const influx_entry = `${table} charging_amperage_for_buying=${value}`;
      if (client.connected) {
        client.publish(table, influx_entry).catch(e => {
          logLog("Couldn't publish message", influx_entry, e);
        });
      }
    });
  });
}
