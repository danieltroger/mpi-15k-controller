import adc from "@iiot2k/ads1115";
import { createSignal, onCleanup, Setter } from "solid-js";
import { error } from "../utilities/logging";

const PORT = 1; // i2c-1
const RAWDATA = false;

export function useCurrentMeasuring() {
  const [voltageSagMillivolts, setVoltageSagMillivolts] = createSignal<number | undefined>(undefined);
  let cleanedUp = false;

  onCleanup(() => (cleanedUp = true));

  makeReading(setVoltageSagMillivolts, () => cleanedUp);
}

function makeReading(setValue: Setter<number | undefined>, getWasCleanedUp: () => boolean) {
  adc.read(
    PORT,
    adc.ADR_48,
    adc.MUX_I0_I1,
    adc.GAIN_256,
    adc.RATE_8,
    RAWDATA, // rawdata ?
    function (data) {
      if (data === undefined) {
        error("Failed reading amperemeter ADC", adc.error_text());
      } else {
        setValue(data);
      }
    }
  );
}
