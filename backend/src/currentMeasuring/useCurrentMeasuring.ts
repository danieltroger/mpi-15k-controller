import adc from "@iiot2k/ads1115";
import { Accessor, createEffect, createSignal, onCleanup, Setter, untrack } from "solid-js";
import { error } from "../utilities/logging";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import { Config } from "../config";
import { useAverageCurrent } from "./useAverageCurrent";

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

  createEffect(() => reportToMqtt(rawMeasurement()?.value, config, "raw_voltage_mv"));
  createEffect(() => reportToMqtt(averagedMeasurement(), config, "voltage_mv_averaged"));

  return { voltageSagMillivoltsRaw: rawMeasurement, voltageSagMillivoltsAveraged: averagedMeasurement };
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
