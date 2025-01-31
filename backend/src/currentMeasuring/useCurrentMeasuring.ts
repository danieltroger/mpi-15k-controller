import adc from "@iiot2k/ads1115";
import { Accessor, createEffect, createSignal, onCleanup, Setter, untrack } from "solid-js";
import { error } from "../utilities/logging";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import { Config } from "../config";

const PORT = 1; // i2c-1
const RAWDATA = false;

export function useCurrentMeasuring(config: Accessor<Config>) {
  const [voltageSagMillivolts, setVoltageSagMillivolts] = createSignal<number | undefined>(undefined);
  const [toggleMqttSend, setToggleMqttSend] = createSignal(false);
  let cleanedUp = false;

  onCleanup(() => (cleanedUp = true));

  makeReading({
    setValue: setVoltageSagMillivolts,
    getWasCleanedUp: () => cleanedUp,
    getGain: () => untrack(() => config().current_measuring.gain_constant),
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
  getGain,
}: {
  setValue: Setter<number | undefined>;
  getWasCleanedUp: () => boolean;
  getGain: () => number;
}) {
  adc.read(
    PORT,
    adc.ADR_48,
    adc.MUX_I0_I1,
    getGain(),
    adc.RATE_8,
    RAWDATA, // rawdata ?
    function (data) {
      if (data === undefined) {
        error("Failed reading amperemeter ADC", adc.error_text());
      } else {
        setValue(data);
        if (!getWasCleanedUp()) {
          makeReading({ setValue: setValue, getWasCleanedUp: getWasCleanedUp, getGain });
        }
      }
    }
  );
}
