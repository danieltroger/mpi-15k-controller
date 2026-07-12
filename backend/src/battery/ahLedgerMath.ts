// Pure math for the Ah (coulomb-counting) SOC ledger and its online parameter tracking. No runtime
// imports on purpose: everything here is exercised by ahLedgerMath.selftest.ts without hardware or DB.

export type AnchorType = "full" | "empty" | "soft_empty";

/** An anchor event the Ah ledger can hang off: when it happened and the SOC it pins. */
export type LedgerAnchor = { at: number; soc: number; type: AnchorType };

/** Influx measurement + MQTT topic for anchor markers — shared so publish and restore can never drift. */
export const SOC_ANCHORS_MEASUREMENT = "soc_anchors";

/** A structured log request produced by the pure layer; the caller dispatches to errorLog/warnLog/logLog. */
export type ParameterLog = { level: "log" | "warn" | "error"; message: string };

/**
 * The ledger equation. `integralAh` is ∫amps·dt since the anchor (charge positive), `drainA` the
 * constant hourly amp offset to remove, `elapsedHours` the wall-clock time since the anchor.
 * Deliberately UNclamped — callers clamp only at consumption; the raw drift is wanted in Grafana.
 */
export function computeSocAh({
  anchorSoc,
  integralAh,
  drainA,
  elapsedHours,
  capacityAh,
}: {
  anchorSoc: number;
  integralAh: number;
  drainA: number;
  elapsedHours: number;
  capacityAh: number;
}): number {
  return anchorSoc + ((integralAh - drainA * elapsedHours) / capacityAh) * 100;
}

/**
 * Which online parameter a completed anchor-to-anchor span updates:
 *  - full→full: the drain (SOC returns to 100, so the net charge is exactly the drain loss).
 *  - full↔empty or full↔soft_empty: the usable capacity (a deep, known ΔSOC lever arm).
 *  - anything else (empty↔soft_empty, empty↔empty, …): nothing usable.
 */
export function classifyAnchorTransition(prevType: AnchorType, nextType: AnchorType): "drain" | "capacity" | "none" {
  if (prevType === "full" && nextType === "full") return "drain";
  const fullToLow = prevType === "full" && (nextType === "empty" || nextType === "soft_empty");
  const lowToFull = (prevType === "empty" || prevType === "soft_empty") && nextType === "full";
  if (fullToLow || lowToFull) return "capacity";
  return "none";
}

/** Hard empty is trusted more than the soft (partial-discharge) empty for capacity estimation. */
export function capacityWeightForTransition(prevType: AnchorType, nextType: AnchorType): number {
  const nonFullEnd = prevType === "full" ? nextType : prevType;
  return nonFullEnd === "empty" ? 0.25 : 0.1;
}

/** EMA weight for a drain update: longer spans (relative to tau) carry more weight, in [0, 1). */
export function drainEmaWeight(dtDays: number, tauDays: number): number {
  return 1 - Math.exp(-dtDays / tauDays);
}

/**
 * Decide what (if anything) a just-completed span teaches the ledger. Pure and total: returns the new
 * parameter value(s) to persist plus any log lines (rejections and accepted updates). Gates:
 *  - drain only from full→full spans with 6 h ≤ dt ≤ 14 d; reject |implied| > 10 A (errorLog).
 *  - capacity only from full↔empty / full↔soft_empty spans with |ΔSOC| ≥ 90 pp; sanity 1000–1500 Ah.
 */
export function computeParameterUpdates({
  prevType,
  nextType,
  prevSoc,
  nextSoc,
  dtHours,
  spanIntegralAh,
  currentDrainA,
  currentCapacityAh,
  drainEmaTauDays,
}: {
  prevType: AnchorType;
  nextType: AnchorType;
  prevSoc: number;
  nextSoc: number;
  dtHours: number;
  spanIntegralAh: number;
  currentDrainA: number;
  currentCapacityAh: number;
  drainEmaTauDays: number;
}): { drainA?: number; capacityAh?: number; logs: ParameterLog[] } {
  const logs: ParameterLog[] = [];
  const dtDays = dtHours / 24;
  const transition = classifyAnchorTransition(prevType, nextType);

  if (dtHours <= 0) return { logs }; // degenerate / out-of-order span

  if (transition === "drain") {
    if (dtHours < 6 || dtDays > 14) return { logs }; // span not in the usable full→full window
    const impliedDrainA = spanIntegralAh / dtHours;
    if (Math.abs(impliedDrainA) > 10) {
      logs.push({
        level: "error",
        message: `Ah ledger: rejecting full→full drain estimate ${impliedDrainA.toFixed(2)} A (>|10 A|); span ${dtDays.toFixed(2)} d, net ${spanIntegralAh.toFixed(1)} Ah`,
      });
      return { logs };
    }
    const weight = drainEmaWeight(dtDays, drainEmaTauDays);
    const drainA = (1 - weight) * currentDrainA + weight * impliedDrainA;
    logs.push({
      level: "log",
      message: `Ah ledger: drain ${currentDrainA.toFixed(3)}→${drainA.toFixed(3)} A (implied ${impliedDrainA.toFixed(3)}, w ${weight.toFixed(3)}, span ${dtDays.toFixed(2)} d)`,
    });
    return { drainA, logs };
  }

  if (transition === "capacity") {
    const deltaSocPp = nextSoc - prevSoc;
    if (Math.abs(deltaSocPp) < 90) return { logs }; // not a deep enough span to identify capacity
    const impliedCapacityAh = Math.abs(spanIntegralAh - currentDrainA * dtHours) / (Math.abs(deltaSocPp) / 100);
    if (impliedCapacityAh < 1000 || impliedCapacityAh > 1500) {
      logs.push({
        level: "error",
        message: `Ah ledger: rejecting capacity estimate ${impliedCapacityAh.toFixed(0)} Ah (outside 1000–1500); span ${dtDays.toFixed(2)} d, ΔSOC ${deltaSocPp.toFixed(1)} pp`,
      });
      return { logs };
    }
    const weight = capacityWeightForTransition(prevType, nextType);
    const capacityAh = (1 - weight) * currentCapacityAh + weight * impliedCapacityAh;
    logs.push({
      level: "log",
      message: `Ah ledger: capacity ${currentCapacityAh.toFixed(0)}→${capacityAh.toFixed(0)} Ah (implied ${impliedCapacityAh.toFixed(0)}, w ${weight}, ΔSOC ${deltaSocPp.toFixed(1)} pp)`,
    });
    return { capacityAh, logs };
  }

  return { logs };
}
