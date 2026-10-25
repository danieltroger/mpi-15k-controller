import { hourSun, poaTerms, stringSubstepWatts, SUBSTEPS_PER_HOUR, type StringCoefficients } from "./pvModel.ts";
import { snowGateFlags } from "./snowGate.ts";
import { nowcastRatio, snowNowcastFactor } from "./snowNowcast.ts";
import type { RadiationHour, SolarStringKey } from "./solarModel.types.ts";

/**
 * Pure forecast assembly: per-string sub-step power for every forecast hour, scaled by each
 * string's snow nowcast. `recentActual` (hour start → mean W per string) feeds the nowcast; the
 * model's view of those same past hours comes from the forecast's own past_days.
 */
export function buildSolarForecast(input: {
  radiationHours: RadiationHour[];
  nowMs: number;
  latitude: number;
  longitude: number;
  strings: Record<SolarStringKey, { tilt_degrees: number; azimuth_degrees: number; coefficients: StringCoefficients }>;
  recentActual: Map<number, Record<SolarStringKey, number>> | undefined;
}): BuiltSolarForecast {
  const hours = [...input.radiationHours].sort((left, right) => left.hourStartMs - right.hourStartMs);
  const substepsByHour = new Map<number, number[]>();
  const perStringByHour = hours.map(hour => {
    const sun = hourSun(hour.hourStartMs, input.latitude, input.longitude);
    const snowOnGround = (hour.snowDepthMetres ?? 0) > 0.02;
    const watts = {} as Record<SolarStringKey, number[]>;
    for (const stringKey of SOLAR_STRING_KEYS) {
      const spec = input.strings[stringKey];
      watts[stringKey] = stringSubstepWatts(
        poaTerms(sun, hour, spec.tilt_degrees, spec.azimuth_degrees),
        sun,
        spec.coefficients,
        snowOnGround
      );
    }
    return { hourStartMs: hour.hourStartMs, watts };
  });

  // The latest hour that has fully happened is the nowcast's "now"
  const lastCompleteHourMs = Math.floor(input.nowMs / 3600_000) * 3600_000 - 3600_000;
  const pastHours = hours.filter(hour => hour.hourStartMs <= lastCompleteHourMs);
  const gapFilledPast = pastHours.length ? consecutiveHours(pastHours) : [];
  const gateFlags = snowGateFlags(
    gapFilledPast.map(hour => hour?.snowfallCm ?? Number.NaN),
    gapFilledPast.map(hour => hour?.snowDepthMetres ?? Number.NaN)
  );
  const gateOpen = gateFlags.length > 0 && gateFlags[gateFlags.length - 1] === 1;
  const nowcast = {} as BuiltSolarForecast["nowcast"];
  for (const stringKey of SOLAR_STRING_KEYS) {
    const tracked = perStringByHour
      .filter(hour => hour.hourStartMs <= lastCompleteHourMs)
      .map(hour => ({
        actualWatts: input.recentActual?.get(hour.hourStartMs)?.[stringKey] ?? Number.NaN,
        modelWatts: mean(hour.watts[stringKey]),
      }));
    nowcast[stringKey] = {
      ratio: input.recentActual ? nowcastRatio(tracked) : 1,
      gateOpen: gateOpen && !!input.recentActual,
    };
  }

  const forecastHours: BuiltSolarForecast["hours"] = [];
  const dailyKwh: Record<string, number> = {};
  for (const { hourStartMs, watts } of perStringByHour) {
    const leadHours = (hourStartMs - lastCompleteHourMs) / 3600_000;
    const scaled = {} as Record<SolarStringKey, number[]>;
    for (const stringKey of SOLAR_STRING_KEYS) {
      const factor =
        leadHours > 0
          ? snowNowcastFactor({ ratio: nowcast[stringKey].ratio, gateOpen: nowcast[stringKey].gateOpen, leadHours })
          : 1;
      scaled[stringKey] = watts[stringKey].map(value => value * factor);
    }
    const totals = scaled.string1.map((string1Watts, substep) => string1Watts + scaled.string2[substep]);
    substepsByHour.set(hourStartMs, totals);
    const hour = { hourStartMs, string1Watts: mean(scaled.string1), string2Watts: mean(scaled.string2) };
    forecastHours.push(hour);
    const day = new Date(hourStartMs).toISOString().slice(0, 10);
    dailyKwh[day] = (dailyKwh[day] ?? 0) + (hour.string1Watts + hour.string2Watts) / 1000;
  }
  const wattsAt = (ms: number) => {
    const hourStartMs = Math.floor(ms / 3600_000) * 3600_000;
    const substep = Math.floor((ms - hourStartMs) / SUBSTEP_MS);
    return substepsByHour.get(hourStartMs)?.[substep] ?? 0;
  };
  return {
    wattsAt,
    averageWattsBetween: (startMs, endMs) => averageOfSteps(wattsAt, startMs, endMs),
    rangeEndMs: hours.length ? hours[hours.length - 1].hourStartMs + 3600_000 : input.nowMs,
    dailyKwh,
    hours: forecastHours,
    nowcast,
  };
}

export type BuiltSolarForecast = {
  /** Forecast PV (both strings, W) at a time, stepwise per 10-min sub-step; 0 outside the range */
  wattsAt: (ms: number) => number;
  /** Mean forecast PV (W) over [startMs, endMs), integrating the sub-steps — for slot and hour energies */
  averageWattsBetween: (startMs: number, endMs: number) => number;
  rangeEndMs: number;
  /** Daily kWh sums keyed by YYYY-MM-DD (UTC), for logging/status */
  dailyKwh: Record<string, number>;
  /** Hour-mean forecast per string, for accuracy logging */
  hours: { hourStartMs: number; string1Watts: number; string2Watts: number }[];
  nowcast: Record<SolarStringKey, { ratio: number; gateOpen: boolean }>;
};

export const SOLAR_STRING_KEYS: readonly SolarStringKey[] = ["string1", "string2"];

const SUBSTEP_MS = 3600_000 / SUBSTEPS_PER_HOUR;

/** Exact mean of a function that is constant on each 10-min sub-step */
function averageOfSteps(wattsAt: (ms: number) => number, startMs: number, endMs: number): number {
  if (!(endMs > startMs)) return wattsAt(startMs);
  let energy = 0;
  for (let cursorMs = startMs; cursorMs < endMs; ) {
    const stepEndMs = Math.min(endMs, (Math.floor(cursorMs / SUBSTEP_MS) + 1) * SUBSTEP_MS);
    energy += wattsAt(cursorMs) * (stepEndMs - cursorMs);
    cursorMs = stepEndMs;
  }
  return energy / (endMs - startMs);
}

/** The snow gate's 7-day window needs consecutive hours; fill gaps with "no data" */
function consecutiveHours(hours: RadiationHour[]): (RadiationHour | undefined)[] {
  const byStart = new Map(hours.map(hour => [hour.hourStartMs, hour]));
  const filled: (RadiationHour | undefined)[] = [];
  for (
    let hourStartMs = hours[0].hourStartMs;
    hourStartMs <= hours[hours.length - 1].hourStartMs;
    hourStartMs += 3600_000
  ) {
    filled.push(byStart.get(hourStartMs));
  }
  return filled;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
