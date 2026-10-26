// Pure "which anchor does the Ah ledger hang off" logic, including the rule that it hangs off nothing while
// the anchor history is still unanswered. Only type imports, so latestAnchorSelection.selftest.ts runs it
// without a database.

import type { AnchorType, LedgerAnchor } from "./ahLedger.types.ts";

/** What InfluxDB said about one anchor kind's last occurrence before the ledger started. */
export type RestoredAnchorTime =
  /** The query hasn't answered yet (InfluxDB down or still booting): this kind's history is unknown. */
  | { status: "awaiting_database" }
  /** InfluxDB answered: no such event before the ledger started (or no InfluxDB is configured at all). */
  | { status: "none_recorded" }
  | { status: "recorded"; at: number };

export const AWAITING_DATABASE: RestoredAnchorTime = { status: "awaiting_database" };
export const NONE_RECORDED: RestoredAnchorTime = { status: "none_recorded" };

/**
 * A restored anchor's span starts in InfluxDB (its charge integral up to ledger start is queried), a live
 * one's is accumulated locally from the moment it fired.
 */
export type AnchorOrigin = "live" | "restored";
export type SelectedAnchor = LedgerAnchor & { origin: AnchorOrigin };

export const ANCHOR_TYPES: readonly AnchorType[] = ["full", "empty", "soft_empty"];

/**
 * The anchor the ledger hangs off: the most recent event, tagged with the SOC it pins.
 *
 * A live event wins outright. The restore queries only look at history from before the ledger started, so
 * every live event is newer than anything they can return — decided by origin rather than by comparing
 * timestamps, because live events carry the pi's clock (stale until NTP syncs) and restored ones the
 * database's.
 *
 * Restored times only count once EVERY kind's history has answered. Anchoring on whichever kinds happen
 * to have answered picks an older anchor whenever the newest one's query is still failing: on the
 * 2026-10-23 power cycle the failed marker queries fell through to older voltage-based anchors and the SOC
 * jumped from 34.0 % to 19.3 %. Until the history is complete the SOC stays unknown instead.
 */
export function selectLatestAnchor({
  liveEventAt,
  restoredAt,
  softEmptySocPercent,
}: {
  liveEventAt: Record<AnchorType, number | undefined>;
  restoredAt: Record<AnchorType, RestoredAnchorTime>;
  softEmptySocPercent: number;
}): SelectedAnchor | undefined {
  const liveAnchors: SelectedAnchor[] = [];
  const restoredAnchors: SelectedAnchor[] = [];
  for (const type of ANCHOR_TYPES) {
    const soc = anchorSocPercent(type, softEmptySocPercent);
    const liveAt = liveEventAt[type];
    if (liveAt !== undefined) liveAnchors.push({ at: liveAt, soc, type, origin: "live" });
    const restored = restoredAt[type];
    if (restored.status === "recorded") restoredAnchors.push({ at: restored.at, soc, type, origin: "restored" });
  }
  if (liveAnchors.length) return latestOf(liveAnchors);
  const historyComplete = ANCHOR_TYPES.every(type => restoredAt[type].status !== "awaiting_database");
  if (!historyComplete || !restoredAnchors.length) return undefined;
  return latestOf(restoredAnchors);
}

/**
 * Full/empty restore from the explicit `soc_anchors` marker, falling back to the voltage-based query only
 * when InfluxDB has answered that no marker exists (first deploy). A marker whose query hasn't answered
 * yet holds the decision: it may well be newer than anything the voltage fallback finds.
 */
export function markerOrVoltageFallback(
  marker: RestoredAnchorTime,
  voltageFallback: RestoredAnchorTime
): RestoredAnchorTime {
  return marker.status === "none_recorded" ? voltageFallback : marker;
}

/** Reads the `time` of a `SELECT last(...)` row as node-influx returns it; no row means none recorded. */
export function restoredTimeFromLastRow(row: unknown): RestoredAnchorTime {
  const nanoTime = (row as { time?: { getNanoTime?: () => string } } | undefined)?.time?.getNanoTime?.();
  const milliseconds = nanoTime === undefined ? NaN : Math.round(Number(nanoTime) / 1_000_000);
  return isNaN(milliseconds) ? NONE_RECORDED : { status: "recorded", at: milliseconds };
}

/** Equality for the latest-anchor memo, so unrelated config writes can't re-anchor or re-query. */
export function sameAnchor(previous: SelectedAnchor | undefined, next: SelectedAnchor | undefined): boolean {
  return (
    previous?.at === next?.at &&
    previous?.soc === next?.soc &&
    previous?.type === next?.type &&
    previous?.origin === next?.origin
  );
}

function anchorSocPercent(type: AnchorType, softEmptySocPercent: number): number {
  if (type === "full") return 100;
  if (type === "empty") return 0;
  return softEmptySocPercent;
}

function latestOf(anchors: SelectedAnchor[]): SelectedAnchor {
  return anchors.reduce((latest, candidate) => (candidate.at > latest.at ? candidate : latest));
}
