import { hourSun, SUBSTEPS_PER_HOUR } from "./pvModel.ts";
import { snowGateFlags } from "./snowGate.ts";
import { isStalledBin } from "./pvStall.ts";
import type { RadiationColumns, SolarFitDataset, StringObservations } from "./pvFit.types.ts";
import type { RadiationHour, SolarStringKey } from "./solarModel.types.ts";
import type { PvHistoryHour } from "./pvHistory.types.ts";

/**
 * Turns production history + irradiance archives into the columnar fit input, deciding which hours
 * the fit may learn from. Excluded (with the evidence the backtest validated in production form):
 *  - inverter outages: any 10-min bin with the "PV stalled" signature (pvStall.ts)
 *  - snow: forecast snow depth > 1 cm or ≥ 0.5 cm snowfall in the past week (no ERA5-Land live)
 *  - curtailment: battery full and the grid not taking the surplus (5–15 % low when it happens)
 */
export function buildSolarFitDataset(input: {
  history: PvHistoryHour[];
  physicalRadiation: Map<number, RadiationHour>;
  forecastRadiation: Map<number, RadiationHour>;
  latitude: number;
  longitude: number;
  /** Before this, MPPT1 + MPPT2 were both string 1 and string 2 didn't exist (NaN = never re-wired) */
  rewiredAtMs: number;
}): { dataset: SolarFitDataset; completeHours: Uint8Array } {
  const hourCount = input.history.length;
  const hourStartMs = Float64Array.from(input.history, hour => hour.hourStartMs);
  const sunAzimuthDegrees = new Float64Array(hourCount * SUBSTEPS_PER_HOUR);
  const sunElevationDegrees = new Float64Array(hourCount * SUBSTEPS_PER_HOUR);
  const extraterrestrial = new Float64Array(hourCount);
  const physical = emptyRadiationColumns(hourCount);
  const forecast = emptyRadiationColumns(hourCount);
  const snowOnGround = new Uint8Array(hourCount);
  const completeHours = new Uint8Array(hourCount);
  const strings: Record<SolarStringKey, StringObservations> = {
    string1: emptyObservations(hourCount),
    string2: emptyObservations(hourCount),
  };
  const forecastHours = input.history.map(hour => input.forecastRadiation.get(hour.hourStartMs));
  const snowGated = snowGateFlags(forecastHours);

  input.history.forEach((historyHour, hour) => {
    const sun = hourSun(historyHour.hourStartMs, input.latitude, input.longitude);
    sunAzimuthDegrees.set(sun.azimuthDegrees, hour * SUBSTEPS_PER_HOUR);
    sunElevationDegrees.set(sun.elevationDegrees, hour * SUBSTEPS_PER_HOUR);
    extraterrestrial[hour] = sun.extraterrestrial;
    const physicalHour = input.physicalRadiation.get(historyHour.hourStartMs);
    const forecastHour = forecastHours[hour];
    writeRadiation(physical, hour, physicalHour);
    writeRadiation(forecast, hour, forecastHour);
    snowOnGround[hour] = (forecastHour?.snowDepthMetres ?? 0) > 0.02 ? 1 : 0;

    const complete = historyHour.binHasData.every(
      (hasData, bin) =>
        hasData && Number.isFinite(historyHour.mppt1Watts[bin]) && Number.isFinite(historyHour.mppt2Watts[bin])
    );
    completeHours[hour] = complete ? 1 : 0;
    const daylight = sun.elevationDegrees.some(elevation => elevation > 0);
    const stalled = historyHour.mppt1Watts.some((mppt1Watts, bin) =>
      isStalledBin({
        mppt1Watts,
        mppt2Watts: historyHour.mppt2Watts[bin],
        mppt1Volts: historyHour.mppt1Volts[bin],
        mppt2Volts: historyHour.mppt2Volts[bin],
        sunElevationDegrees: sun.elevationDegrees[bin],
      })
    );
    const curtailed =
      historyHour.batteryVoltsMax >= FULL_BATTERY_VOLTS ||
      (historyHour.socPercentMax >= FULL_SOC_PERCENT && historyHour.gridWattsMean > NOT_EXPORTING_GRID_WATTS);
    const fittable =
      complete && daylight && !stalled && !curtailed && !snowGated[hour] && !!physicalHour && !!forecastHour;
    const beforeRewiring = historyHour.hourStartMs < input.rewiredAtMs;
    for (let bin = 0; bin < SUBSTEPS_PER_HOUR; bin++) {
      const index = hour * SUBSTEPS_PER_HOUR + bin;
      strings.string1.substepWatts[index] = beforeRewiring
        ? historyHour.mppt1Watts[bin] + historyHour.mppt2Watts[bin]
        : historyHour.mppt1Watts[bin];
      strings.string2.substepWatts[index] = beforeRewiring ? Number.NaN : historyHour.mppt2Watts[bin];
    }
    for (const stringKey of ["string1", "string2"] as const) {
      const observations = strings[stringKey];
      observations.hourlyWatts[hour] = complete
        ? meanOf(observations.substepWatts.subarray(hour * SUBSTEPS_PER_HOUR, (hour + 1) * SUBSTEPS_PER_HOUR))
        : Number.NaN;
      observations.usable[hour] = fittable && Number.isFinite(observations.hourlyWatts[hour]) ? 1 : 0;
    }
  });

  return {
    dataset: {
      hourStartMs,
      sunAzimuthDegrees,
      sunElevationDegrees,
      extraterrestrial,
      physical,
      forecast,
      snowOnGround,
      strings,
    },
    completeHours,
  };
}

/** Battery at the charge ceiling: the inverter throttles PV once the house and export can't take it */
const FULL_BATTERY_VOLTS = 58.2;
const FULL_SOC_PERCENT = 98;
/** "Not exporting" for the curtailment test: less than 1 kW going out */
const NOT_EXPORTING_GRID_WATTS = -1000;

function emptyRadiationColumns(hourCount: number): RadiationColumns {
  return {
    globalHorizontal: new Float64Array(hourCount),
    diffuseHorizontal: new Float64Array(hourCount),
    directHorizontal: new Float64Array(hourCount),
  };
}

function emptyObservations(hourCount: number): StringObservations {
  return {
    hourlyWatts: new Float64Array(hourCount).fill(Number.NaN),
    substepWatts: new Float64Array(hourCount * SUBSTEPS_PER_HOUR).fill(Number.NaN),
    usable: new Uint8Array(hourCount),
  };
}

function writeRadiation(columns: RadiationColumns, hour: number, radiation: RadiationHour | undefined) {
  columns.globalHorizontal[hour] = radiation?.globalHorizontal ?? 0;
  columns.diffuseHorizontal[hour] = radiation?.diffuseHorizontal ?? 0;
  columns.directHorizontal[hour] = radiation?.directHorizontal ?? 0;
}

function meanOf(values: Float64Array): number {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}
