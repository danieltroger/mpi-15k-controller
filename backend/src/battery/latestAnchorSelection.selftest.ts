/**
 * Pure self-test of the "no anchor until the history has answered" rule and the restore helpers.
 * Run from backend/ with:  yarn node src/battery/latestAnchorSelection.selftest.ts
 */
import process from "process";
import type { AnchorType } from "./ahLedger.types.ts";
import {
  AWAITING_DATABASE,
  markerOrVoltageFallback,
  NONE_RECORDED,
  type RestoredAnchorTime,
  restoredTimeFromLastRow,
  sameAnchor,
  type SelectedAnchor,
  selectLatestAnchor,
} from "./latestAnchorSelection.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const hour = 3_600_000;
const bootAt = 1_761_200_000_000;
const softEmptySocPercent = 0.4;
const noLiveEvents: Record<AnchorType, number | undefined> = {
  full: undefined,
  empty: undefined,
  soft_empty: undefined,
};
const recordedAt = (at: number): RestoredAnchorTime => ({ status: "recorded", at });
// The history as InfluxDB eventually reports it: full 20 h ago, empty 40 h ago, soft-empty 5 h ago (latest).
const completeHistory: Record<AnchorType, RestoredAnchorTime> = {
  full: recordedAt(bootAt - 20 * hour),
  empty: recordedAt(bootAt - 40 * hour),
  soft_empty: recordedAt(bootAt - 5 * hour),
};
const describe = (anchor: SelectedAnchor | undefined) =>
  anchor ? `${anchor.origin} ${anchor.type} @ boot${formatHoursOffset(anchor.at - bootAt)} (${anchor.soc} %)` : "none";
const formatHoursOffset = (offsetMs: number) =>
  `${offsetMs >= 0 ? "+" : "−"}${(Math.abs(offsetMs) / hour).toFixed(1)} h`;

// ---------- the 2026-10-23 shape: part of the history answered, the newest kind still failing ----------
{
  const partial = { ...completeHistory, soft_empty: AWAITING_DATABASE };
  const anchor = selectLatestAnchor({ liveEventAt: noLiveEvents, restoredAt: partial, softEmptySocPercent });
  check(
    "newest kind still awaiting → no anchor (SOC unknown), not the older full",
    anchor === undefined,
    describe(anchor)
  );
}
{
  const nothingYet = { full: AWAITING_DATABASE, empty: AWAITING_DATABASE, soft_empty: AWAITING_DATABASE };
  const anchor = selectLatestAnchor({ liveEventAt: noLiveEvents, restoredAt: nothingYet, softEmptySocPercent });
  check("InfluxDB down at boot → no anchor", anchor === undefined, describe(anchor));
}

// ---------- once everything answered: the normal boot ----------
{
  const anchor = selectLatestAnchor({ liveEventAt: noLiveEvents, restoredAt: completeHistory, softEmptySocPercent });
  check(
    "complete history → the latest restored anchor, with its SOC",
    anchor?.type === "soft_empty" &&
      anchor.at === bootAt - 5 * hour &&
      anchor.soc === softEmptySocPercent &&
      anchor.origin === "restored",
    describe(anchor)
  );
}
{
  const withoutSoftEmpty = { ...completeHistory, soft_empty: NONE_RECORDED };
  const anchor = selectLatestAnchor({ liveEventAt: noLiveEvents, restoredAt: withoutSoftEmpty, softEmptySocPercent });
  check(
    "a kind answered as none recorded doesn't block → next-latest (full, 100 %)",
    anchor?.type === "full" && anchor.soc === 100,
    describe(anchor)
  );
}
{
  const noHistoryAtAll = { full: NONE_RECORDED, empty: NONE_RECORDED, soft_empty: NONE_RECORDED };
  check(
    "history answered with nothing (or no InfluxDB configured) → no anchor",
    selectLatestAnchor({ liveEventAt: noLiveEvents, restoredAt: noHistoryAtAll, softEmptySocPercent }) === undefined
  );
}

// ---------- live events ----------
{
  const nothingYet = { full: AWAITING_DATABASE, empty: AWAITING_DATABASE, soft_empty: AWAITING_DATABASE };
  const anchor = selectLatestAnchor({
    liveEventAt: { ...noLiveEvents, full: bootAt + 2 * hour },
    restoredAt: nothingYet,
    softEmptySocPercent,
  });
  check(
    "a live full during the outage anchors immediately (newer than any history)",
    anchor?.type === "full" && anchor.origin === "live" && anchor.at === bootAt + 2 * hour,
    describe(anchor)
  );
}
{
  // The pi's clock is stale until NTP syncs, so a live event can carry an EARLIER stamp than a restored one.
  const anchor = selectLatestAnchor({
    liveEventAt: { ...noLiveEvents, empty: bootAt - 30 * hour },
    restoredAt: completeHistory,
    softEmptySocPercent,
  });
  check(
    "a live event wins over restored ones even with a stale pi timestamp",
    anchor?.type === "empty" && anchor.origin === "live",
    describe(anchor)
  );
}
{
  const anchor = selectLatestAnchor({
    liveEventAt: { full: bootAt + 1 * hour, empty: undefined, soft_empty: bootAt + 3 * hour },
    restoredAt: completeHistory,
    softEmptySocPercent,
  });
  check("several live events → the latest of them", anchor?.type === "soft_empty" && anchor.origin === "live");
}

// ---------- marker vs voltage fallback ----------
{
  const marker = recordedAt(bootAt - 3 * hour);
  const fallback = recordedAt(bootAt - 9 * hour);
  check("recorded marker wins over the fallback", markerOrVoltageFallback(marker, fallback) === marker);
  check(
    "recorded marker wins even while the fallback still awaits",
    markerOrVoltageFallback(marker, AWAITING_DATABASE) === marker
  );
  check("no marker → the fallback's answer", markerOrVoltageFallback(NONE_RECORDED, fallback) === fallback);
  check(
    "no marker and fallback still awaiting → awaiting",
    markerOrVoltageFallback(NONE_RECORDED, AWAITING_DATABASE).status === "awaiting_database"
  );
  check(
    "marker still awaiting → awaiting, even though the fallback answered (the old fall-through bug)",
    markerOrVoltageFallback(AWAITING_DATABASE, fallback).status === "awaiting_database"
  );
}

// ---------- parsing node-influx's last() rows ----------
{
  const atMs = bootAt - 5 * hour;
  const row = { time: { getNanoTime: () => `${atMs}000123` }, last: 1 };
  const parsed = restoredTimeFromLastRow(row);
  check(
    "row with a time → recorded at that ms",
    parsed.status === "recorded" && parsed.at === atMs,
    JSON.stringify(parsed)
  );
  check("no row (empty result) → none recorded", restoredTimeFromLastRow(undefined).status === "none_recorded");
  check("row without a time → none recorded", restoredTimeFromLastRow({ last: 1 }).status === "none_recorded");
}

// ---------- memo equality ----------
{
  const anchor: SelectedAnchor = { at: bootAt, soc: 100, type: "full", origin: "restored" };
  check("same fields → same anchor", sameAnchor(anchor, { ...anchor }));
  check("different SOC → different", !sameAnchor(anchor, { ...anchor, soc: 0.4 }));
  check("different origin → different", !sameAnchor(anchor, { ...anchor, origin: "live" }));
  check("both unknown → same", sameAnchor(undefined, undefined));
  check("unknown vs known → different", !sameAnchor(undefined, anchor));
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all latestAnchorSelection selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
