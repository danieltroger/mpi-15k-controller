import { useLastFullAndEmpty } from "./useLastFullAndEmpty.ts";
import { useDatabasePower } from "./useDatabasePower.ts";
import { type Accessor, catchError, createEffect, createMemo, createSignal } from "solid-js";
import { get_config_object } from "../config/config.ts";
import { batteryCalculationsDependingOnUnknowns } from "./batteryCalculationsDependingOnUnknowns.ts";
import { iterativelyFindSocParameters } from "./iterativelyFindSocParameters.ts";
import { reportSOCToMqtt } from "./reportSOCToMqtt.ts";
import { useAhLedger } from "./useAhLedger.ts";
import { errorLog, warnLog } from "../utilities/logging.ts";

export function useBatteryValues(
  configSignal: Awaited<ReturnType<typeof get_config_object>>,
  {
    currentPower,
    batteryCurrentAmps,
    smoothedBatteryCurrentAmps,
  }: {
    /** Instantaneous battery power from hall sensor 2 (drives the Wh ledger). */
    currentPower: Accessor<{ value: number; time: number } | undefined>;
    /** Instantaneous battery amps from hall sensor 2 (drives the Ah ledger). */
    batteryCurrentAmps: Accessor<{ value: number; time: number } | undefined>;
    /** 1-min-smoothed hall amps (drives full/soft-empty anchor detection). */
    smoothedBatteryCurrentAmps: Accessor<number | undefined>;
  }
) {
  const [config] = configSignal;
  const { lastBatterySeenFullSinceProgramStart, lastBatterySeenEmptySinceProgramStart } = useLastFullAndEmpty(
    configSignal,
    smoothedBatteryCurrentAmps
  );
  const { influxClient, batteryWasLastFullAtAccordingToDatabase, batteryWasLastEmptyAtAccordingToDatabase } =
    useDatabasePower(configSignal);

  const [totalLastFull, totalLastEmpty] = [
    [batteryWasLastFullAtAccordingToDatabase, lastBatterySeenFullSinceProgramStart],
    [batteryWasLastEmptyAtAccordingToDatabase, lastBatterySeenEmptySinceProgramStart],
  ].map(([db, local]) =>
    createMemo(() => {
      const lastSinceStart = local();
      const lastAccordingToDatabase = db();
      if (!lastSinceStart && !lastAccordingToDatabase) return;
      if (!lastSinceStart) return lastAccordingToDatabase;
      if (!lastAccordingToDatabase) return lastSinceStart;
      return Math.max(lastSinceStart, lastAccordingToDatabase);
    })
  );
  const assumedParasiticConsumption = createMemo(() => config().soc_calculations.current_state.parasitic_consumption);
  const assumedCapacity = createMemo(() => config().soc_calculations.current_state.capacity);

  const {
    energyAddedSinceEmpty,
    energyRemovedSinceFull,
    socSinceFull,
    socSinceEmpty,
    energyWithoutParasiticSinceEmpty,
    energyWithoutParasiticSinceFull,
  } = batteryCalculationsDependingOnUnknowns({
    influxClient,
    totalLastFull,
    totalLastEmpty,
    subtractFromPower: assumedParasiticConsumption,
    assumedCapacity,
    currentPower,
  });

  const [iterativeFindingFailed, setIterativeFindingFailed] = createSignal(false);

  createEffect(() => {
    if (iterativeFindingFailed()) return;
    catchError(
      () =>
        iterativelyFindSocParameters({
          totalLastEmpty,
          totalLastFull,
          configSignal,
          energyWithoutParasiticSinceEmpty,
          energyWithoutParasiticSinceFull,
        }),
      e => {
        setIterativeFindingFailed(true);
        errorLog("Iteratively finding SOC parameters failed", e, "restarting in 60s");
        setTimeout(() => setIterativeFindingFailed(false), 60_000);
      }
    );
  });

  const averageSOC = createMemo(() => {
    const sinceFull = socSinceFull();
    const sinceEmpty = socSinceEmpty();
    const fullInvalid = isNaN(sinceFull!) || Math.abs(sinceFull!) === Infinity;
    const emptyInvalid = isNaN(sinceEmpty!) || Math.abs(sinceEmpty!) === Infinity;
    if (fullInvalid || emptyInvalid) return;
    return (sinceFull! + sinceEmpty!) / 2;
  });

  // Consumers (planner, sell/buy, ws) get a sane [0,100]; the raw averageSOC keeps flowing to InfluxDB
  // (reportSOCToMqtt) unclamped so the drift stays visible in Grafana.
  const clampedAverageSOC = createMemo(() => {
    const average = averageSOC();
    if (average == undefined) return undefined;
    return Math.max(0, Math.min(100, average));
  });

  // Health signal: the 30-min fitter force-equalizes soc_since_full/empty, so a persistent gap means the
  // Wh baseline is drifting between fits. Edge-triggered to avoid spamming while diverged.
  let whLedgersDiverged = false;
  createEffect(() => {
    const sinceFull = socSinceFull();
    const sinceEmpty = socSinceEmpty();
    if (sinceFull == undefined || sinceEmpty == undefined) return;
    const divergencePp = Math.abs(sinceFull - sinceEmpty);
    if (divergencePp > 5) {
      if (!whLedgersDiverged) {
        whLedgersDiverged = true;
        warnLog(
          `Wh SOC health: soc_since_full (${sinceFull}%) and soc_since_empty (${sinceEmpty}%) diverge by ${divergencePp.toFixed(1)} pp (>5)`
        );
      }
    } else {
      whLedgersDiverged = false;
    }
  });

  const { socAh } = useAhLedger({
    configSignal,
    influxClient,
    batteryCurrentAmps,
    smoothedBatteryCurrentAmps,
    databaseFullFallbackAt: batteryWasLastFullAtAccordingToDatabase,
    databaseEmptyFallbackAt: batteryWasLastEmptyAtAccordingToDatabase,
  });

  reportSOCToMqtt({
    config,
    averageSOC,
    socSinceEmpty,
    socSinceFull,
  });

  return {
    totalLastEmpty,
    totalLastFull,
    energyRemovedSinceFull,
    energyAddedSinceEmpty,
    socSinceEmpty,
    socSinceFull,
    assumedCapacity,
    assumedParasiticConsumption,
    averageSOC,
    clampedAverageSOC,
    socAh,
  };
}
