import adc from "@iiot2k/ads1115";
import { Accessor, createEffect, createMemo, createSignal, onCleanup, Setter, untrack } from "solid-js";
import { errorLog } from "../utilities/logging";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider";
import { useAverageCurrent } from "./useAverageCurrent";
import { reactiveBatteryVoltage } from "../mqttValues/mqttHelpers";
import { Config } from "../config/config.types";

const PORT = 1; // i2c-1

export function useCurrentMeasuring(config: Accessor<Config>, sensor2: boolean) {
  const [rawMeasurement, setRawMeasurement] = createSignal<{ value: number; time: number } | undefined>(undefined); // in millivolts
  let cleanedUp = false;
  onCleanup(() => (cleanedUp = true));
  makeReading({
    setValue: setRawMeasurement,
    getWasCleanedUp: () => cleanedUp,
    getRate: () => untrack(() => config().current_measuring.rate_constant),
    sensor2,
  });

  const zeroCurrentMillivolts = createMemo(
    () => config().current_measuring[`zero_current_millivolts${sensor2 ? "2" : ""}`]
  );
  const milliVoltsPerAmpere = createMemo(
    () => config().current_measuring[`millivolts_per_ampere${sensor2 ? "2" : ""}`]
  );

  const averagedMeasurement = useAverageCurrent({ rawMeasurement, config });
  const calculatedPowerFromAmpMeter = createMemo(() => {
    const measurementValue = rawMeasurement();
    const batteryVoltage = reactiveBatteryVoltage();
    if (!measurementValue || batteryVoltage == undefined) return;
    const calculatedCurrent = (measurementValue.value - zeroCurrentMillivolts()) / milliVoltsPerAmpere();
    return { value: calculatedCurrent * batteryVoltage, time: measurementValue.time };
  });
  const averagedPower = useAverageCurrent({ rawMeasurement: calculatedPowerFromAmpMeter, config });

  createEffect(() => reportToMqtt(rawMeasurement()?.value, config, `raw_voltage_mv${sensor2 ? "_2" : ""}`));
  createEffect(() => reportToMqtt(averagedMeasurement(), config, `voltage_mv_averaged${sensor2 ? "_2" : ""}`));
  createEffect(() => reportToMqtt(averagedPower(), config, `calculated_power${sensor2 ? "_2" : ""}`));

  return {
    voltageSagMillivoltsRaw: rawMeasurement,
    voltageSagMillivoltsAveraged: averagedMeasurement,
    calculatedPowerFromAmpMeter,
  };
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
  sensor2,
}: {
  setValue: Setter<{ value: number; time: number } | undefined>;
  getWasCleanedUp: () => boolean;
  getRate: () => number;
  sensor2: boolean;
}) {
  adc.read(
    PORT,
    adc.ADR_48,
    sensor2 ? adc.MUX_I1_GND : adc.MUX_I0_GND,
    adc.GAIN_4096,
    getRate(),
    true,
    async function (data) {
      if (data === undefined) {
        errorLog("Failed reading amperemeter ADC:", adc.error_text());
      } else {
        // The conversion formula from raw data to millivolts is:
        // mV = raw_value × (full_scale_range_mV / 32768)
        // Example calculation:  mV = raw_value × (4096 / 32768) = raw_value / 8 ✓
        setValue({ value: data / 8, time: +new Date() });
      }
      if (!getWasCleanedUp()) {
        if (data === undefined) {
          // If failed, wait a bit before making the next reading
          await new Promise(r => setTimeout(r, 1000));
        }
        makeReading({ setValue: setValue, getWasCleanedUp: getWasCleanedUp, getRate, sensor2 });
      }
    }
  );
}
