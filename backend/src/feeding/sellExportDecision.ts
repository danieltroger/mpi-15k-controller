import type { Config } from "../config/config.types.ts";

/**
 * What scheduled selling asks the inverter to export right now — pure, so the selftest can walk a
 * live sell window through an overheat. `hitLimit` is the SOC/voltage hysteresis the caller carries
 * between evaluations: once a window ran the battery down to the only_sell_above_* cutoff, selling
 * waits for the higher start_selling_again_above_* levels.
 */
export function decideSellExport(
  input: SellExportLimits & {
    /** Each schedule entry's currently wanted watts (0 outside its window) */
    scheduledWattsPerWindow: number[];
    soc: number;
    voltage: number;
    hitLimit: boolean;
    sellingStoppedForOverheat: boolean;
  }
): SellExportDecision {
  const socLimit = input.hitLimit ? input.start_selling_again_above_soc : input.only_sell_above_soc;
  const voltageLimit = input.hitLimit ? input.start_selling_again_above_voltage : input.only_sell_above_voltage;

  // Overlapping windows: the biggest one wins
  const highestScheduledWatts = Math.max(...input.scheduledWattsPerWindow);
  const scheduledWatts = Math.abs(highestScheduledWatts) === Infinity ? 0 : highestScheduledWatts;

  // Only sell if we're above BOTH soc and voltage limits
  const aboveLimits = input.soc > socLimit && input.voltage > voltageLimit;
  let hitLimit = input.hitLimit;
  if (aboveLimits) {
    hitLimit = false;
  } else if (scheduledWatts) {
    // Only allow hitting limit while a window wants to sell
    hitLimit = true;
  }

  // The overheat stop masks the output only: the SOC/voltage hysteresis above evolves exactly as if
  // it weren't there, so a window resuming after the inverter cooled still honors a cutoff it hit.
  // 0 is also what a window's end or a SOC cutoff produce, so feedWhenNoSolar takes its well-worn
  // path: max feed-in power drops straight back to feed_amount_watts, no new command sequence.
  const wouldExportWatts = aboveLimits ? scheduledWatts : 0;
  return input.sellingStoppedForOverheat
    ? { exportWatts: 0, withheldForOverheatWatts: wouldExportWatts, hitLimit }
    : { exportWatts: wouldExportWatts, withheldForOverheatWatts: 0, hitLimit };
}

export type SellExportDecision = {
  exportWatts: number;
  /** What the overheat stop is holding back — 0 when nothing was curtailed (no window, or below a cutoff) */
  withheldForOverheatWatts: number;
  hitLimit: boolean;
};

export type SellExportLimits = Pick<
  Config["scheduled_power_selling"],
  | "only_sell_above_soc"
  | "start_selling_again_above_soc"
  | "only_sell_above_voltage"
  | "start_selling_again_above_voltage"
>;
