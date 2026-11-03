/**
 * Self-test of the same-instant schedule transitions (batchedRunAtFutureTimeWithPriority.ts): a hold window
 * ending as a sell window starts, and a sell ending as a hold starts, must never show a computation an
 * import and an export at once (feedWhenNoSolar errorLogs that, a P2 push), and two sell windows meeting
 * must never show 0 in between (a restarted feed-in ramp). Run from backend/ with:
 *   yarn node src/utilities/batchedRunAtFutureTimeWithPriority.selftest.ts
 */
import process from "process";
import { createEffect, createRoot, createSignal } from "solid-js";
import { batchedRunAtFutureTimeWithPriority } from "./batchedRunAtFutureTimeWithPriority.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

const startMs = Date.now();
const buyToHoldMs = startMs + 30;
const holdToSellMs = startMs + 60;
const sellToHoldMs = startMs + 120;
const sellToSellMs = startMs + 180;

const observations = createRoot(() => {
  // What shouldSellPower and useShouldBuyPower publish: one signal per schedule entry, the consumer takes the max
  const [blockWatts, setBlockWatts] = createSignal(15000);
  const [holdWatts, setHoldWatts] = createSignal(0);
  const [eveningHoldWatts, setEveningHoldWatts] = createSignal(0);
  const [morningSellWatts, setMorningSellWatts] = createSignal(0);
  const [eveningSellWatts, setEveningSellWatts] = createSignal(0);
  const [lateSellWatts, setLateSellWatts] = createSignal(0);
  const seen: { importWatts: number; exportWatts: number }[] = [];
  createEffect(() => {
    seen.push({
      importWatts: Math.max(blockWatts(), holdWatts(), eveningHoldWatts()),
      exportWatts: Math.max(morningSellWatts(), eveningSellWatts(), lateSellWatts()),
    });
  });
  // A 15 kW buy block chaining into a hold, the hold until holdToSellMs, then a sell until sellToHoldMs, then a
  // hold; and a second pair of sells meeting
  batchedRunAtFutureTimeWithPriority(() => setHoldWatts(100), buyToHoldMs, true);
  batchedRunAtFutureTimeWithPriority(() => setBlockWatts(0), buyToHoldMs, false);
  batchedRunAtFutureTimeWithPriority(() => setMorningSellWatts(15000), holdToSellMs, true);
  batchedRunAtFutureTimeWithPriority(() => setHoldWatts(0), holdToSellMs, false);
  batchedRunAtFutureTimeWithPriority(() => setEveningHoldWatts(100), sellToHoldMs, true);
  batchedRunAtFutureTimeWithPriority(() => setMorningSellWatts(0), sellToHoldMs, false);
  batchedRunAtFutureTimeWithPriority(() => setEveningHoldWatts(0), sellToSellMs - 30, false);
  batchedRunAtFutureTimeWithPriority(() => setEveningSellWatts(15000), sellToSellMs - 30, true);
  batchedRunAtFutureTimeWithPriority(() => setLateSellWatts(10000), sellToSellMs, true);
  batchedRunAtFutureTimeWithPriority(() => setEveningSellWatts(0), sellToSellMs, false);
  return seen;
});

setTimeout(
  () => {
    check(
      "no moment shows an import and an export at once",
      observations.every(({ importWatts, exportWatts }) => !(importWatts > 0 && exportWatts > 0)),
      `(${JSON.stringify(observations)})`
    );
    const exportsAfterFirstSell = observations.slice(observations.findIndex(({ exportWatts }) => exportWatts > 0));
    const sellToSellIndex = exportsAfterFirstSell.findIndex(({ exportWatts }) => exportWatts === 10000);
    check(
      "sell → sell at one instant goes straight from 15 kW to 10 kW",
      sellToSellIndex > 0 && exportsAfterFirstSell[sellToSellIndex - 1].exportWatts === 15000
    );
    check(
      "every transition landed: buy block → hold (a power step, never 0: no window end) → sell → hold → sell → sell",
      JSON.stringify(observations.map(({ importWatts, exportWatts }) => [importWatts, exportWatts])) ===
        JSON.stringify([
          [15000, 0],
          [100, 0],
          [0, 15000],
          [100, 0],
          [0, 15000],
          [0, 10000],
        ])
    );
    console.log(failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll passed");
    process.exit(failedChecks.length ? 1 : 0);
  },
  sellToSellMs + 100 - Date.now()
);
