/**
 * Self-test of runPlan's abort check after the expected spot (planRun.ts): automatic trading switched off while
 * the estimate is still fetching (with "forecast" that is routinely the trailing days plus a 30–120 s wait)
 * must not get the plan's windows written. No network and no files: the price API is stubbed and switches
 * trading off on its first request, and the schedule lock is held for good, so a plan that went on would hang
 * there (caught by a timeout) instead of writing anything. Run from backend/ with:
 *   yarn node src/autoTrading/planRunAbort.selftest.ts
 */
import { default_config } from "../config/config.ts";
import { runPlan } from "./planRun.ts";
import { check, EVERY_MONTH, finishSelftest, mkPrices, testDayStartMs, HOUR_MS } from "./plannerSelftestFixtures.ts";
import type { Config } from "../config/config.types.ts";
import type { TraderCtx } from "./traderContext.ts";

const config: Config = {
  ...default_config,
  // In season whatever day this runs: the trailing estimate fetches past days' prices, where the abort lands
  automatic_trading: {
    ...default_config.automatic_trading,
    terminal_value_mode: "trailing",
    terminal_value_months: EVERY_MONTH,
  },
};
const ctx: TraderCtx = {
  config: () => config,
  setConfig: (() => {
    throw new Error("setConfig called: the aborted plan wrote the schedule");
  }) as unknown as TraderCtx["setConfig"],
  clampedSocAh: () => 50,
  gridPowerReading: () => undefined,
  influxClient: (() => undefined) as unknown as TraderCtx["influxClient"],
  enabled: () => false,
  nextDailyRunAt: () => undefined,
  setStatus: () => {},
  state: { owned_entries: { selling: {}, buying: {} }, vetoes: [], forecast_log: {} },
  flags: { stateLoaded: true, planInFlight: false, aborted: false, consecutiveFailures: 0, measuredFeedInStale: false },
  timers: {},
  // Never released: nothing may get past the abort check to the schedule
  scheduleLock: new Promise(() => {}),
};

let priceRequests = 0;
globalThis.fetch = (async () => {
  priceRequests++;
  ctx.flags.aborted = true; // the trader is switched off while the estimate fetches
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const slots = mkPrices(48, () => 1);
const result = await Promise.race([
  runPlan(ctx, {
    trigger: "selftest",
    waitForTomorrow: false,
    prices: { slots, coversTomorrow: true, fetchedAtMs: testDayStartMs, horizonEndMs: testDayStartMs + 48 * HOUR_MS },
  }),
  new Promise<string>(resolve => setTimeout(() => resolve("hung: the plan went on to the schedule lock"), 3000)),
]);
check(
  "abort: trading switched off during the estimate's wait → the plan stops before the schedule lock",
  result === "aborted" && priceRequests > 0 && !ctx.flags.planInFlight && ctx.state.last_plan === undefined,
  `(${result}, ${priceRequests} price requests)`
);

finishSelftest();
