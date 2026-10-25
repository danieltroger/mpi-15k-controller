import { hourSun, SUBSTEPS_PER_HOUR } from "./pvModel.ts";
import { snowGateFlags } from "./snowGate.ts";
import { isStalledBin } from "./pvStall.ts";
import type { RadiationColumns, SolarFitDataset, StringObservations } from "./pvFit.types.ts";
import type { PvHistoryColumns, RadiationArchiveColumns } from "./pvHistory.types.ts";
import type { SolarStringKey } from "./solarModel.types.ts";

/**
 * Turns production history + irradiance archives (all on one hour grid) into the columnar fit
 * input, deciding which hours the fit may learn from. Runs in the refit child process. Excluded, with
 * the evidence the backtest validated in production form:
 *  - inverter outages: any 10-min bin with the "PV stalled" signature (pvStall.ts)
 *  - snow: forecast snow depth > 1 cm or ≥ 0.5 cm snowfall in the past week (no ERA5-Land live)
 *  - curtailment: battery at the charge ceiling (full_battery_voltage − 0.2 V; the pack tops out at
 *    the configured value since the pi17 fix) or SOC ≥ 98 % while export takes < 1 kW — 5–15 % low when it happens
 */
export function buildSolarFitDataset(input: {
  history: PvHistoryColumns;
  physical: RadiationArchiveColumns;
  forecast: RadiationArchiveColumns;
  latitude: number;
  longitude: number;
  /** Before this, MPPT1 + MPPT2 were both string 1 and string 2 didn't exist (NaN = never re-wired) */
  rewiredAtMs: number;
  full_battery_voltage: number;
}): { dataset: SolarFitDataset; completeHours: Uint8Array } {
  const { history } = input;
  const hourCount = history.hourCount;
  const hourStartMs = new Float64Array(hourCount);
  const sunAzimuthDegrees = new Float64Array(hourCount * SUBSTEPS_PER_HOUR);
  const sunElevationDegrees = new Float64Array(hourCount * SUBSTEPS_PER_HOUR);
  const extraterrestrial = new Float64Array(hourCount);
  const snowOnGround = new Uint8Array(hourCount);
  const completeHours = new Uint8Array(hourCount);
  const strings: Record<SolarStringKey, StringObservations> = {
    string1: emptyObservations(hourCount),
    string2: emptyObservations(hourCount),
  };
  const snowGated = snowGateFlags(input.forecast.snowfallCm, input.forecast.snowDepthMetres);
  const curtailmentVolts = input.full_battery_voltage - CURTAILMENT_MARGIN_VOLTS;

  for (let hour = 0; hour < hourCount; hour++) {
    const startMs = history.firstHourMs + hour * 3600_000;
    hourStartMs[hour] = startMs;
    const sun = hourSun(startMs, input.latitude, input.longitude);
    sunAzimuthDegrees.set(sun.azimuthDegrees, hour * SUBSTEPS_PER_HOUR);
    sunElevationDegrees.set(sun.elevationDegrees, hour * SUBSTEPS_PER_HOUR);
    extraterrestrial[hour] = sun.extraterrestrial;
    snowOnGround[hour] = input.forecast.snowDepthMetres[hour] > 0.02 ? 1 : 0;

    let complete = true;
    let stalled = false;
    for (let bin = 0; bin < SUBSTEPS_PER_HOUR; bin++) {
      const index = hour * SUBSTEPS_PER_HOUR + bin;
      const mppt1Watts = history.mppt1Watts[index];
      const mppt2Watts = history.mppt2Watts[index];
      if (!history.binHasData[index] || !Number.isFinite(mppt1Watts) || !Number.isFinite(mppt2Watts)) complete = false;
      stalled ||= isStalledBin({
        mppt1Watts,
        mppt2Watts,
        mppt1Volts: history.mppt1Volts[index],
        mppt2Volts: history.mppt2Volts[index],
        sunElevationDegrees: sun.elevationDegrees[bin],
      });
      const beforeRewiring = startMs < input.rewiredAtMs;
      strings.string1.substepWatts[index] = beforeRewiring ? mppt1Watts + mppt2Watts : mppt1Watts;
      strings.string2.substepWatts[index] = beforeRewiring ? Number.NaN : mppt2Watts;
    }
    completeHours[hour] = complete ? 1 : 0;
    const daylight = sun.elevationDegrees.some(elevation => elevation > 0);
    const curtailed =
      history.batteryVoltsMax[hour] >= curtailmentVolts ||
      (history.socPercentMax[hour] >= FULL_SOC_PERCENT && history.gridWattsMean[hour] > NOT_EXPORTING_GRID_WATTS);
    const irradiancePresent =
      Number.isFinite(input.physical.globalHorizontal[hour]) && Number.isFinite(input.forecast.globalHorizontal[hour]);
    const fittable = complete && daylight && !stalled && !curtailed && !snowGated[hour] && irradiancePresent;
    for (const stringKey of ["string1", "string2"] as const) {
      const observations = strings[stringKey];
      observations.hourlyWatts[hour] = complete
        ? meanOf(observations.substepWatts, hour * SUBSTEPS_PER_HOUR, SUBSTEPS_PER_HOUR)
        : Number.NaN;
      observations.usable[hour] = fittable && Number.isFinite(observations.hourlyWatts[hour]) ? 1 : 0;
    }
  }

  return {
    dataset: {
      hourStartMs,
      sunAzimuthDegrees,
      sunElevationDegrees,
      extraterrestrial,
      physical: zeroFilledRadiation(input.physical),
      forecast: zeroFilledRadiation(input.forecast),
      snowOnGround,
      strings,
    },
    completeHours,
  };
}

/** The pack tops out at full_battery_voltage; within this much of it the inverter is throttling PV */
const CURTAILMENT_MARGIN_VOLTS = 0.2;
const FULL_SOC_PERCENT = 98;
/** "Not exporting" for the curtailment test: less than 1 kW going out */
const NOT_EXPORTING_GRID_WATTS = -1000;

function emptyObservations(hourCount: number): StringObservations {
  return {
    hourlyWatts: new Float64Array(hourCount).fill(Number.NaN),
    substepWatts: new Float64Array(hourCount * SUBSTEPS_PER_HOUR).fill(Number.NaN),
    usable: new Uint8Array(hourCount),
  };
}

/** Missing hours become 0 W/m² (they're never usable, but the term columns need numbers) */
function zeroFilledRadiation(archive: RadiationArchiveColumns): RadiationColumns {
  return {
    globalHorizontal: zeroFilled(archive.globalHorizontal),
    diffuseHorizontal: zeroFilled(archive.diffuseHorizontal),
    directHorizontal: zeroFilled(archive.directHorizontal),
  };
}

function zeroFilled(values: Float64Array): Float64Array {
  return values.map(value => (Number.isFinite(value) ? value : 0));
}

function meanOf(values: Float64Array, offset: number, count: number): number {
  let sum = 0;
  for (let index = offset; index < offset + count; index++) sum += values[index];
  return sum / count;
}
