/**
 * The correction of a bounded numeric setting the backend enforces before using it (config.json is
 * hand-editable; the config page's min/max are only input hints). Pure, no imports: the config page shares
 * the bounds tables built on it (autoTrading/plannerKnobBounds.ts, grid/meterCalibrationBounds.ts).
 */

export type NumberSettingBounds = { defaultValue: number; min: number; max: number; unit: string };

/**
 * A value that isn't a number, or is negative for a setting whose minimum isn't, falls back to the default; one
 * outside the bounds is clamped to them. Takes `unknown` because config.json is hand-editable.
 */
export function effectiveBoundedNumber(
  { defaultValue, min, max, unit }: NumberSettingBounds,
  configuredValue: unknown
): { value: number; correction: string | undefined } {
  const negativeAllowed = min < 0;
  if (
    typeof configuredValue !== "number" ||
    !Number.isFinite(configuredValue) ||
    (!negativeAllowed && configuredValue < 0)
  ) {
    const shown = typeof configuredValue === "string" ? JSON.stringify(configuredValue) : String(configuredValue);
    return {
      value: defaultValue,
      correction: `${shown} is not a ${negativeAllowed ? "" : "non-negative "}number, using the default ${defaultValue} ${unit}`,
    };
  }
  if (configuredValue < min) {
    return {
      value: min,
      correction: `${configuredValue} ${unit} is below the ${min} ${unit} minimum, using the minimum`,
    };
  }
  if (configuredValue > max) {
    return {
      value: max,
      correction: `${configuredValue} ${unit} exceeds the ${max} ${unit} maximum, using the maximum`,
    };
  }
  return { value: configuredValue, correction: undefined };
}
