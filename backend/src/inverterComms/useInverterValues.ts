/**
 * Feeds solid-js reactivity directly from the native serial decoder: one store with every GS/PS
 * field under its historical mpp-solar name (value + timestamp — the exact shape the old
 * MQTT-subscription store had, so every consumer including the staleness alerting is untouched),
 * one store with the settings readbacks (GPMP/HECS/BATS) under the legacy CLI keys, and a
 * per-decoded-response signal the one-way MQTT/Influx publisher hangs off.
 */
import { type Accessor, createMemo, createSignal } from "solid-js";
import { createStore, type SetStoreFunction } from "solid-js/store";
import type { Config } from "../config/config.types.ts";
import { warnLog } from "../utilities/logging.ts";
import { type RawMQTTValues, validateMessage } from "../mqttValues/rawValuesSchema.ts";
import type { DecodedRound } from "./pi17Protocol.types.ts";
import type { UsbValues } from "./inverterComms.types.ts";
import { createInverterSession } from "./inverterSession.ts";

export type InverterValuesStore = Partial<{
  [key in keyof RawMQTTValues]: { value: RawMQTTValues[key]; time: number };
}>;

export function useInverterValues(config: Accessor<Config>) {
  const [inverterValues, setInverterValues] = createStore<InverterValuesStore>({});
  const [$usbValues, setUsbValues] = createStore<UsbValues>({});
  const [lastDecodedRound, setLastDecodedRound] = createSignal<DecodedRound | undefined>(undefined);

  const session = createInverterSession({
    poll_values_interval_seconds: createMemo(() => config().usb_parameter_setting.poll_values_interval_seconds),
    onDecodedRound: round => {
      applyRoundToStores(round, setInverterValues, setUsbValues);
      setLastDecodedRound(round);
    },
  });

  return {
    inverterValues,
    $usbValues,
    lastDecodedRound,
    queueSetter: session.queueSetter,
    lastWriteAt: session.lastWriteAt,
    serialIsOpen: session.serialIsOpen,
  };
}

/** The settings-readback keys consumers read — everything else in GPMP/HECS/BATS stays session-internal */
export const USB_VALUE_KEYS = new Set<keyof UsbValues>([
  "solar_energy_distribution_priority",
  "solar_charge_battery",
  "ac_charge_battery",
  "feed_power_to_utility",
  "battery_discharge_to_loads_when_solar_input_normal",
  "battery_discharge_to_loads_when_solar_input_loss",
  "battery_discharge_to_feed_grid_when_solar_input_normal",
  "battery_discharge_to_feed_grid_when_solar_input_loss",
  "maximum_feeding_grid_power",
  "battery_constant_charge_voltage(c.v.)",
  "battery_floating_charge_voltage",
]);

function applyRoundToStores(
  round: DecodedRound,
  setInverterValues: SetStoreFunction<InverterValuesStore>,
  setUsbValues: SetStoreFunction<UsbValues>
): void {
  if (round.command === "GS" || round.command === "PS") {
    for (const [name, value] of Object.entries(round.fields)) {
      try {
        validateMessage(name as keyof RawMQTTValues, value);
      } catch (validationError) {
        // Same contract as the old MQTT parser: schema drift warns loudly but the value still lands
        warnLog("Validation for decoded inverter value failed", validationError);
      }
      // Object.entries loses the per-key type; the schema validation above is the real check
      setInverterValues(name as keyof RawMQTTValues, {
        value: value as RawMQTTValues[keyof RawMQTTValues],
        time: round.decodedAt,
      });
    }
    return;
  }
  const parsedKeys = new Set<string>();
  for (const [name, value] of Object.entries(round.fields)) {
    if (!USB_VALUE_KEYS.has(name as keyof UsbValues)) continue;
    // The store keeps the old CLI's string values (consumers parseFloat the numeric ones)
    setUsbValues(
      name as keyof UsbValues,
      (typeof value === "number" ? String(value) : value) as UsbValues[keyof UsbValues]
    );
    parsedKeys.add(name);
  }
  // The voltage workaround silently stalls if these stop decoding (e.g. a renamed BATS table
  // entry would change the derived key), so scream rather than go quiet.
  if (round.command === "BATS") {
    for (const expectedKey of ["battery_constant_charge_voltage(c.v.)", "battery_floating_charge_voltage"]) {
      if (!parsedKeys.has(expectedKey)) {
        warnLog("BATS round decoded without", expectedKey, "- decoded fields:", Object.keys(round.fields).join(", "));
      }
    }
  }
}
