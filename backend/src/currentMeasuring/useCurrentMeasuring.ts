import adc from "@iiot2k/ads1115";
import { Accessor, createEffect, createSignal, onCleanup, Setter, untrack } from "solid-js";
import { error } from "../utilities/logging";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import { Config } from "../config";

const PORT = 1; // i2c-1

export function useCurrentMeasuring(config: Accessor<Config>) {
  const [voltageSagMillivolts, setVoltageSagMillivolts] = createSignal<number | undefined>(undefined);
  const [toggleMqttSend, setToggleMqttSend] = createSignal(false);
  let cleanedUp = false;

  onCleanup(() => (cleanedUp = true));

  makeReading({
    setValue: setVoltageSagMillivolts,
    getWasCleanedUp: () => cleanedUp,
    getRate: () => untrack(() => config().current_measuring.rate_constant),
  });

  createEffect(() => {
    const value = voltageSagMillivolts();
    if (value == undefined) return;
    toggleMqttSend();
    reportToMqtt(value, config);

    // Always send a datapoint at least every 120 seconds so that grafana doesn't create gradients over long time periods when the value has stayed the same for long
    const grafanaReportTimeout = setTimeout(() => setToggleMqttSend(prev => !prev), 120_000);
    onCleanup(() => clearTimeout(grafanaReportTimeout));
  });

  return { voltageSagMillivolts };
}

function reportToMqtt(value: number, config: Accessor<Config>) {
  const { mqttClient } = useFromMqttProvider();
  const client = mqttClient();
  if (!client) return;
  const table = untrack(() => config().current_measuring.table);
  const influx_entry = `${table} raw_voltage_mv=${value}`;
  if (client.connected) {
    client.publish(table, influx_entry).catch(() => {});
  }
}

function makeReading({
  setValue,
  getWasCleanedUp,
  getRate,
}: {
  setValue: Setter<number | undefined>;
  getWasCleanedUp: () => boolean;
  getRate: () => number;
}) {
  adc.read(PORT, adc.ADR_48, adc.MUX_I0_I1, adc.GAIN_256, getRate(), true, async function (data) {
    if (data === undefined) {
      error("Failed reading amperemeter ADC:", adc.error_text());
    } else {
      setValue(data / 128);
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
