import { type Accessor, createEffect, createMemo, createResource, createSignal, untrack } from "solid-js";
import type { get_config_object } from "../config/config.ts";
import type { InfluxClientAccessor } from "../utilities/InfluxClientProvider.ts";
import { queryChargeIntegral } from "./queryChargeIntegral.ts";
import { applyParameterTracking } from "./ahLedgerParameterTracking.ts";
import { computeSocAh } from "./ahLedgerMath.ts";
import { useNow } from "../utilities/useNow.ts";
import { logLog } from "../utilities/logging.ts";
import { createHistoryQueryRetrier } from "./historyQueryRetrier.ts";
import { describeDurationMs } from "./historyRetryPolicy.ts";
import type { InfluxHistoryOutageMonitor } from "./influxHistoryOutage.ts";
import type { LedgerStartClock } from "./ledgerStartClock.ts";
import type { SelectedAnchor } from "./latestAnchorSelection.ts";

type ActiveAnchor = SelectedAnchor & { drainA: number; capacityAh: number };

/**
 * The Ah (coulomb-counting) SOC ledger — the app's single SOC source. Anchored at the latest
 * full/empty/soft-empty event (`latestAnchor`): a restored anchor's ∫amps up to ledger start comes out of
 * InfluxDB (via the raw-mV subquery, so it survives deploys), and everything after ledger start — or
 * after a live anchor — is accumulated here from the hall amps signal. The SOC stays undefined until both
 * halves are known. The raw value goes to InfluxDB unclamped (publishSocAh.ts); consumers read the
 * clamped one.
 *
 * On each re-anchor it (a) hands the completed span to the online drain/capacity EMA tracker, then
 * (b) snapshots the (possibly just-updated) drain/capacity into the new anchor. The SOC formula reads
 * those snapshots, never live config, so a parameter update only ever changes the future — no retroactive
 * step across the span that just ended.
 */
export function ahLedger({
  configSignal: [config, setConfig],
  influxClient,
  batteryCurrentAmps,
  latestAnchor,
  ledgerStart,
  outageMonitor,
}: {
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  influxClient: InfluxClientAccessor;
  batteryCurrentAmps: Accessor<{ value: number; time: number } | undefined>;
  latestAnchor: Accessor<SelectedAnchor | undefined>;
  ledgerStart: LedgerStartClock;
  outageMonitor: InfluxHistoryOutageMonitor;
}) {
  const [activeAnchor, setActiveAnchor] = createSignal<ActiveAnchor | undefined>(undefined);
  const [accumulationToggle, setAccumulationToggle] = createSignal(false);
  // ∫amps since ledger start, or since the latest live anchor once one fired. A restored anchor never
  // resets it: InfluxDB only holds that span up to ledger start, so the samples taken while the restore was
  // still waiting for InfluxDB belong to the span too — after a power cycle that is the VM's whole boot.
  let localAh = 0;
  let lastAmps: { value: number; arrivedAtMonotonicMs: number } | undefined;

  const integralRetrier = createHistoryQueryRetrier({ description: "Ah ledger charge integral", outageMonitor });
  // Charge InfluxDB holds for a restored anchor's span up to ledger start; re-queried whenever we re-anchor.
  const [databaseAh] = createResource(
    () => ({ anchor: latestAnchor(), database: influxClient() }),
    async ({ anchor, database }) => {
      integralRetrier.cancelPending();
      if (!anchor) return undefined;
      // A live anchor's span is all local. This still resolves a tick later (async), which the re-anchor
      // effect relies on: it must read the previous span's database share before this replaces it.
      if (anchor.origin === "live") return 0;
      if (!database) return undefined;
      const currentMeasuring = untrack(() => config().current_measuring);
      return await integralRetrier.run(() =>
        queryChargeIntegral({
          database,
          fromMs: anchor.at,
          untilCondition: ledgerStart.beforeStartCondition(),
          ...currentMeasuring,
        })
      );
    }
  );

  // Accumulate live amp-hours (trapezoidal integration via the previous sample).
  createEffect(() => {
    const amps = batteryCurrentAmps();
    if (!amps) return;
    // Interval from the monotonic clock, not the samples' wall-clock stamps: the pi's clock steps forward
    // when NTP syncs mid-boot (ledgerStartClock.ts), and one interval spanning that step would book hours
    // of current. Samples arrive straight from the ADC callback, so arrival time is sample time.
    const arrivedAtMonotonicMs = performance.now();
    if (lastAmps) {
      const durationHours = (arrivedAtMonotonicMs - lastAmps.arrivedAtMonotonicMs) / 1000 / 60 / 60;
      localAh += lastAmps.value * durationHours;
    }
    lastAmps = { value: amps.value, arrivedAtMonotonicMs };
    setAccumulationToggle(previous => !previous);
  });

  const totalAh = createMemo(() => {
    accumulationToggle();
    const databaseValue = databaseAh();
    if (databaseValue == undefined) return undefined;
    return databaseValue + localAh;
  });

  // Re-anchor: depends only on the anchor time (primitive) so unrelated config writes can't retrigger it.
  createEffect<number | undefined>(previousAnchorAt => {
    const anchor = latestAnchor();
    const anchorAt = anchor?.at;
    if (!anchor || anchorAt === previousAnchorAt) return anchorAt;
    untrack(() => {
      const previous = activeAnchor();
      const spanIntegralAh = totalAh(); // ∫amps since the previous anchor (DB resource still holds its old value)
      if (previous && spanIntegralAh != undefined) {
        if (anchor.origin === "live") {
          applyParameterTracking({ previousAnchor: previous, nextAnchor: anchor, spanIntegralAh, config, setConfig });
        } else {
          // Restored (pre-start) anchor: totalAh() measures previous→NOW, not previous→anchor, so hours of
          // post-anchor flow would corrupt the estimate (seen on first deploy: a 6 h-stale full→empty span
          // implied 949 Ah). Live events fire within seconds of the condition, where now ≈ anchor time.
          logLog("Ah ledger: skipping parameter tracking for restored span", previous.type, "→", anchor.type);
        }
      }
      // Keep lastAmps either way, so the first post-anchor sample still bridges the gap across the re-anchor.
      if (anchor.origin === "live") localAh = 0;
      const ahLedgerConfig = config().soc_calculations.ah_ledger; // read AFTER the update above → forward-only
      setActiveAnchor({
        ...anchor,
        drainA: ahLedgerConfig.drain_a,
        capacityAh: ahLedgerConfig.capacity_ah,
      });
    });
    return anchorAt;
  }, undefined);

  const socAh = createMemo(() => {
    // While a re-anchor's DB refetch is in flight, totalAh() still holds the OLD span's integral (the
    // re-anchor effect needs that stale read for parameter tracking) — but against the NEW anchor it
    // would compute a wild one-off spike, so hold the output until the fresh integral lands. That includes
    // the whole wait while InfluxDB is still unreachable after a power cycle.
    if (databaseAh.loading) return undefined;
    const anchor = activeAnchor();
    const integralAh = totalAh();
    if (!anchor || integralAh == undefined) return undefined;
    return computeSocAh({
      anchorSoc: anchor.soc,
      integralAh,
      drainA: anchor.drainA,
      elapsedHours: (useNow() - anchor.at) / 1000 / 60 / 60,
      capacityAh: anchor.capacityAh,
    });
  });

  logWhenSocFirstKnown({ socAh, activeAnchor, ledgerStart });

  return { socAh };
}

/** One line when the SOC first becomes known, saying how long the boot had to wait for it. */
function logWhenSocFirstKnown({
  socAh,
  activeAnchor,
  ledgerStart,
}: {
  socAh: Accessor<number | undefined>;
  activeAnchor: Accessor<ActiveAnchor | undefined>;
  ledgerStart: LedgerStartClock;
}) {
  createEffect<boolean>(alreadyLogged => {
    if (alreadyLogged) return true;
    const soc = socAh();
    const anchor = untrack(activeAnchor);
    if (soc === undefined || !anchor) return false;
    logLog(
      `Ah ledger: SOC initialised at ${soc.toFixed(1)} % from the ${anchor.origin} ${anchor.type} anchor of ${new Date(anchor.at).toISOString()}, ${describeDurationMs(ledgerStart.msSinceStart())} after start`
    );
    return true;
  }, false);
}
