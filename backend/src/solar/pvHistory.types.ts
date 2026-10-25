/** One hour of inverter telemetry as six 10-minute bins (NaN where a bin had no data). Pure types. */
export type PvHistoryHour = {
  hourStartMs: number;
  mppt1Watts: number[];
  mppt2Watts: number[];
  mppt1Volts: number[];
  mppt2Volts: number[];
  /** The bin received any inverter frame at all */
  binHasData: boolean[];
  batteryVoltsMax: number;
  /** + = importing */
  gridWattsMean: number;
  socPercentMax: number;
};
