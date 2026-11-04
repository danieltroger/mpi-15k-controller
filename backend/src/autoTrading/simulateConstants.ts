/**
 * Constants of the planner's battery model that the simulation (simulate.ts) shares with the solar refill's walk
 * (terminalValueSolar.ts), so the walk drains the idle battery as the plan does. No imports.
 */

/** The idle slot feeds the baseline night feed unless the PV covers the house, the inverter's idle draw and this margin */
export const BASELINE_FEED_SOLAR_MARGIN_WATTS = 380;
