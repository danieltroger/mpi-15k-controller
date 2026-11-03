import type { PriceSlot15 } from "./planner.types.ts";

/**
 * Wire shape of the `spotPrices` ws accessor (latest successful day-ahead fetch). Lives in a pure
 * types file (no runtime imports) so the frontend price chart can import it directly and the two
 * sides can't drift — see CLAUDE.md on shared ws types.
 */
export type FetchedPrices = {
  slots: PriceSlot15[];
  /** Whether `slots` hold any of tomorrow's (the next Stockholm calendar day's) prices, i.e. they're published */
  coversTomorrow: boolean;
  fetchedAtMs: number;
  horizonEndMs: number;
};
