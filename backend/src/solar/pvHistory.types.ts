/**
 * Inverter telemetry as consecutive hours of six 10-min bins, columnar (bin arrays are hour-major,
 * SUBSTEPS_PER_HOUR per hour). Pure types.
 */
export type PvHistoryColumns = {
  firstHourMs: number;
  hourCount: number;
  /** NaN where a bin had no data */
  mppt1Watts: Float64Array;
  mppt2Watts: Float64Array;
  mppt1Volts: Float64Array;
  mppt2Volts: Float64Array;
  /** 1 = the bin received any inverter frame at all */
  binHasData: Uint8Array;
  /** Per hour; −Infinity without data */
  batteryVoltsMax: Float64Array;
  /** Per hour, + = importing; NaN without data */
  gridWattsMean: Float64Array;
  /** Per hour; NaN without data */
  socPercentMax: Float64Array;
};

/** An irradiance archive aligned to the same hour grid (NaN = hour missing from the source). */
export type RadiationArchiveColumns = {
  globalHorizontal: Float64Array;
  diffuseHorizontal: Float64Array;
  directHorizontal: Float64Array;
  snowfallCm: Float64Array;
  snowDepthMetres: Float64Array;
};
