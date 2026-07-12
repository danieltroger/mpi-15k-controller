import { type Accessor, createEffect, createMemo, createResource, createSignal, untrack } from "solid-js";
import type { get_config_object } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import type { InfluxClientAccessor } from "./useDatabasePower.ts";
import { queryChargeIntegral } from "./queryChargeIntegral.ts";
import { applyParameterTracking } from "./ahLedgerParameterTracking.ts";
import { computeSocAh, type LedgerAnchor } from "./ahLedgerMath.ts";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import { useNow } from "../utilities/useNow.ts";
import { logLog, warnLog } from "../utilities/logging.ts";

type ActiveAnchor = LedgerAnchor & { drainA: number; capacityAh: number };

/**
 * The Ah (coulomb-counting) SOC ledger — Phase 1's shadow of the Wh system. Anchored at the latest
 * full/empty/soft-empty event (`latestAnchor`), it restores ∫amps from that anchor out of InfluxDB once
 * (via the raw-mV subquery, so it survives deploys) and then accumulates live from the hall amps signal,
 * mirroring calculateBatteryEnergy. `soc_ah` is published UNclamped so the drift shows in Grafana.
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
}: {
  configSignal: Awaited<ReturnType<typeof get_config_object>>;
  influxClient: InfluxClientAccessor;
  batteryCurrentAmps: Accessor<{ value: number; time: number } | undefined>;
  latestAnchor: Accessor<LedgerAnchor | undefined>;
}) {
  const [activeAnchor, setActiveAnchor] = createSignal<ActiveAnchor | undefined>(undefined);
  const [accumulationToggle, setAccumulationToggle] = createSignal(false);
  // Anchors older than this are restore-time reconstructions, not live events — see the tracking gate below.
  const ledgerStartedAt = +new Date();
  let localAh = 0;
  let lastAmps: { value: number; time: number } | undefined;

  // Charge integrated in the database from the anchor up to app start; re-queried whenever we re-anchor.
  const [databaseAh] = createResource(
    () => ({ anchorAt: latestAnchor()?.at, database: influxClient() }),
    async ({ anchorAt, database }) => {
      if (!anchorAt || !database) return undefined;
      const currentMeasuring = untrack(() => config().current_measuring);
      return await queryChargeIntegral(
        database,
        anchorAt,
        currentMeasuring.zero_current_millivolts2,
        currentMeasuring.millivolts_per_ampere2
      );
    }
  );

  // Accumulate live amp-hours (trapezoidal via the previous sample, like calculateBatteryEnergy's power).
  createEffect(() => {
    const amps = batteryCurrentAmps();
    if (!amps) return;
    if (lastAmps) {
      const durationHours = (amps.time - lastAmps.time) / 1000 / 60 / 60;
      localAh += lastAmps.value * durationHours;
    }
    lastAmps = amps;
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
        if (anchor.at > ledgerStartedAt) {
          applyParameterTracking({ previousAnchor: previous, nextAnchor: anchor, spanIntegralAh, config, setConfig });
        } else {
          // Restored (pre-start) anchor: totalAh() measures previous→NOW, not previous→anchor, so hours of
          // post-anchor flow would corrupt the estimate (seen on first deploy: a 6 h-stale full→empty span
          // implied 949 Ah). Live events fire within seconds of the condition, where now ≈ anchor time.
          logLog("Ah ledger: skipping parameter tracking for restored span", previous.type, "→", anchor.type);
        }
      }
      localAh = 0; // keep lastAmps so the first post-anchor sample still bridges (mirrors the Wh ledger)
      const ahLedgerConfig = config().soc_calculations.ah_ledger; // read AFTER the update above → forward-only
      setActiveAnchor({
        at: anchor.at,
        soc: anchor.soc,
        type: anchor.type,
        drainA: ahLedgerConfig.drain_a,
        capacityAh: ahLedgerConfig.capacity_ah,
      });
    });
    return anchorAt;
  }, undefined);

  const socAh = createMemo(() => {
    // While a re-anchor's DB refetch is in flight, totalAh() still holds the OLD span's integral (the
    // re-anchor effect needs that stale read for parameter tracking) — but against the NEW anchor it
    // would compute a wild one-off spike, so hold the output until the fresh integral lands.
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

  publishSocAh({ config, socAh });

  return { socAh };
}

function publishSocAh({ config, socAh }: { config: Accessor<Config>; socAh: Accessor<number | undefined> }) {
  const { mqttClient } = useFromMqttProvider();
  createEffect(() => {
    const client = mqttClient();
    if (!client) return;
    createEffect(() => {
      const value = socAh();
      // Publish UNclamped, but never NaN/±Infinity (that would corrupt the line-protocol point).
      if (value == undefined || !isFinite(value)) return;
      const table = untrack(() => config().soc_calculations.table);
      const line = `${table} soc_ah=${value}`;
      if (client.connected) {
        client.publish(table, line).catch(error => warnLog("Failed to publish soc_ah", error));
      }
    });
  });
}
