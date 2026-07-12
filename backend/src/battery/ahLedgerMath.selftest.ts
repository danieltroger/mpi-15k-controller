/**
 * Pure self-test for the Ah ledger math (no hardware, no DB). Run from backend/ with:
 *   yarn node src/battery/ahLedgerMath.selftest.ts
 */
import {
  computeSocAh,
  classifyAnchorTransition,
  capacityWeightForTransition,
  drainEmaWeight,
  computeParameterUpdates,
} from "./ahLedgerMath.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}
function approx(actual: number, expected: number, epsilon = 0.001): boolean {
  return Math.abs(actual - expected) < epsilon;
}

// ---------- computeSocAh ----------
{
  // 620 Ah discharged + 2.8 A drain over 10 h out of 1240 Ah, from a full anchor.
  const soc = computeSocAh({ anchorSoc: 100, integralAh: -620, drainA: 2.8, elapsedHours: 10, capacityAh: 1240 });
  check("computeSocAh: discharge from full", approx(soc, 47.742, 0.01), `(${soc.toFixed(3)})`);
  // At the instant of anchoring (no integral, no elapsed) SOC equals the anchor SOC exactly.
  check(
    "computeSocAh: at anchor == anchor soc",
    computeSocAh({ anchorSoc: 0.4, integralAh: 0, drainA: 2.8, elapsedHours: 0, capacityAh: 1240 }) === 0.4
  );
}

// ---------- classifyAnchorTransition ----------
{
  check("classify full→full = drain", classifyAnchorTransition("full", "full") === "drain");
  check("classify full→empty = capacity", classifyAnchorTransition("full", "empty") === "capacity");
  check("classify full→soft_empty = capacity", classifyAnchorTransition("full", "soft_empty") === "capacity");
  check("classify empty→full = capacity", classifyAnchorTransition("empty", "full") === "capacity");
  check("classify soft_empty→full = capacity", classifyAnchorTransition("soft_empty", "full") === "capacity");
  check("classify empty→soft_empty = none", classifyAnchorTransition("empty", "soft_empty") === "none");
  check("classify soft_empty→empty = none", classifyAnchorTransition("soft_empty", "empty") === "none");
  check("classify soft_empty→soft_empty = none", classifyAnchorTransition("soft_empty", "soft_empty") === "none");
  check("classify empty→empty = none", classifyAnchorTransition("empty", "empty") === "none");
}

// ---------- capacityWeightForTransition ----------
{
  check(
    "weight full↔empty = 0.25",
    capacityWeightForTransition("full", "empty") === 0.25 && capacityWeightForTransition("empty", "full") === 0.25
  );
  check(
    "weight full↔soft_empty = 0.10",
    capacityWeightForTransition("full", "soft_empty") === 0.1 &&
      capacityWeightForTransition("soft_empty", "full") === 0.1
  );
}

// ---------- drainEmaWeight ----------
{
  check("drainEmaWeight(0) = 0", drainEmaWeight(0, 7) === 0);
  check(
    "drainEmaWeight(7,7) = 1-1/e",
    approx(drainEmaWeight(7, 7), 1 - Math.exp(-1)),
    `(${drainEmaWeight(7, 7).toFixed(4)})`
  );
  check(
    "drainEmaWeight monotone in dt",
    drainEmaWeight(1, 7) < drainEmaWeight(3, 7) && drainEmaWeight(3, 7) < drainEmaWeight(10, 7)
  );
  // Across the whole usable full→full span range (6 h … 14 d) the weight stays a proper fraction < 1.
  check(
    "drainEmaWeight < 1 over usable span",
    drainEmaWeight(6 / 24, 7) > 0 && drainEmaWeight(14, 7) < 1,
    `(${drainEmaWeight(14, 7).toFixed(4)})`
  );
}

// ---------- computeParameterUpdates: drain ----------
{
  // full→full over 1 day, implied drain 2.8 A, EMA from 2.0 with tau 7.
  const result = computeParameterUpdates({
    prevType: "full",
    nextType: "full",
    prevSoc: 100,
    nextSoc: 100,
    dtHours: 24,
    spanIntegralAh: 2.8 * 24,
    currentDrainA: 2.0,
    currentCapacityAh: 1240,
    drainEmaTauDays: 7,
  });
  check("drain: accepted, no capacity", result.drainA !== undefined && result.capacityAh === undefined);
  check(
    "drain: EMA value",
    result.drainA !== undefined && approx(result.drainA, 2.1065, 0.001),
    `(${result.drainA?.toFixed(4)})`
  );
  check("drain: emits a log line", result.logs.length === 1 && result.logs[0].level === "log");
}
{
  // Span too short (<6 h) → skipped silently.
  const short = computeParameterUpdates({
    prevType: "full",
    nextType: "full",
    prevSoc: 100,
    nextSoc: 100,
    dtHours: 3,
    spanIntegralAh: 8,
    currentDrainA: 2.0,
    currentCapacityAh: 1240,
    drainEmaTauDays: 7,
  });
  check("drain: <6 h skipped", short.drainA === undefined && short.logs.length === 0);
  // Span too long (>14 d) → skipped silently.
  const long = computeParameterUpdates({
    prevType: "full",
    nextType: "full",
    prevSoc: 100,
    nextSoc: 100,
    dtHours: 15 * 24,
    spanIntegralAh: 1000,
    currentDrainA: 2.0,
    currentCapacityAh: 1240,
    drainEmaTauDays: 7,
  });
  check("drain: >14 d skipped", long.drainA === undefined && long.logs.length === 0);
  // Implausible implied drain (>10 A) → rejected with an error log, no update.
  const rejected = computeParameterUpdates({
    prevType: "full",
    nextType: "full",
    prevSoc: 100,
    nextSoc: 100,
    dtHours: 6,
    spanIntegralAh: 66,
    currentDrainA: 2.0,
    currentCapacityAh: 1240,
    drainEmaTauDays: 7,
  });
  check(
    "drain: |implied|>10 rejected",
    rejected.drainA === undefined && rejected.logs.length === 1 && rejected.logs[0].level === "error"
  );
}

// ---------- computeParameterUpdates: capacity ----------
{
  // full→empty, ΔSOC -100, implied capacity |−1140 − 2.5·40| = 1240, EMA from 1200 with weight 0.25.
  const result = computeParameterUpdates({
    prevType: "full",
    nextType: "empty",
    prevSoc: 100,
    nextSoc: 0,
    dtHours: 40,
    spanIntegralAh: -1140,
    currentDrainA: 2.5,
    currentCapacityAh: 1200,
    drainEmaTauDays: 7,
  });
  check("capacity: accepted, no drain", result.capacityAh !== undefined && result.drainA === undefined);
  check(
    "capacity: EMA value",
    result.capacityAh !== undefined && approx(result.capacityAh, 1210, 0.001),
    `(${result.capacityAh?.toFixed(2)})`
  );
  check(
    "capacity: soft_empty weight 0.10",
    (() => {
      const r = computeParameterUpdates({
        prevType: "full",
        nextType: "soft_empty",
        prevSoc: 100,
        nextSoc: 0.4,
        dtHours: 40,
        spanIntegralAh: -1140,
        currentDrainA: 2.5,
        currentCapacityAh: 1200,
        drainEmaTauDays: 7,
      });
      // implied ≈ |−1140 − 100| / (99.6/100) = 1240/0.996 = 1244.98; EMA 0.9·1200 + 0.1·1244.98 = 1204.5
      return r.capacityAh !== undefined && approx(r.capacityAh, 1204.5, 0.1);
    })()
  );
}
{
  // |ΔSOC| < 90 → not a deep enough span, skipped.
  const shallow = computeParameterUpdates({
    prevType: "full",
    nextType: "empty",
    prevSoc: 100,
    nextSoc: 15,
    dtHours: 40,
    spanIntegralAh: -1000,
    currentDrainA: 2.5,
    currentCapacityAh: 1200,
    drainEmaTauDays: 7,
  });
  check("capacity: |ΔSOC|<90 skipped", shallow.capacityAh === undefined && shallow.logs.length === 0);
  // Implied capacity outside 1000–1500 → rejected with an error log.
  const insane = computeParameterUpdates({
    prevType: "full",
    nextType: "empty",
    prevSoc: 100,
    nextSoc: 0,
    dtHours: 40,
    spanIntegralAh: -2000,
    currentDrainA: 2.5,
    currentCapacityAh: 1200,
    drainEmaTauDays: 7,
  });
  check(
    "capacity: out-of-range rejected",
    insane.capacityAh === undefined && insane.logs.length === 1 && insane.logs[0].level === "error"
  );
}

// ---------- computeParameterUpdates: none transitions do nothing ----------
{
  const none = computeParameterUpdates({
    prevType: "empty",
    nextType: "soft_empty",
    prevSoc: 0,
    nextSoc: 0.4,
    dtHours: 5,
    spanIntegralAh: 3,
    currentDrainA: 2.5,
    currentCapacityAh: 1200,
    drainEmaTauDays: 7,
  });
  check(
    "none: no updates, no logs",
    none.drainA === undefined && none.capacityAh === undefined && none.logs.length === 0
  );
}

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nAll ledger-math checks passed");
process.exit(fails.length ? 1 : 0);
