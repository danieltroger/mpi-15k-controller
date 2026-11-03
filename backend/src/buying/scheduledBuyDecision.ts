import type { Config } from "../config/config.types.ts";
import { isHoldWindow } from "../autoTrading/plannerKnobBounds.ts";

/**
 * What the buy schedule asks for right now, before the hold guard — pure, so the selftest can walk a hold
 * through the SOC gate. `hitSocLimit` is the gate's hysteresis the caller carries between evaluations:
 * once a charging window took the battery to only_buy_below_soc, charging waits until the SOC is below
 * start_buying_again_below_soc.
 *
 * With hold_enabled off every window is a charging window, exactly as before holds existed. On, a window at
 * or below HOLD_CLASS_MAX_WATTS is a hold (the planner's, holdAllocation.ts, or a user window that small,
 * e.g. the manual 100 W window that measures hold_overhead_watts): it runs the house from the grid and only
 * trickles into the battery, so the SOC gate, which stops grid charging from filling the battery, doesn't
 * apply to it. A gated hold would be skipped silently: the battery would carry the house through hours the
 * plan meant to keep its energy for, and the gate's hysteresis, tripped by a trickle, would then block the
 * next real charge until the SOC fell below start_buying_again_below_soc. The planner can't plan around the
 * gate instead: holds pay most on a full battery, exactly where the gate (40 % by default) bites.
 */
export function decideScheduledBuy(
  input: BuySocGateLimits & {
    /** Each schedule entry's currently wanted watts (0 outside its window) */
    scheduledWattsPerWindow: number[];
    soc: number;
    hitSocLimit: boolean;
    /** automatic_trading.hold_enabled, corrected (plannerKnobs.ts' holdEnabledKnob) */
    holdEnabled: boolean;
  }
): ScheduledBuy {
  const limitToUse = input.hitSocLimit ? input.start_buying_again_below_soc : input.only_buy_below_soc;
  // Overlapping windows: the biggest of each class wins
  const chargingWindowWatts = highest(
    input.scheduledWattsPerWindow.filter(watts => !isHoldWindow(watts, input.holdEnabled))
  );
  const holdWatts = highest(input.scheduledWattsPerWindow.filter(watts => isHoldWindow(watts, input.holdEnabled)));

  let hitSocLimit = input.hitSocLimit;
  let chargingWatts = 0;
  if (input.soc < limitToUse) {
    hitSocLimit = false;
    chargingWatts = chargingWindowWatts;
  } else if (chargingWindowWatts) {
    // Only a charging window may hit the limit, as before holds existed
    hitSocLimit = true;
  }
  // A charging window running over a hold charges anyway (and runs the house from the grid too)
  return { chargingWatts, holdWatts: chargingWatts ? 0 : holdWatts, hitSocLimit };
}

/** What useShouldBuyPower turns into amps: the charging window's watts, else the hold's while the guard allows it */
export function wattsForInverter(scheduledBuy: ScheduledBuy, holdAllowedByGuard: boolean): number {
  if (scheduledBuy.chargingWatts) return scheduledBuy.chargingWatts;
  return holdAllowedByGuard ? scheduledBuy.holdWatts : 0;
}

export type ScheduledBuy = {
  /** A charging window's watts that passed the SOC gate, 0 when none */
  chargingWatts: number;
  /** A hold window's watts when no charging window runs over it, 0 when none (the hold guard may still veto it) */
  holdWatts: number;
  hitSocLimit: boolean;
};

export type BuySocGateLimits = Pick<
  Config["scheduled_power_buying"],
  "only_buy_below_soc" | "start_buying_again_below_soc"
>;

function highest(values: number[]): number {
  const maximum = Math.max(...values);
  return Math.abs(maximum) === Infinity ? 0 : maximum;
}
