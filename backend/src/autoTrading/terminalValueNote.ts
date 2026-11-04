/**
 * The plan note on the terminal value (terminalValue.ts, terminalValueSolar.ts), which the Trading page shows with
 * the plan's other notes. Pure (type-only imports).
 */
import type { HorizonValuation, PlannerInput, SimResult } from "./planner.types.ts";
import type { TerminalValuationResult } from "./terminalValue.ts";

/**
 * Main: what end-of-plan energy is worth (and above which SOC the solar forecast refills it anyway) and what the
 * plan leaves, or why it has none; undefined while the terminal value doesn't apply
 */
export function terminalValueNote(
  input: PlannerInput,
  terminal: TerminalValuationResult,
  horizon: HorizonValuation,
  finalResult: SimResult
): string | undefined {
  if (terminal.unavailable) return `End-of-plan energy not valued: ${terminal.unavailable}`;
  const valuation = terminal.valuation;
  if (!valuation) return undefined;
  const refill = horizon.solarRefill;
  const leftKwh = endEnergyLeftKwh(input, valuation.endEnergySekPerKwh, horizon, finalResult);
  const leftOver = `the ${leftKwh.toFixed(1)} kWh left above the emergency floor are worth ${finalResult.endEnergyValueSek.toFixed(1)} SEK, not counted in the revenue figures`;
  if (!refill) {
    return `End-of-plan energy valued at ${valuation.endEnergySekPerKwh.toFixed(2)} SEK/kWh (${valuation.basis}): ${leftOver}`;
  }
  const refillFromPercent = ((refill.fromWh / input.capacityWh) * 100).toFixed(0);
  const fullAt = `${new Date(refill.fullAtMs).toISOString().slice(0, 16)}Z`;
  return `End-of-plan energy valued at ${valuation.endEnergySekPerKwh.toFixed(2)} SEK/kWh (${valuation.basis}), above ${refillFromPercent} % SOC at ${refill.sekPerKwh.toFixed(2)}: the solar forecast fills the battery from there by ${fullAt} anyway (solar scale ${input.knobs.terminal_value_solar_scale}); ${leftOver}`;
}

/**
 * The kWh above the emergency floor the plan ends with. Without a solar refill read back from the credit, as the
 * note always did, so such a plan's note stays the same to the character.
 */
function endEnergyLeftKwh(
  input: PlannerInput,
  endEnergySekPerKwh: number,
  horizon: HorizonValuation,
  finalResult: SimResult
): number {
  if (!horizon.solarRefill) return endEnergySekPerKwh > 0 ? finalResult.endEnergyValueSek / endEnergySekPerKwh : 0;
  const emergencyFloorWh = (input.knobs.emergency_soc_floor_percent / 100) * input.capacityWh;
  return Number.isFinite(finalResult.endSocWh) ? Math.max(0, finalResult.endSocWh - emergencyFloorWh) / 1000 : 0;
}
