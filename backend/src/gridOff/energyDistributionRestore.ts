/**
 * The energy-distribution restore's live wiring, part of the grid-off switch (useGridOffSwitch.ts builds
 * it): a DM change resets the inverter's HECS settings to the factory defaults (2026-11-05), so once the DM
 * readback confirms a switch back to 050 and grid_off.settings_restore_delay_seconds have passed, the
 * restorable fields that differ from the profile are put back (SEP, then EDD/EDE, then EDA/EDC), resent
 * with back-off, with one P2 per episode if they still differ after grid_off.settings_restore_p2_after_minutes.
 * The profile is the snapshot taken just before DM151 (energyDistributionSnapshotStore.ts), else
 * grid_off.normal_energy_distribution. The page can start a restore too. Nothing else writes: a controller
 * start, or a HECS that drifts while no DM changed, only shows the difference (and warnLogs it once).
 * Decisions: energyDistributionRestoreDecisions.ts.
 */
import { type Accessor, createEffect, createMemo, createSignal, type Setter, untrack } from "solid-js";
import type { GridOffConfig, NormalEnergyDistribution } from "../config/config.types.ts";
import type { DecodedRound, SettingsQueryCommandName } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem, SetterResult } from "../inverterComms/inverterComms.types.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { describeMachineModel, NORMAL_HYBRID_MODEL } from "../inverterComms/machineModel.ts";
import { logLog, warnLog } from "../utilities/logging.ts";
import type { EnergyDistributionFieldMismatch, EnergyDistributionStatus, GridOffEvent } from "./gridOff.types.ts";
import type { MachineModelReadback } from "./gridOffActions.ts";
import {
  describeMismatches,
  energyDistributionFromHecs,
  energyDistributionMismatches,
  restoreSetterFor,
} from "./energyDistributionProfile.ts";
import type { EnergyDistributionSnapshot, EnergyDistributionSnapshotStore } from "./energyDistributionSnapshotStore.ts";
import {
  type HecsReadback,
  type ManualRestoreSituation,
  manualRestoreRefusal,
  nextRestoreStep,
  RESTORE_READBACK_REQUEST_REPEAT_MS,
  RESTORE_RESEND_INTERVALS_MS,
  restoreTriggerOnReadback,
  type RestoreEpisode,
  type RestoreTiming,
  startRestoreEpisode,
} from "./energyDistributionRestoreDecisions.ts";
import { raiseRestoreLandedAfterP2, raiseRestoreNotLanded } from "./energyDistributionRestoreAlert.ts";

export type EnergyDistributionRestoreEnvironment = {
  /** The corrected grid_off knobs, the config profile among them */
  settings: Accessor<GridOffConfig>;
  queueSetter: (item: SetterQueueItem) => void;
  /** The session's "read the settings ahead of the interval" (one HECS readback per episode step, bounded) */
  requestSettingsReadback: (query: SettingsQueryCommandName) => void;
  /** HECS rounds give the readback the restore judges */
  lastDecodedRound: Accessor<DecodedRound | undefined>;
  /** The grid-off switch's DM readback */
  machineModelReadback: Accessor<MachineModelReadback | undefined>;
  gridOffInForce: Accessor<boolean>;
  raise: AlertManager["raise"];
  wallClockNowMs: () => number;
  snapshotStore: EnergyDistributionSnapshotStore;
  /** Harnesses only (they scale the back-off and the P2 down) — production passes nothing */
  timingOverrides: Partial<RestoreTiming> | undefined;
};

export function createEnergyDistributionRestore(environment: EnergyDistributionRestoreEnvironment) {
  const [hecs, setHecs] = createSignal<HecsReadback | undefined>(undefined);
  const [episode, setEpisode] = createSignal<RestoreEpisode | undefined>(undefined);
  const [snapshot, setSnapshot] = createSignal<EnergyDistributionSnapshot | undefined>(
    environment.snapshotStore.load()
  );
  const [lastEvent, setLastEvent] = createSignal<GridOffEvent | undefined>(undefined);
  const profile = createMemo(() => snapshot()?.profile ?? environment.settings().normal_energy_distribution);
  const context: RestoreContext = {
    ...environment,
    hecs,
    episode,
    setEpisode,
    snapshot,
    setSnapshot,
    setLastEvent,
    profile,
    previousReadbackModel: undefined,
    loggedIdleMismatches: undefined,
  };

  createEffect(() => {
    const round = environment.lastDecodedRound();
    if (round?.command === "HECS") setHecs({ fields: round.fields, decodedAtMs: round.decodedAt });
  });
  createEffect(() => {
    const readback = environment.machineModelReadback();
    if (readback) untrack(() => onMachineModelReadback(context, readback));
  });
  // The guard tick (useGridOffSwitch.ts) covers the passing of time: settling, the back-off, the P2
  createEffect(() => {
    hecs();
    environment.machineModelReadback();
    environment.gridOffInForce();
    profile();
    environment.settings();
    untrack(() => evaluateRestore(context));
  });

  const status = createMemo<EnergyDistributionStatus>(() => {
    const currentSnapshot = snapshot();
    const latestHecs = hecs();
    const runningEpisode = episode();
    return {
      profile: profile(),
      profile_source: currentSnapshot ? "snapshot" : "config",
      snapshot_taken_at: currentSnapshot?.taken_at,
      mismatches: latestHecs ? energyDistributionMismatches(profile(), latestHecs.fields) : undefined,
      hecs_read_at: latestHecs?.decodedAtMs,
      restore: runningEpisode && {
        trigger: runningEpisode.trigger,
        since: runningEpisode.onsetMs,
        send_rounds: runningEpisode.sendRounds,
        p2_raised: runningEpisode.p2Raised,
      },
      last_event: lastEvent(),
    };
  });

  return {
    status,
    /** Re-judge the running episode (the guard tick) */
    evaluate: () => evaluateRestore(context),
    /** Called as DM151 is requested: what "normal" is for the restore after this episode */
    takeSnapshotBeforeOffGrid: () => takeSnapshotBeforeOffGrid(context),
    /** The page's "Restore normal settings": refused, with the reason thrown, unless the situation allows it */
    requestRestore: (situation: ManualRestoreSituation) => requestRestore(context, situation),
  };
}

export type EnergyDistributionRestore = ReturnType<typeof createEnergyDistributionRestore>;

type RestoreContext = EnergyDistributionRestoreEnvironment & {
  hecs: Accessor<HecsReadback | undefined>;
  episode: Accessor<RestoreEpisode | undefined>;
  setEpisode: Setter<RestoreEpisode | undefined>;
  snapshot: Accessor<EnergyDistributionSnapshot | undefined>;
  setSnapshot: Setter<EnergyDistributionSnapshot | undefined>;
  setLastEvent: Setter<GridOffEvent | undefined>;
  /** The snapshot's profile while there is one, else the config's */
  profile: Accessor<NormalEnergyDistribution>;
  /** The DM readback before the latest, verbatim: a change of it is what starts an episode */
  previousReadbackModel: string | undefined;
  /** The idle mismatch last warnLogged, so a standing one logs once, not every HECS round */
  loggedIdleMismatches: string | undefined;
};

function onMachineModelReadback(context: RestoreContext, readback: MachineModelReadback): void {
  const previousModel = context.previousReadbackModel;
  context.previousReadbackModel = readback.model;
  const trigger = restoreTriggerOnReadback(previousModel, readback.model);
  if (trigger.action === "none") return;
  if (trigger.action === "cancel") {
    if (untrack(context.episode)) cancelEpisode(context, trigger.reason);
    return;
  }
  const settleSeconds = untrack(context.settings).settings_restore_delay_seconds;
  context.setEpisode(startRestoreEpisode("dm_change", readback.atMs, settleSeconds * 1000));
  logLog(
    `Grid off: ${trigger.reason} — the energy-distribution settings (HECS) it reset are judged in ${settleSeconds} s and restored to the ${describeProfileSource(context)}`
  );
  recordEvent(context, `Back on 050: restoring the energy-distribution settings in ${settleSeconds} s`);
}

/** Runs on every HECS/DM readback, grid-off or config change and every guard tick; every read is untracked */
function evaluateRestore(context: RestoreContext): void {
  const nowMs = context.wallClockNowMs();
  const episode = untrack(context.episode);
  const gridOffInForce = untrack(context.gridOffInForce);
  const readbackModel = untrack(context.machineModelReadback)?.model;
  const offNormal = readbackModel !== undefined && readbackModel !== NORMAL_HYBRID_MODEL;
  if (episode && (gridOffInForce || offNormal)) {
    cancelEpisode(
      context,
      gridOffInForce ? "grid-off is in force" : `the inverter reads ${describeMachineModel(readbackModel)}`
    );
    return;
  }
  if (!episode) {
    if (!gridOffInForce && !offNormal) idleUpkeep(context);
    return;
  }
  const profile = untrack(context.profile);
  const {
    step,
    episode: nextEpisode,
    raiseP2,
  } = nextRestoreStep(
    episode,
    { nowMs, hecs: untrack(context.hecs), profile },
    restoreTiming(untrack(context.settings), context.timingOverrides)
  );
  context.setEpisode(step.action === "done" ? undefined : nextEpisode);
  if (raiseP2) pageRestoreNotLanded(context, nextEpisode, nowMs);
  if (step.action === "request_readback") context.requestSettingsReadback("HECS");
  else if (step.action === "send") queueRestoreSetters(context, step.mismatches, profile, nextEpisode.sendRounds);
  else if (step.action === "done") finishEpisode(context, episode, step.firstMismatches, nowMs);
}

function restoreTiming(settings: GridOffConfig, overrides: Partial<RestoreTiming> | undefined): RestoreTiming {
  return {
    resendIntervalsMs: RESTORE_RESEND_INTERVALS_MS,
    readbackRequestRepeatMs: RESTORE_READBACK_REQUEST_REPEAT_MS,
    p2AfterMs: settings.settings_restore_p2_after_minutes * 60_000,
    ...overrides,
  };
}

function queueRestoreSetters(
  context: RestoreContext,
  mismatches: readonly EnergyDistributionFieldMismatch[],
  profile: NormalEnergyDistribution,
  sendRound: number
): void {
  const commands: string[] = [];
  for (const mismatch of mismatches) {
    const { command, replacesPrefix } = restoreSetterFor(mismatch, profile);
    commands.push(command);
    context.queueSetter({
      command,
      replacesPrefix,
      refreshAfterSend: ["HECS"],
      onResult: result => afterRestoreSetterResult(context, command, result),
    });
  }
  (sendRound === 1 ? logLog : warnLog)(
    `Grid off: restoring the energy-distribution settings${sendRound === 1 ? "" : ` (round ${sendRound}, the readback still differs)`} — queueing ${commands.join(", ")}: ${describeMismatches(mismatches)}`
  );
  recordEvent(context, `Restoring ${commands.join(", ")}${sendRound === 1 ? "" : ` (round ${sendRound})`}`);
}

function afterRestoreSetterResult(context: RestoreContext, command: string, result: SetterResult): void {
  if (result.acknowledged) return;
  // The session errorLogs a NAK once per episode of them; this says what the restore does about it
  warnLog(
    `Grid off: the inverter NAKed ${command} while restoring the energy-distribution settings — resent with back-off while the HECS readback differs`
  );
  recordEvent(context, `${command} rejected by the inverter (NAK): resent with back-off`);
}

function pageRestoreNotLanded(context: RestoreContext, episode: RestoreEpisode, nowMs: number): void {
  const latestHecs = untrack(context.hecs);
  // Only a readback the episode may judge says what still differs
  const mismatches =
    latestHecs && latestHecs.decodedAtMs >= episode.judgeReadbacksFromMs
      ? energyDistributionMismatches(untrack(context.profile), latestHecs.fields)
      : undefined;
  warnLog(
    `Grid off: the energy-distribution settings still aren't restored ${Math.round((nowMs - episode.onsetMs) / 1000)} s into the episode (${mismatches ? describeMismatches(mismatches) : "no HECS readback since the switch"}); paging P2, retrying with back-off`
  );
  recordEvent(context, "Settings still not restored: P2 sent, resending with back-off");
  raiseRestoreNotLanded(context.raise, {
    episodeOnsetMs: episode.onsetMs,
    nowMs,
    sendRounds: episode.sendRounds,
    mismatches,
  });
}

function finishEpisode(
  context: RestoreContext,
  episode: RestoreEpisode,
  firstMismatches: readonly EnergyDistributionFieldMismatch[],
  nowMs: number
): void {
  const source = describeProfileSource(context);
  const elapsedSeconds = Math.round((nowMs - episode.onsetMs) / 1000);
  const why = episode.trigger === "manual" ? "on the page's request" : "after the DM change to 050";
  logLog(
    firstMismatches.length
      ? `Grid off: energy-distribution settings restored ${why} to the ${source}: ${describeMismatches(firstMismatches)} (${episode.sendRounds} send round(s), ${elapsedSeconds} s)`
      : `Grid off: energy-distribution settings ${why}: nothing to restore, HECS already reads the ${source}`
  );
  recordEvent(context, firstMismatches.length ? "Normal settings restored" : "Settings already normal");
  if (episode.p2Raised) raiseRestoreLandedAfterP2(context.raise, { episodeOnsetMs: episode.onsetMs, nowMs });
  // The snapshot bridged this episode; from here on the config profile is what normal means
  if (untrack(context.snapshot)) clearSnapshot(context);
  context.loggedIdleMismatches = undefined;
}

function cancelEpisode(context: RestoreContext, reason: string): void {
  context.setEpisode(undefined);
  logLog(`Grid off: energy-distribution restore cancelled — ${reason}; the next switch back to 050 starts it again`);
  recordEvent(context, `Restore cancelled: ${reason}`);
}

/** No episode, 050, not in force: show a difference (warnLog it once) and drop a snapshot that is held anyway */
function idleUpkeep(context: RestoreContext): void {
  const latestHecs = untrack(context.hecs);
  if (!latestHecs) return;
  const mismatches = energyDistributionMismatches(untrack(context.profile), latestHecs.fields);
  const currentSnapshot = untrack(context.snapshot);
  if (!mismatches.length) {
    context.loggedIdleMismatches = undefined;
    // Read after the snapshot was taken: e.g. the DM151 it was taken for was NAKed, or set by hand since
    if (currentSnapshot && latestHecs.decodedAtMs > currentSnapshot.taken_at) {
      logLog("Grid off: the inverter holds the energy-distribution snapshot's settings again — dropping the snapshot");
      clearSnapshot(context);
    }
    return;
  }
  const description = describeMismatches(mismatches);
  if (description === context.loggedIdleMismatches) return;
  context.loggedIdleMismatches = description;
  warnLog(
    `Grid off: the inverter's energy-distribution settings differ from the ${describeProfileSource(context)}: ${description}.`,
    "Nothing is written without a DM change; the System page's Restore normal settings puts them back"
  );
}

/**
 * The HECS just read in 050 becomes "normal" for the restore after this episode, unless that readback can't
 * be trusted to be normal: an older snapshot whose restore never landed is kept, and a half-done restore
 * (grid-off cancels it) leaves the config profile in charge
 */
function takeSnapshotBeforeOffGrid(context: RestoreContext): void {
  const existing = untrack(context.snapshot);
  if (existing) {
    warnLog(
      `Grid off: keeping the energy-distribution snapshot from ${new Date(existing.taken_at).toISOString()} — a restore to it hasn't landed since: ${JSON.stringify(existing.profile)}`
    );
    return;
  }
  if (untrack(context.episode)) {
    warnLog(
      "Grid off: DM151 requested while the energy-distribution restore still runs — no snapshot of a half-restored HECS; the restore after this episode puts grid_off.normal_energy_distribution back"
    );
    return;
  }
  const latestHecs = untrack(context.hecs);
  const live = energyDistributionFromHecs(latestHecs?.fields);
  if (!latestHecs || !live) {
    warnLog(
      "Grid off: no complete HECS readback to snapshot before DM151 — the restore after it puts grid_off.normal_energy_distribution back"
    );
    return;
  }
  const snapshot: EnergyDistributionSnapshot = { taken_at: latestHecs.decodedAtMs, profile: live };
  context.setSnapshot(snapshot);
  context.snapshotStore.save(snapshot);
  const fromConfig = energyDistributionMismatches(
    untrack(context.settings).normal_energy_distribution,
    latestHecs.fields
  );
  logLog(`Grid off: energy-distribution snapshot taken before DM151: ${JSON.stringify(live)}`);
  if (fromConfig.length) {
    warnLog(
      "Grid off: the snapshot differs from grid_off.normal_energy_distribution (inverter → config):",
      `${describeMismatches(fromConfig)}; the restore after this episode returns to the snapshot`
    );
  }
}

function requestRestore(context: RestoreContext, situation: ManualRestoreSituation): string {
  const refusal = manualRestoreRefusal(situation);
  if (refusal) {
    logLog("Grid off: restoring the energy-distribution settings refused:", refusal);
    recordEvent(context, `Restore refused: ${refusal}`);
    throw new Error(`Refused: ${refusal}`);
  }
  const nowMs = context.wallClockNowMs();
  const latestHecs = untrack(context.hecs);
  const knownMismatches = latestHecs
    ? energyDistributionMismatches(untrack(context.profile), latestHecs.fields)
    : undefined;
  logLog(
    `Grid off: restore of the energy-distribution settings requested by the page — re-reading HECS, then restoring to the ${describeProfileSource(context)};`,
    `the latest readback differs in: ${knownMismatches ? describeMismatches(knownMismatches) : "(HECS not read yet)"}`
  );
  // No settling: nothing changed the DM. The fresh HECS readback is still awaited (judgeReadbacksFromMs)
  context.setEpisode(startRestoreEpisode("manual", nowMs, 0));
  recordEvent(context, "Restore requested from the page: re-reading HECS");
  evaluateRestore(context);
  if (!knownMismatches) return "Restoring: HECS is read first, then whatever differs is sent";
  return knownMismatches.length
    ? `Restoring ${describeMismatches(knownMismatches)}: HECS is re-read first, the readback confirms it in ~15–30 s`
    : "The latest HECS readback already matches the profile: re-reading it to confirm";
}

function clearSnapshot(context: RestoreContext): void {
  context.setSnapshot(undefined);
  context.snapshotStore.clear();
}

function describeProfileSource(context: RestoreContext): string {
  const currentSnapshot = untrack(context.snapshot);
  return currentSnapshot
    ? `snapshot taken before DM151 (${new Date(currentSnapshot.taken_at).toISOString()})`
    : "profile in grid_off.normal_energy_distribution";
}

function recordEvent(context: RestoreContext, what: string): void {
  context.setLastEvent({ what, when: context.wallClockNowMs() });
}
