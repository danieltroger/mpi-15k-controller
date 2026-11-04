/**
 * The solar-aware part of the terminal value (terminalValue.ts). A kWh left in the battery when the plan ends is
 * worth V, the import it saves later, only while the battery would otherwise drain. In spring, autumn and on sunny
 * winter spells the house's own PV refills the battery within a day or two after the horizon: a kWh stocked or kept
 * now then only makes the battery full sooner, and the PV it displaces is exported at whatever the grid pays.
 *
 * From the end of the plan's slots, the idle battery (simulate.ts's slot with no trade: the baseline feed while the
 * PV doesn't cover the house) is walked forward on the solar and house-load forecasts, for
 * terminal_value_solar_lookahead_hours or until either forecast ends (past the solar one no PV is assumed, which is
 * no reduction; past the house-load one the load would be missing, which is too much). An extra kWh at the start
 * keeps its fate until the battery first reaches an edge: full first, and the PV spills it; the emergency floor
 * first, and it averts an import (V); neither, and it is still in the battery when the walk ends (V). A fuller start
 * is full sooner and at the floor later, so one threshold splits the two: energy above fromWh is refilled anyway.
 * The walk runs once per plan; each simulation then credits a two-piece concave value of its end energy
 * (endEnergyCreditSek), as cheap as the flat V.
 *
 * Pure (type-only imports and a constant): the walk reads only the planner input's forecasts.
 */
import { BASELINE_FEED_SOLAR_MARGIN_WATTS } from "./simulateConstants.ts";
import type { HorizonValuation, PlannerInput, SolarRefill } from "./planner.types.ts";
import type { TerminalValuation } from "./terminalValue.ts";

const HOUR_MS = 3600_000;

/** The walk steps by the hour, as the house-load forecast does: 15-min steps would sharpen nothing */
const WALK_STEP_MS = HOUR_MS;

/**
 * A refill band (capacity − fromWh) under this share of the capacity is left out: a sliver below full the next sunny
 * hour tops off changes no decision worth having, and would swap the plan's note for one about a 100 % SOC threshold
 */
const MIN_REFILL_BAND_SHARE = 0.01;

/**
 * Main: the part of the end-of-plan energy the solar forecast past horizonEndMs refills anyway, and what a DC kWh of
 * it is worth, or undefined when nothing is to be taken off V: terminal_value_solar_scale or the look-ahead at 0,
 * no solar forecast past the horizon (PlannerInput.solarForecastEndMs), no PV surplus that fills the battery
 * before the house drains it, a band under MIN_REFILL_BAND_SHARE, or a spill value no lower than V.
 */
export function solarRefillFor(
  input: PlannerInput,
  horizonEndMs: number,
  valuation: Pick<TerminalValuation, "expectedSpot" | "endEnergySekPerKwh">
): SolarRefill | undefined {
  const knobs = input.knobs;
  const fullValueSekPerKwh = valuation.endEnergySekPerKwh;
  if (!(knobs.terminal_value_solar_scale > 0) || !(knobs.terminal_value_solar_lookahead_hours > 0)) return undefined;
  if (!(fullValueSekPerKwh > 0) || input.solarForecastEndMs === undefined) return undefined;
  const walkEndMs = Math.min(
    horizonEndMs + knobs.terminal_value_solar_lookahead_hours * HOUR_MS,
    input.solarForecastEndMs,
    input.houseLoadForecastEndMs ?? Infinity
  );
  const threshold = refillThreshold(input, horizonEndMs, walkEndMs);
  if (!threshold || input.capacityWh - threshold.fromWh < MIN_REFILL_BAND_SHARE * input.capacityWh) return undefined;
  // A DC kWh more in the battery when it is full spills 1/charge_efficiency kWh of PV, credited at the expected spot
  // plus the sell bonus: an upper estimate, as sunny-hour spot runs below the daily mean
  const spillSekPerKwh = Math.min(
    fullValueSekPerKwh,
    Math.max(0, (valuation.expectedSpot + knobs.sell_bonus_sek_per_kwh) / knobs.charge_efficiency)
  );
  const refilledSekPerKwh =
    fullValueSekPerKwh - knobs.terminal_value_solar_scale * (fullValueSekPerKwh - spillSekPerKwh);
  // A low terminal_value_scale can put V at or below the spill: then nothing is taken off
  if (!(refilledSekPerKwh < fullValueSekPerKwh - 1e-9)) return undefined;
  return { fromWh: threshold.fromWh, sekPerKwh: refilledSekPerKwh, fullAtMs: threshold.fullAtMs };
}

/**
 * What the last DC kWh the plan ends with is worth: the refill's value above fromWh, V below it. The plan's texts
 * quote it (the stocking note, a hold's reason); the decisions all go through endEnergyCreditSek.
 */
export function marginalEndEnergySekPerKwh(
  valuation: Pick<HorizonValuation, "endEnergySekPerKwh" | "solarRefill">,
  endSocWh: number
): number {
  const refill = valuation.solarRefill;
  return refill && endSocWh > refill.fromWh ? refill.sekPerKwh : valuation.endEnergySekPerKwh;
}

/**
 * What simulate credits for the energy the battery ends a plan with: V per DC kWh above the emergency floor, and
 * with a solar refill its sekPerKwh above fromWh instead. Without one, exactly the flat credit the planner had
 * before the solar refill, to the bit.
 */
export function endEnergyCreditSek(
  valuation: Pick<HorizonValuation, "endEnergySekPerKwh" | "solarRefill">,
  endSocWh: number,
  emergencyFloorWh: number
): number {
  const refill = valuation.solarRefill;
  if (!refill) return (Math.max(0, endSocWh - emergencyFloorWh) / 1000) * valuation.endEnergySekPerKwh;
  const refillFromWh = Math.max(refill.fromWh, emergencyFloorWh);
  const keptWh = Math.max(0, Math.min(endSocWh, refillFromWh) - emergencyFloorWh);
  const refilledWh = Math.max(0, endSocWh - refillFromWh);
  return (keptWh / 1000) * valuation.endEnergySekPerKwh + (refilledWh / 1000) * refill.sekPerKwh;
}

/**
 * The lowest start energy (Wh) from which the idle battery, walked from startMs to endMs, is full before it ever
 * reaches the emergency floor, and when it is full from there; undefined when no start below full is (no PV
 * surplus in the walk, or the house drains every start to the floor first) or a forecast isn't a number.
 */
function refillThreshold(
  input: PlannerInput,
  startMs: number,
  endMs: number
): { fromWh: number; fullAtMs: number } | undefined {
  const capacityWh = input.capacityWh;
  const emergencyFloorWh = (input.knobs.emergency_soc_floor_percent / 100) * capacityWh;
  // The idle battery's net DC energy since startMs, and the lowest it was before the current step
  let netWh = 0;
  let lowestNetWh = 0;
  let threshold: { fromWh: number; fullAtMs: number } | undefined;
  for (let stepStartMs = startMs; stepStartMs < endMs; stepStartMs += WALK_STEP_MS) {
    const stepEndMs = Math.min(stepStartMs + WALK_STEP_MS, endMs);
    const lowestBeforeStepWh = lowestNetWh;
    netWh += idleBatteryDeltaWh(input, stepStartMs, stepEndMs);
    if (!Number.isFinite(netWh)) return undefined;
    lowestNetWh = Math.min(lowestNetWh, netWh);
    if (netWh <= 0) continue;
    // Full at the end of this step from capacity − netWh up, and above the floor until then from
    // floor − lowestBeforeStepWh up
    const fromWh = Math.max(capacityWh - netWh, emergencyFloorWh - lowestBeforeStepWh);
    if (!threshold || fromWh < threshold.fromWh) threshold = { fromWh, fullAtMs: stepEndMs };
  }
  if (!threshold || threshold.fromWh >= capacityWh) return undefined;
  return { fromWh: Math.max(threshold.fromWh, emergencyFloorWh), fullAtMs: threshold.fullAtMs };
}

/** What the idle battery gains (DC Wh, negative = drains) over a step: buildSlots' forecasts, simulate's idle slot */
function idleBatteryDeltaWh(input: PlannerInput, startMs: number, endMs: number): number {
  const knobs = input.knobs;
  const durationH = (endMs - startMs) / HOUR_MS;
  const midMs = (startMs + endMs) / 2;
  const pvW = Math.max(0, input.solarAverageWattsBetween?.(startMs, endMs) ?? input.solarWattsAt(midMs));
  const houseW = Math.max(0, input.houseLoadWattsAt(midMs));
  const baselineFeedW =
    pvW < houseW + input.parasiticWatts + BASELINE_FEED_SOLAR_MARGIN_WATTS ? knobs.baseline_feed_watts : 0;
  const netW = pvW - houseW - input.parasiticWatts - baselineFeedW;
  return netW >= 0 ? netW * knobs.charge_efficiency * durationH : (netW / knobs.discharge_efficiency) * durationH;
}
