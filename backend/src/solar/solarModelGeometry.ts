import type { SolarModelConfig, SolarStringSpec } from "../config/config.types.ts";
import type { StringGeometry } from "./pvFit.types.ts";
import type { SolarModelState, SolarStringKey } from "./solarModel.types.ts";

/** The configured geometry and current-cap ceiling per string, as the fit and the forecast use them. */
export function stringGeometries(solarModel: SolarModelConfig): Record<SolarStringKey, StringGeometry> {
  return { string1: geometryOf(solarModel.string1), string2: geometryOf(solarModel.string2) };
}

/** A fitted mask only means something for the geometry it was fitted with — an edited tilt invalidates it. */
export function fittedGeometryMatches(state: SolarModelState, solarModel: SolarModelConfig): boolean {
  return (["string1", "string2"] as const).every(
    stringKey =>
      state.geometry[stringKey]?.tilt_degrees === solarModel[stringKey].tilt_degrees &&
      state.geometry[stringKey]?.azimuth_degrees === solarModel[stringKey].azimuth_degrees
  );
}

function geometryOf(spec: SolarStringSpec): StringGeometry {
  return {
    tilt_degrees: spec.tilt_degrees,
    azimuth_degrees: spec.azimuth_degrees,
    ceiling_watts: spec.max_current_amps * spec.typical_mpp_volts,
  };
}
