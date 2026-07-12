// Shared, pure anchor predicates so the Wh path (useLastFullAndEmpty) and the Ah path
// (anchorDetection) can never drift on what "full"/"empty" means. Hall sensor 2 amps, positive =
// charging; both take already-1-min-smoothed amps.

/** Full: held at the full setpoint while the (smoothed) charge current has tapered below the stop threshold. */
export function fullConditionMet(
  voltageVolts: number,
  smoothedAmps: number,
  fullBatteryVoltage: number,
  stopChargingBelowCurrent: number
): boolean {
  return voltageVolts >= fullBatteryVoltage && smoothedAmps < stopChargingBelowCurrent;
}

/** Empty: terminal voltage has sagged to (or below) the hard-empty voltage. */
export function emptyConditionMet(voltageVolts: number, batteryEmptyAtVoltage: number): boolean {
  return voltageVolts <= batteryEmptyAtVoltage;
}
