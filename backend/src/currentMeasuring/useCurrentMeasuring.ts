import adc from "@iiot2k/ads1115";
import { Accessor, createEffect, createMemo, createSignal, onCleanup, Setter, untrack } from "solid-js";
import { error } from "../utilities/logging";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import { Config } from "../config";
import { useAverageCurrent } from "./useAverageCurrent";
import { reactiveBatteryVoltage } from "../mqttValues/mqttHelpers";

const PORT = 1; // i2c-1

export function useCurrentMeasuring(config: Accessor<Config>) {
  const [rawMeasurement, setRawMeasurement] = createSignal<{ value: number; time: number } | undefined>(undefined); // in millivolts
  let cleanedUp = false;
  onCleanup(() => (cleanedUp = true));
  makeReading({
    setValue: setRawMeasurement,
    getWasCleanedUp: () => cleanedUp,
    getRate: () => untrack(() => config().current_measuring.rate_constant),
  });

  const averagedMeasurement = useAverageCurrent({ rawMeasurement, config });
  const calculatedPowerFromAmpMeter = createMemo(() => {
    const measurementValue = rawMeasurement();
    const batteryVoltage = reactiveBatteryVoltage();
    if (!measurementValue || batteryVoltage == undefined) return;
    const calculatedCurrent = rawToAmperage(measurementValue.value);
    return calculatedCurrent * batteryVoltage;
  });

  createEffect(() => reportToMqtt(rawMeasurement()?.value, config, "raw_voltage_mv"));
  createEffect(() => reportToMqtt(averagedMeasurement(), config, "voltage_mv_averaged"));
  createEffect(() => reportToMqtt(calculatedPowerFromAmpMeter(), config, "calculated_power"));

  return {
    voltageSagMillivoltsRaw: rawMeasurement,
    voltageSagMillivoltsAveraged: averagedMeasurement,
    calculatedPowerFromAmpMeter,
  };
}

function rawToAmperage(value: number) {
  return -1 * (value * (value * -0.00692 + 5.99) - 8.37);
}

function reportToMqtt(value: number | undefined, config: Accessor<Config>, influx_name: string) {
  if (value == undefined) return;
  const { mqttClient } = useFromMqttProvider();
  const client = mqttClient();
  if (!client) return;
  const table = untrack(() => config().current_measuring.table);
  const influx_entry = `${table} ${influx_name}=${value}`;
  if (client.connected) {
    client.publish(table, influx_entry).catch(() => {});
  }
}

function makeReading({
  setValue,
  getWasCleanedUp,
  getRate,
}: {
  setValue: Setter<{ value: number; time: number } | undefined>;
  getWasCleanedUp: () => boolean;
  getRate: () => number;
}) {
  adc.read(PORT, adc.ADR_48, adc.MUX_I0_I1, adc.GAIN_256, getRate(), true, async function (data) {
    if (data === undefined) {
      error("Failed reading amperemeter ADC:", adc.error_text());
    } else {
      setValue({ value: data / 128, time: +new Date() });
    }
    if (!getWasCleanedUp()) {
      if (data === undefined) {
        // If failed, wait a bit before making the next reading
        await new Promise(r => setTimeout(r, 1000));
      }
      makeReading({ setValue: setValue, getWasCleanedUp: getWasCleanedUp, getRate });
    }
  });
}
