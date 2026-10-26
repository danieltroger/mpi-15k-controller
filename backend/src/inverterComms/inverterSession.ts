/**
 * THE one persistent PI17 session: a single command mutex over the serial device, with priority
 * control writes > confirm queries > background polls, and the post-write quiet gap the inverter's
 * commit behaviour demands (see schedulerTiming.ts for the measured numbers; the gap is the live
 * knob usb_parameter_setting.quiet_gap_after_write_ms, 0 = keep polling). Replaces both the
 * external mpp-solar MQTT daemon and the per-command mpp-solar CLI spawns — and with them the
 * stop-daemon/run-CLI/start-daemon dance (5m48s MQTT blackout on 2026-07-18). No systemctl calls
 * anywhere in this path: the mpp-solar unit is retired at cutover.
 *
 * Scheduling state lives in pure schedulerCore functions and wire-level exchange safety in
 * serialExchange.ts; this file is the async shell that runs the pump, decodes, gates implausible
 * rounds (plausibilityGate.ts) before any consumer sees them — escalating a persistent drop
 * (gateDropEscalation.ts) — measures every setter's ACK→commit (setterCommitTiming.ts), plus the
 * reactive surface (lastWriteAt / isOpen signals) for observers.
 *
 * Shape: one SessionState object, module-level functions taking it (CLAUDE.md: no nested
 * function declarations). Scheduling times are monotonic (performance.now()); only the
 * externally visible timestamps (round decodedAt, lastWriteAt) are wall-clock.
 */
import { type Accessor, createEffect, createSignal, on, onCleanup, type Setter, untrack } from "solid-js";
import { debugLog, errorLog, logLog, warnLog } from "../utilities/logging.ts";
import type {
  DecodedFields,
  DecodedRound,
  Pi17QueryCommandName,
  SettingsQueryCommandName,
} from "./pi17Protocol.types.ts";
import type { SetterQueueItem } from "./inverterComms.types.ts";
import { buildQueryFrame, buildSetterFrame } from "./pi17Frames.ts";
import { decodeQueryPayload } from "./pi17Decode.ts";
import { implausibleFieldsIn } from "./plausibilityGate.ts";
import { afterGateAccept, afterGateDrop, type GateDropEpisodes } from "./gateDropEscalation.ts";
import { createSerialExchange, type SerialExchange } from "./serialExchange.ts";
import { logSessionStats, STATS_LOG_INTERVAL_MS, type InverterSessionCounters } from "./inverterSessionStats.ts";
import { createRateLimitedWarnLog } from "../utilities/rateLimitedWarnLog.ts";
import {
  afterConfirmRun,
  afterPollRound,
  afterSetterSent,
  decideNextAction,
  hasEligibleSetter,
  initialSchedulerState,
  withSettingsReadback,
  withSetterDequeued,
  withSetterQueued,
  type SchedulerState,
} from "./schedulerCore.ts";
import type { SchedulerTiming } from "./schedulerTiming.ts";
import { quietGapFromConfig, schedulerWithQuietGapSetting } from "./quietGapSetting.ts";
import {
  reportAckedSetter,
  reportConfirmOutcome,
  type LineTraffic,
  type SetterCommitTracker,
} from "./setterCommitTiming.ts";
import { INVERTER_SERIAL_DEVICE } from "./serialConnection.ts";

/** Implausible rounds and decode problems log their first occurrence, then at most once a minute */
const DROPPED_ROUND_LOG_INTERVAL_MS = 60_000;
/** While the link is down, errorLog (a push candidate) at most this often; warnLog the rest */
const FAILURE_ERRORLOG_INTERVAL_MS = 60_000;
/** The continuous background poll: GS+PS every round, settings queries on their slower cadence */
const BACKGROUND_POLL_COMMANDS = ["GS", "PS"] as const;
const SETTINGS_POLL_COMMANDS: readonly SettingsQueryCommandName[] = ["GPMP", "HECS", "BATS"];

export function createInverterSession({
  poll_values_interval_seconds,
  quiet_gap_after_write_ms,
  onDecodedRound,
  devicePath = INVERTER_SERIAL_DEVICE,
  schedulerTimingOverrides = {},
}: {
  /** Cadence of the slow settings poll — config().usb_parameter_setting.poll_values_interval_seconds */
  poll_values_interval_seconds: Accessor<number>;
  /** config().usb_parameter_setting.quiet_gap_after_write_ms — live, from the first write after any running confirm */
  quiet_gap_after_write_ms: Accessor<number>;
  /** Only ever called with rounds that passed the plausibility gate, and never after disposal */
  onDecodedRound: (round: DecodedRound) => void;
  /** Overridable only so harnesses can point the whole engine at a pty instead of the inverter */
  devicePath?: string;
  /** Harnesses only (they scale the windows down) — production passes nothing */
  schedulerTimingOverrides?: Partial<Omit<SchedulerTiming, "quietGapAfterWriteMs">>;
}) {
  const [lastWriteAt, setLastWriteAt] = createSignal<number | undefined>(undefined);
  const [serialIsOpen, setSerialIsOpen] = createSignal(false);
  const state: SessionState = {
    poll_values_interval_seconds,
    onDecodedRound,
    setLastWriteAt,
    setSerialIsOpen,
    // onOpen can only fire after stty's await, by when `state` is initialized
    serialExchange: createSerialExchange({ devicePath, onOpen: () => onSerialOpened(state) }),
    scheduler: initialSchedulerState({
      ...schedulerTimingOverrides,
      quietGapAfterWriteMs: quietGapFromConfig(untrack(quiet_gap_after_write_ms)),
    }),
    queuedSetterItems: new Map(),
    commitTracker: new Map(),
    writesConfirmed: 0,
    writesNeverApplied: 0,
    disposed: false,
    pumpWaiter: undefined,
    consecutiveTransactFailures: 0,
    lastTransactFailureErrorLogAt: -Infinity,
    droppedImplausibleRounds: 0,
    pollRoundsCompleted: 0,
    gateDropEpisodes: {},
    warnImplausibleRound: createRateLimitedWarnLog(DROPPED_ROUND_LOG_INTERVAL_MS),
    warnDecodeProblem: createRateLimitedWarnLog(DROPPED_ROUND_LOG_INTERVAL_MS),
    countersAtLastStatsLog: undefined,
  };
  state.countersAtLastStatsLog = currentCounters(state);
  const statsTimer = setInterval(() => logStats(state), STATS_LOG_INTERVAL_MS);
  // Deferred: the initializer above already took (and, if needed, corrected) the boot value
  createEffect(
    on(
      quiet_gap_after_write_ms,
      configuredMs => (state.scheduler = schedulerWithQuietGapSetting(state.scheduler, configuredMs)),
      { defer: true }
    )
  );
  void runPump(state);

  onCleanup(() => {
    // From here on nothing reports: a disposed session (main() crash-restart) must go quietly
    state.disposed = true;
    clearInterval(statsTimer);
    state.serialExchange.close(); // settles the exchange in flight as "closed", no retry
    wakePump(state);
  });

  return {
    /**
     * Queue a control write as desired state (see SetterQueueItem). Same-prefix pending setters are
     * replaced; identical commands are rate-gated (60 s); one the readback already shows is dropped.
     */
    queueSetter: (item: SetterQueueItem) => queueSetter(state, item),
    /** When the last control write went out — the signal behind the quiet-gap poll suppression */
    lastWriteAt,
    serialIsOpen,
    /** Cumulative wire-level counters plus gate drops and completed poll rounds — for harnesses and debugging */
    exchangeCounters: () => currentCounters(state),
  };
}

type RateLimitedWarn = ReturnType<typeof createRateLimitedWarnLog>;
type PumpWaiter = { resolve: () => void; timer: ReturnType<typeof setTimeout> | undefined };

type SessionState = {
  poll_values_interval_seconds: Accessor<number>;
  onDecodedRound: (round: DecodedRound) => void;
  setLastWriteAt: Setter<number | undefined>;
  setSerialIsOpen: Setter<boolean>;
  serialExchange: SerialExchange;
  scheduler: SchedulerState;
  /** The consumer items behind the scheduler's queued commands — always updated together */
  queuedSetterItems: Map<string, SetterQueueItem>;
  commitTracker: SetterCommitTracker;
  writesConfirmed: number;
  writesNeverApplied: number;
  disposed: boolean;
  pumpWaiter: PumpWaiter | undefined;
  consecutiveTransactFailures: number;
  /** Monotonic ms */
  lastTransactFailureErrorLogAt: number;
  droppedImplausibleRounds: number;
  pollRoundsCompleted: number;
  gateDropEpisodes: GateDropEpisodes;
  warnImplausibleRound: RateLimitedWarn;
  warnDecodeProblem: RateLimitedWarn;
  countersAtLastStatsLog: InverterSessionCounters | undefined;
};

async function runPump(state: SessionState): Promise<void> {
  while (!state.disposed) {
    try {
      if (!state.serialExchange.isOpen()) {
        state.setSerialIsOpen(false);
        await waitUntilOrWoken(state, performance.now() + 1_000);
        continue;
      }
      const decision = decideNextAction(
        state.scheduler,
        performance.now(),
        untrack(state.poll_values_interval_seconds) * 1000
      );
      if (decision.action === "drop_setter") dropSatisfiedSetter(state, decision.command);
      else if (decision.action === "send_setter") await sendQueuedSetter(state, decision.command);
      else if (decision.action === "run_confirms") await runConfirms(state, decision.queries);
      else if (decision.action === "poll_round") await runPollRound(state, decision.includeSettingsPoll);
      else await waitUntilOrWoken(state, decision.untilMs);
    } catch (pumpError) {
      if (state.disposed) return;
      errorLog("Inverter session pump iteration failed", pumpError);
      await waitUntilOrWoken(state, performance.now() + 1_000); // never tight-loop on a persistent throw
    }
  }
}

function queueSetter(state: SessionState, item: SetterQueueItem): void {
  for (const [pendingCommand] of state.queuedSetterItems) {
    if (pendingCommand.startsWith(item.replacesPrefix)) state.queuedSetterItems.delete(pendingCommand);
  }
  state.queuedSetterItems.set(item.command, item);
  state.scheduler = withSetterQueued(state.scheduler, item.command, item.replacesPrefix, performance.now());
  wakePump(state);
}

function dropSatisfiedSetter(state: SessionState, command: string): void {
  state.queuedSetterItems.delete(command);
  state.scheduler = withSetterDequeued(state.scheduler, command);
  debugLog("Inverter setter", command, "dropped unsent — the latest readback already shows it");
}

/** Undefined when the query got no usable answer (no response, a round the gate dropped, or disposal) */
async function runQuery(state: SessionState, command: Pi17QueryCommandName): Promise<DecodedFields | undefined> {
  const description = `query ${command}`;
  const result = await state.serialExchange.exchange(buildQueryFrame(command), { kind: "query", command }, description);
  if ("closed" in result || state.disposed) return undefined;
  if ("failed" in result) {
    reportTransactFailure(state, description, result.failed);
    return undefined;
  }
  reportTransactSuccess(state);
  if (result.frame.kind !== "data") {
    // The query expectation only ever accepts data frames — reaching this is an attribution bug
    errorLog("Inverter answered", description, "with", result.frame.kind, "— expected a data frame");
    return undefined;
  }
  const { fields, problems } = decodeQueryPayload(command, result.frame.payloadText);
  for (const problem of problems) state.warnDecodeProblem("Decoding", command, "response:", problem);
  const implausibleFields = implausibleFieldsIn(fields);
  if (implausibleFields.length) {
    recordGateDrop(state, command, implausibleFields);
    return undefined;
  }
  recordGateAccept(state, command);
  if (isSettingsQuery(command)) {
    state.scheduler = withSettingsReadback(state.scheduler, command, fields, performance.now());
  }
  state.onDecodedRound({ command, fields, decodedAt: Date.now() });
  return fields;
}

function recordGateDrop(state: SessionState, command: Pi17QueryCommandName, implausibleFields: string[]): void {
  state.droppedImplausibleRounds++;
  state.warnImplausibleRound(
    "Dropping implausible",
    command,
    "round before any consumer sees it:",
    implausibleFields.join("; "),
    `(${state.droppedImplausibleRounds} dropped since start)`
  );
  const { episodes, escalation } = afterGateDrop(state.gateDropEpisodes, command, implausibleFields, performance.now());
  state.gateDropEpisodes = episodes;
  if (escalation) errorLog("Inverter plausibility gate:", escalation);
}

function recordGateAccept(state: SessionState, command: Pi17QueryCommandName): void {
  const { episodes, endedEpisode } = afterGateAccept(state.gateDropEpisodes, command);
  state.gateDropEpisodes = episodes;
  if (endedEpisode?.escalated) {
    logLog("Inverter", command, "rounds pass the plausibility gate again after", endedEpisode.droppedRounds, "drops");
  }
}

async function sendQueuedSetter(state: SessionState, command: string): Promise<void> {
  const item = state.queuedSetterItems.get(command);
  // The scheduler view and the item map are always updated together — a miss is a real bug
  if (!item) errorLog("Inverter session: no queued item for scheduled setter", command, "— sending without callbacks");
  state.queuedSetterItems.delete(command);
  state.scheduler = withSetterDequeued(state.scheduler, command);
  const description = `setter ${command}`;
  const result = await state.serialExchange.exchange(buildSetterFrame(command), { kind: "setter" }, description);
  if ("closed" in result || state.disposed) return;
  const sentAt = performance.now();
  state.setLastWriteAt(Date.now());
  const refreshQueries = item?.refreshAfterSend ?? [];
  if ("failed" in result) {
    reportTransactFailure(state, description, result.failed);
    // Old CLI contract: a command that never got a response invokes no callback — the owning
    // control loop's own retry logic (rate-limited by the identical-setter gate) handles it.
    state.scheduler = afterSetterSent(state.scheduler, command, refreshQueries, sentAt, false);
    return;
  }
  reportTransactSuccess(state);
  if (result.frame.kind === "ack") {
    state.scheduler = afterSetterSent(state.scheduler, command, refreshQueries, sentAt, true);
    reportAckedSetter(
      state.commitTracker,
      {
        command,
        // The gap the phase was armed with: a merged write keeps it, the starvation fallback replaces 0
        quietGapAfterWriteMs:
          state.scheduler.confirm?.quietGapAfterWriteMs ?? state.scheduler.timing.quietGapAfterWriteMs,
        ackLatencyMs: result.answeredAfterWriteMs,
        ackAttempts: result.attempts,
        ackedAtMs: sentAt,
      },
      state.scheduler.confirm,
      lineTraffic(state)
    );
    item?.onResult?.({ acknowledged: true });
    return;
  }
  if (result.frame.kind === "nak") {
    errorLog(
      "Inverter REJECTED (NAK)",
      command,
      "— settings unchanged",
      `(answered in ${Math.round(result.answeredAfterWriteMs)} ms)`
    );
  } else {
    // The setter expectation rejects data frames as late query responses — an attribution bug
    errorLog("Inverter answered setter", command, "with a data frame — treating as not applied");
  }
  state.scheduler = afterSetterSent(state.scheduler, command, refreshQueries, sentAt, false);
  item?.onResult?.({ acknowledged: false });
}

async function runConfirms(state: SessionState, queries: readonly SettingsQueryCommandName[]): Promise<void> {
  const decodedByQuery: Partial<Record<SettingsQueryCommandName, DecodedFields>> = {};
  for (const query of queries) {
    if (state.disposed) return;
    const fields = await runQuery(state, query);
    if (fields) decodedByQuery[query] = fields;
  }
  if (state.disposed) return;
  const strategy = state.scheduler.confirm?.strategy;
  const nowMs = performance.now();
  const { state: scheduler, result } = afterConfirmRun(state.scheduler, decodedByQuery, nowMs);
  state.scheduler = scheduler;
  if (!strategy) {
    // run_confirms is only ever decided from a confirm phase — reaching this is a scheduler bug
    errorLog("Inverter session: ran confirm queries", queries.join(", "), "without a confirm phase");
    return;
  }
  for (const record of reportConfirmOutcome(state.commitTracker, result, strategy, nowMs, lineTraffic(state))) {
    if (record.verdict === "confirmed") state.writesConfirmed++;
    if (record.verdict === "never_applied") state.writesNeverApplied++;
  }
}

async function runPollRound(state: SessionState, includeSettingsPoll: boolean): Promise<void> {
  const roundStartedAt = performance.now();
  const commands: readonly Pi17QueryCommandName[] = includeSettingsPoll
    ? [...BACKGROUND_POLL_COMMANDS, ...SETTINGS_POLL_COMMANDS]
    : BACKGROUND_POLL_COMMANDS;
  let hadFailures = false;
  for (const command of commands) {
    // A freshly queued control write preempts the rest of the round
    if (state.disposed || hasEligibleSetter(state.scheduler, performance.now())) break;
    if (!(await runQuery(state, command))) hadFailures = true;
  }
  if (state.disposed) return;
  state.scheduler = afterPollRound(state.scheduler, {
    startedAtMs: roundStartedAt,
    endedAtMs: performance.now(),
    includedSettingsPoll: includeSettingsPoll,
    hadFailures,
  });
  state.pollRoundsCompleted++;
}

function reportTransactFailure(state: SessionState, description: string, failure: string): void {
  state.consecutiveTransactFailures++;
  const now = performance.now();
  const summary = `(${state.consecutiveTransactFailures} consecutive failures)`;
  // First failure after healthy operation is loud; while the link stays dead, errorLog (= a push
  // notification candidate) at most once a minute and warnLog the rest — the staleness P2 alert
  // covers prolonged outages anyway.
  if (
    state.consecutiveTransactFailures === 1 ||
    now - state.lastTransactFailureErrorLogAt >= FAILURE_ERRORLOG_INTERVAL_MS
  ) {
    errorLog("Inverter", description, "failed:", failure, summary);
    state.lastTransactFailureErrorLogAt = now;
  } else {
    warnLog("Inverter", description, "failed:", failure, summary);
  }
}

function reportTransactSuccess(state: SessionState): void {
  if (state.consecutiveTransactFailures === 0) return;
  logLog("Inverter serial link recovered after", state.consecutiveTransactFailures, "consecutive failed exchanges");
  state.consecutiveTransactFailures = 0;
  state.lastTransactFailureErrorLogAt = -Infinity;
}

function lineTraffic(state: SessionState): LineTraffic {
  return {
    pollRoundsCompleted: state.pollRoundsCompleted,
    framesWritten: state.serialExchange.counters().framesWritten,
  };
}

function onSerialOpened(state: SessionState): void {
  state.setSerialIsOpen(true);
  wakePump(state);
}

function waitUntilOrWoken(state: SessionState, untilMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    const waiter: PumpWaiter = { resolve, timer: undefined };
    // Cap so a (theoretically impossible) Infinity can only ever nap, not hang the pump
    const delayMs = Math.min(Math.max(0, untilMs - performance.now()), 60_000);
    waiter.timer = setTimeout(() => settleWaiter(state, waiter), delayMs);
    state.pumpWaiter = waiter;
  });
}

function wakePump(state: SessionState): void {
  if (state.pumpWaiter) settleWaiter(state, state.pumpWaiter);
}

function settleWaiter(state: SessionState, waiter: PumpWaiter): void {
  clearTimeout(waiter.timer);
  if (state.pumpWaiter === waiter) state.pumpWaiter = undefined;
  waiter.resolve();
}

function isSettingsQuery(command: Pi17QueryCommandName): command is SettingsQueryCommandName {
  return SETTINGS_POLL_COMMANDS.some(settingsCommand => settingsCommand === command);
}

function currentCounters(state: SessionState): InverterSessionCounters {
  return {
    ...state.serialExchange.counters(),
    droppedImplausibleRounds: state.droppedImplausibleRounds,
    pollRoundsCompleted: state.pollRoundsCompleted,
    writesConfirmed: state.writesConfirmed,
    writesNeverApplied: state.writesNeverApplied,
  };
}

function logStats(state: SessionState): void {
  const counters = currentCounters(state);
  logSessionStats(counters, state.countersAtLastStatsLog ?? counters);
  state.countersAtLastStatsLog = counters;
}
