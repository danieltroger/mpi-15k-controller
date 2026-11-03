import type { TemperatureReadingBroadcast } from "../sharedTypes.ts";

/**
 * Which thermometers sit on the battery: the cell and bus-bar probes (cooling_* probes sit on the
 * inverter's air path). Shared by the battery-temperature alerts and the hold guard, so the guard keeps
 * a hold away from exactly the probes the "Charging a freezing battery" P1 reads.
 */
export function isBatteryProbe(reading: TemperatureReadingBroadcast): boolean {
  return reading.label.startsWith("cell") || reading.label.includes("bus_bar");
}

/** Every battery probe's latest reading, those without one left out */
export function batteryProbeReadings(
  readings: readonly (TemperatureReadingBroadcast | undefined)[]
): TemperatureReadingBroadcast[] {
  return readings.filter((reading): reading is TemperatureReadingBroadcast => !!reading && isBatteryProbe(reading));
}
