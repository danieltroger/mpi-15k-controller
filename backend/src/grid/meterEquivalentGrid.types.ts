/**
 * The inverter's grid reading and what the utility meter would count for it (grid/meterEquivalentGrid.ts).
 * Pure types, no runtime imports: shared across the ws boundary (the live store's derived fields).
 */

/** PS "DC/AC power direction": "Idle" while the house passes straight through from the grid */
export type ConverterDirection = "DC to AC" | "AC to DC" | "Idle";

/** One grid reading as the inverter reports it: a PS round, or a short mean of them */
export type InverterGridReading = {
  /**
   * ac_input_total_active_power after fixMpiAcInputFields: the three phases summed, R's sign repaired
   * (the meter sums the phases too). Positive = importing, negative = exporting, exactly 0 = no exchange
   * (grid switched off, or the inverter's AC input relay open).
   */
  phase_sum_watts: number;
  converter_direction: ConverterDirection;
};

/**
 * What the meter's import and export registers would count for a reading, in watts: each ≥ 0, at most one of
 * them non-zero. Published as their own fields next to the raw ones; the raw reading is never overwritten.
 */
export type MeterEquivalentGrid = {
  meter_equivalent_grid_import_watts: number;
  meter_equivalent_grid_export_watts: number;
};

export type MeterEquivalentGridFieldName = keyof MeterEquivalentGrid;
