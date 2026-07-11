import { type Accessor, createEffect, createMemo, onCleanup } from "solid-js";
import { fetchPrices } from "./priceService.ts";
import { warnLog } from "../utilities/logging.ts";
import type { Config } from "../config/config.types.ts";

/**
 * Keeps the day-ahead price cache (and the `spotPrices` ws broadcast) warm for the frontend's
 * price/plan chart, independent of whether automatic trading is enabled — the trader's own fetches
 * share the same 20-minute cache in priceService, so this adds at most a couple of tiny HTTP GETs
 * per half hour and usually none while the trading guard is active.
 */
export function pollSpotPricesForFrontend(config: Accessor<Config>) {
  const priceArea = createMemo(() => config().automatic_trading?.price_area);
  createEffect(() => {
    const area = priceArea();
    if (!area) return;
    const refetch = () =>
      void fetchPrices(area).catch(e => warnLog("Spot price poll for the frontend chart failed", e));
    refetch();
    const timer = setInterval(refetch, 30 * 60_000);
    onCleanup(() => clearInterval(timer));
  });
}
