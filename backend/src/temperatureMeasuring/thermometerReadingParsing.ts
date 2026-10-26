/**
 * Pure parsing and plausibility checks for DS18B20 readings out of sysfs. The kernel checks the CRC for
 * both attributes: `temperature` comes back empty when the scratchpad read failed its CRC check (after
 * w1_therm's own retries) or a conversion is still pending, and `w1_slave` states its verdict on its first line.
 */

export type ProbeReadingCheck = { ok: true; celsius: number } | { ok: false; reason: string };

/** What a DS18B20 scratchpad holds after a power-on reset, before its first conversion. */
export const POWER_ON_RESET_CELSIUS = 85;
/** A genuine 85.000 °C has the same probe's previous accepted reading within this distance. */
const GENUINE_POWER_ON_VALUE_WINDOW_CELSIUS = 10;
const LOWEST_PLAUSIBLE_CELSIUS = -30;
const HIGHEST_PLAUSIBLE_CELSIUS = 90;

/** The `temperature` attribute: whole millidegrees and a newline, e.g. "24250\n" or "-1250\n". */
export function parseTemperatureAttribute(attributeText: string): ProbeReadingCheck {
  const millidegreesText = attributeText.trim();
  if (!millidegreesText) {
    return {
      ok: false,
      reason: "empty read (the kernel's scratchpad read failed its CRC check, or the conversion was still pending)",
    };
  }
  if (!/^-?\d+$/.test(millidegreesText)) {
    return { ok: false, reason: `not whole millidegrees: ${JSON.stringify(attributeText)}` };
  }
  return { ok: true, celsius: Number(millidegreesText) / 1000 };
}

/**
 * The legacy `w1_slave` attribute, e.g.
 * '84 01 55 05 7f a5 a5 66 f5 : crc=f5 YES\n84 01 55 05 7f a5 a5 66 f5 t=24250\n'.
 * On a CRC failure the kernel still prints a t= value, the last good one, so the verdict decides alone.
 */
export function parseW1SlaveText(w1SlaveText: string): ProbeReadingCheck {
  if (!w1SlaveText.trim()) {
    return { ok: false, reason: "empty read (the kernel's conversion or scratchpad read failed)" };
  }
  const [crcLine = "", temperatureLine = ""] = w1SlaveText.split("\n");
  if (!/crc=[0-9a-f]{2} YES$/i.test(crcLine.trim())) {
    return { ok: false, reason: `CRC didn't match: ${JSON.stringify(w1SlaveText)}` };
  }
  const millidegreesText = /t=(-?\d+)$/.exec(temperatureLine.trim())?.[1];
  if (millidegreesText === undefined) {
    return { ok: false, reason: `no t= value: ${JSON.stringify(w1SlaveText)}` };
  }
  return { ok: true, celsius: Number(millidegreesText) / 1000 };
}

/**
 * Rejects what a working probe can't be reporting. 85.000 °C is the scratchpad of a probe that browned
 * out and missed the conversion, so it only counts right after a reading near it: a probe that really
 * heats up passes through the neighbouring values first. Deliberately no filter on jumps: a fast genuine
 * rise is exactly what the battery P1 alert has to see.
 */
export function checkPlausibility(celsius: number, previousAcceptedCelsius: number | undefined): ProbeReadingCheck {
  if (!Number.isFinite(celsius) || celsius < LOWEST_PLAUSIBLE_CELSIUS || celsius > HIGHEST_PLAUSIBLE_CELSIUS) {
    return {
      ok: false,
      reason: `${celsius}°C is outside ${LOWEST_PLAUSIBLE_CELSIUS}…${HIGHEST_PLAUSIBLE_CELSIUS}°C`,
    };
  }
  const nearPreviousReading =
    previousAcceptedCelsius !== undefined &&
    Math.abs(previousAcceptedCelsius - POWER_ON_RESET_CELSIUS) <= GENUINE_POWER_ON_VALUE_WINDOW_CELSIUS;
  if (celsius === POWER_ON_RESET_CELSIUS && !nearPreviousReading) {
    return {
      ok: false,
      reason: `85°C power-on value (the probe reset and missed the conversion; previous reading ${
        previousAcceptedCelsius === undefined ? "none" : `${previousAcceptedCelsius}°C`
      })`,
    };
  }
  return { ok: true, celsius };
}
