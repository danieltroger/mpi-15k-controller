import { untrack } from "solid-js";
import type { get_config_object } from "../config/config.ts";
import { computeParameterUpdates, type LedgerAnchor } from "./ahLedgerMath.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";

/**
 * Feeds a just-completed anchor→anchor span to the pure EMA logic, emits its log lines, and persists any
 * accepted drain/capacity update into config (like the Wh fitter persists current_state). Updates apply
 * FORWARD ONLY: this runs at a re-anchor, where the ledger is about to snapshot the fresh config values
 * for the new span, so a changed parameter never retroactively re-scores the span that just ended.
 */
export function applyParameterTracking({
  previousAnchor,
  nextAnchor,
  spanIntegralAh,
  config,
  setConfig,
}: {
  previousAnchor: LedgerAnchor;
  nextAnchor: LedgerAnchor;
  spanIntegralAh: number;
  config: Awaited<ReturnType<typeof get_config_object>>[0];
  setConfig: Awaited<ReturnType<typeof get_config_object>>[1];
}) {
  const ahLedgerConfig = untrack(() => config().soc_calculations.ah_ledger);

  const { drainA, capacityAh, logs } = computeParameterUpdates({
    prevType: previousAnchor.type,
    nextType: nextAnchor.type,
    prevSoc: previousAnchor.soc,
    nextSoc: nextAnchor.soc,
    dtHours: (nextAnchor.at - previousAnchor.at) / 1000 / 60 / 60,
    spanIntegralAh,
    currentDrainA: ahLedgerConfig.drain_a,
    currentCapacityAh: ahLedgerConfig.capacity_ah,
    drainEmaTauDays: ahLedgerConfig.drain_ema_tau_days,
  });

  for (const entry of logs) {
    if (entry.level === "error") errorLog(entry.message);
    else if (entry.level === "warn") warnLog(entry.message);
    else logLog(entry.message);
  }

  if (drainA === undefined && capacityAh === undefined) return;

  setConfig(previous => ({
    ...previous,
    soc_calculations: {
      ...previous.soc_calculations,
      ah_ledger: {
        ...previous.soc_calculations.ah_ledger,
        ...(drainA !== undefined ? { drain_a: drainA } : {}),
        ...(capacityAh !== undefined ? { capacity_ah: capacityAh } : {}),
      },
    },
  }));
}
