/**
 * THE one persistent PI17 session: a single command mutex over the serial device, with priority
 * control writes > confirm queries > background polls, and the post-write quiet gap the inverter's
 * commit behaviour demands (see schedulerCore.ts for the measured numbers). Replaces both the
 * external mpp-solar MQTT daemon and the per-command mpp-solar CLI spawns — and with them the
 * stop-daemon/run-CLI/start-daemon dance (5m48s MQTT blackout on 2026-07-18). No systemctl calls
 * anywhere in this path: the mpp-solar unit is retired at cutover.
 *
 * Scheduling state lives in pure schedulerCore functions and wire-level exchange safety in
 * serialExchange.ts; this file is the async shell that runs the pump, decodes, gates implausible
 * rounds (plausibilityGate.ts) before any consumer sees them, plus the reactive surface
 * (lastWriteAt / isOpen signals) for observers.
 */
import { type Accessor, createSignal, onCleanup, untrack } from "solid-js";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
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
import { createSerialExchange, type SerialExchangeCounters } from "./serialExchange.ts";
import { createRateLimitedWarnLog } from "../utilities/rateLimitedWarnLog.ts";
import {
  afterConfirmRun,
  afterPollRound,
  afterSetterSent,
  decideNextAction,
  hasEligibleSetter,
  initialSchedulerState,
  withSetterDequeued,
  withSetterQueued,
  type SchedulerState,
  type SchedulerTiming,
} from "./schedulerCore.ts";
import { INVERTER_SERIAL_DEVICE } from "./serialConnection.ts";

/** Implausible rounds and decode problems log their first occurrence, then at most once a minute */
const DROPPED_ROUND_LOG_INTERVAL_MS = 60_000;
/**
 * Periodic counter deltas + poll cadence in the log: the anomaly warns are rate-limited, so this is
 * where "how many frames were rejected / rounds dropped, and how fast are rounds" is answered.
 */
const STATS_LOG_INTERVAL_MS = 5 * 60_000;
/** The continuous background poll: GS+PS every round, settings queries on their slower cadence */
const BACKGROUND_POLL_COMMANDS = ["GS", "PS"] as const;
const SETTINGS_POLL_COMMANDS = ["GPMP", "HECS", "BATS"] as const;

export function createInverterSession({
  poll_values_interval_seconds,
  onDecodedRound,
  devicePath = INVERTER_SERIAL_DEVICE,
  schedulerTimingOverrides = {},
}: {
  /** Cadence of the slow settings poll — config().usb_parameter_setting.poll_values_interval_seconds */
  poll_values_interval_seconds: Accessor<number>;
  /** Only ever called with rounds that passed the plausibility gate */
  onDecodedRound: (round: DecodedRound) => void;
  /** Overridable only so harnesses can point the whole engine at a pty instead of the inverter */
  devicePath?: string;
  /** Harnesses and the quiet-gap experiment only (see SchedulerTiming) — production passes nothing */
  schedulerTimingOverrides?: Partial<SchedulerTiming>;
}) {
  const [lastWriteAt, setLastWriteAt] = createSignal<number | undefined>(undefined);
  const [serialIsOpen, setSerialIsOpen] = createSignal(false);

  let schedulerState: SchedulerState = initialSchedulerState(schedulerTimingOverrides);
  const queuedSetterItems = new Map<string, SetterQueueItem>();
  let disposed = false;
  let wakeWaiter: (() => void) | undefined;
  let consecutiveTransactFailures = 0;
  let lastTransactFailureErrorLogAt = 0;
  let droppedImplausibleRounds = 0;
  let pollRoundsCompleted = 0;
  const warnImplausibleRound = createRateLimitedWarnLog(DROPPED_ROUND_LOG_INTERVAL_MS);
  const warnDecodeProblem = createRateLimitedWarnLog(DROPPED_ROUND_LOG_INTERVAL_MS);

  const serialExchange = createSerialExchange({
    devicePath,
    onOpen: () => {
      setSerialIsOpen(true);
      wakePump();
    },
  });

  function wakePump() {
    wakeWaiter?.();
  }

  function waitUntilOrWoken(untilMs: number): Promise<void> {
    return new Promise<void>(resolve => {
      // Cap so a (theoretically impossible) Infinity can only ever nap, not hang the pump
      const timer = setTimeout(finish, Math.min(Math.max(0, untilMs - Date.now()), 60_000));
      function finish() {
        clearTimeout(timer);
        if (wakeWaiter === finish) wakeWaiter = undefined;
        resolve();
      }
      wakeWaiter = finish;
    });
  }

  function reportTransactFailure(description: string, failure: string) {
    consecutiveTransactFailures++;
    const now = Date.now();
    // First failure after healthy operation is loud; while the link stays dead, errorLog (= a push
    // notification candidate) at most once a minute and warnLog the rest — the mqtt-staleness P2
    // alert covers prolonged outages anyway.
    if (consecutiveTransactFailures === 1 || now - lastTransactFailureErrorLogAt >= 60_000) {
      errorLog("Inverter", description, "failed:", failure, `(${consecutiveTransactFailures} consecutive failures)`);
      lastTransactFailureErrorLogAt = now;
    } else {
      warnLog("Inverter", description, "failed:", failure, `(${consecutiveTransactFailures} consecutive failures)`);
    }
  }

  function reportTransactSuccess() {
    if (consecutiveTransactFailures > 0) {
      logLog("Inverter serial link recovered after", consecutiveTransactFailures, "consecutive failed exchanges");
      consecutiveTransactFailures = 0;
      lastTransactFailureErrorLogAt = 0;
    }
  }

  /** Undefined when the query got no usable answer (no response, or a round the gate dropped) */
  async function runQuery(command: Pi17QueryCommandName): Promise<DecodedFields | undefined> {
    const description = `query ${command}`;
    const result = await serialExchange.exchange(buildQueryFrame(command), { kind: "query", command }, description);
    if ("failed" in result) {
      reportTransactFailure(description, result.failed);
      return undefined;
    }
    reportTransactSuccess();
    if (result.frame.kind !== "data") {
      // The query expectation only ever accepts data frames — reaching this is an attribution bug
      errorLog("Inverter answered", description, "with", result.frame.kind, "— expected a data frame");
      return undefined;
    }
    const { fields, problems } = decodeQueryPayload(command, result.frame.payloadText);
    for (const problem of problems) warnDecodeProblem("Decoding", command, "response:", problem);
    const implausibleFields = implausibleFieldsIn(fields);
    if (implausibleFields.length) {
      droppedImplausibleRounds++;
      warnImplausibleRound(
        "Dropping implausible",
        command,
        "round before any consumer sees it:",
        implausibleFields.join("; "),
        `(${droppedImplausibleRounds} dropped since start)`
      );
      return undefined;
    }
    onDecodedRound({ command, fields, decodedAt: Date.now() });
    return fields;
  }

  async function sendQueuedSetter(command: string): Promise<void> {
    const item = queuedSetterItems.get(command);
    // The scheduler view and the item map are always updated together — a miss is a real bug
    if (!item)
      errorLog("Inverter session: no queued item for scheduled setter", command, "— sending without callbacks");
    queuedSetterItems.delete(command);
    schedulerState = withSetterDequeued(schedulerState, command);
    const description = `setter ${command}`;
    const result = await serialExchange.exchange(buildSetterFrame(command), { kind: "setter" }, description);
    const sentAt = Date.now();
    setLastWriteAt(sentAt);
    if ("failed" in result) {
      reportTransactFailure(description, result.failed);
      // Old CLI contract: a command that never got a response invokes no callback — the owning
      // control loop's own retry logic (rate-limited by the identical-setter gate) handles it.
      schedulerState = afterSetterSent(schedulerState, command, item?.refreshAfterSend ?? [], sentAt, false);
      return;
    }
    reportTransactSuccess();
    if (result.frame.kind === "ack") {
      logLog("Inverter ACKed", command, "— confirming actual commit via readback after the quiet gap");
      schedulerState = afterSetterSent(schedulerState, command, item?.refreshAfterSend ?? [], sentAt, true);
      item?.onResult?.({ acknowledged: true });
      return;
    }
    if (result.frame.kind === "nak") {
      errorLog("Inverter REJECTED (NAK)", command, "— settings unchanged");
    } else {
      // The setter expectation rejects data frames as late query responses — an attribution bug
      errorLog("Inverter answered setter", command, "with a data frame — treating as not applied");
    }
    schedulerState = afterSetterSent(schedulerState, command, item?.refreshAfterSend ?? [], sentAt, false);
    item?.onResult?.({ acknowledged: false });
  }

  async function runConfirms(queries: readonly SettingsQueryCommandName[]): Promise<void> {
    const decodedByQuery: Partial<Record<SettingsQueryCommandName, DecodedFields>> = {};
    for (const query of queries) {
      if (disposed) return;
      const fields = await runQuery(query);
      if (fields) decodedByQuery[query] = fields;
    }
    const { state, result } = afterConfirmRun(schedulerState, decodedByQuery, Date.now());
    schedulerState = state;
    if (result.outcome === "converged" && result.confirmedChecks.length) {
      logLog(
        "Inverter write(s) confirmed applied:",
        result.confirmedChecks.map(check => `${check.forCommand} → ${check.field}=${check.expectedValue}`).join(", ")
      );
    } else if (result.outcome === "retry") {
      warnLog(
        "Inverter write(s) not visible in readback yet — re-checking after quiet backoff:",
        result.failedChecks.map(check => check.forCommand).join(", ")
      );
    } else if (result.outcome === "gave_up") {
      errorLog(
        "Inverter ACKed but never applied within quiet gap + backoff:",
        result.failedChecks
          .map(check => `${check.forCommand} (wanted ${check.field}=${check.expectedValue})`)
          .join(", "),
        "— leaving any re-send to the owning control loop (rate-limited by the 60 s identical-setter gate)"
      );
    }
  }

  async function runPollRound(includeSettingsPoll: boolean): Promise<void> {
    const roundStartedAt = Date.now();
    const commands: readonly Pi17QueryCommandName[] = includeSettingsPoll
      ? [...BACKGROUND_POLL_COMMANDS, ...SETTINGS_POLL_COMMANDS]
      : BACKGROUND_POLL_COMMANDS;
    let hadFailures = false;
    for (const command of commands) {
      // A freshly queued control write preempts the rest of the round
      if (disposed || hasEligibleSetter(schedulerState, Date.now())) break;
      if (!(await runQuery(command))) hadFailures = true;
    }
    schedulerState = afterPollRound(schedulerState, {
      startedAtMs: roundStartedAt,
      endedAtMs: Date.now(),
      includedSettingsPoll: includeSettingsPoll,
      hadFailures,
    });
    pollRoundsCompleted++;
  }

  function currentCounters(): InverterSessionCounters {
    return { ...serialExchange.counters(), droppedImplausibleRounds, pollRoundsCompleted };
  }

  let countersAtLastStatsLog = currentCounters();
  const statsTimer = setInterval(() => {
    const counters = currentCounters();
    const deltas = counterDeltas(counters, countersAtLastStatsLog);
    const intervalMinutes = STATS_LOG_INTERVAL_MS / 60_000;
    logLog(
      `Inverter serial stats, last ${intervalMinutes} min:`,
      JSON.stringify(deltas),
      `(${(deltas.pollRoundsCompleted / intervalMinutes).toFixed(1)} poll rounds/min)`
    );
    countersAtLastStatsLog = counters;
  }, STATS_LOG_INTERVAL_MS);

  void (async function pump() {
    while (!disposed) {
      try {
        if (!serialExchange.isOpen()) {
          setSerialIsOpen(false);
          await waitUntilOrWoken(Date.now() + 1_000);
          continue;
        }
        const decision = decideNextAction(schedulerState, Date.now(), untrack(poll_values_interval_seconds) * 1000);
        if (decision.action === "send_setter") await sendQueuedSetter(decision.command);
        else if (decision.action === "run_confirms") await runConfirms(decision.queries);
        else if (decision.action === "poll_round") await runPollRound(decision.includeSettingsPoll);
        else await waitUntilOrWoken(decision.untilMs);
      } catch (pumpError) {
        errorLog("Inverter session pump iteration failed", pumpError);
        await waitUntilOrWoken(Date.now() + 1_000); // never tight-loop on a persistent throw
      }
    }
  })();

  onCleanup(() => {
    disposed = true;
    clearInterval(statsTimer);
    serialExchange.close();
    wakePump();
  });

  return {
    /** Queue a control write. Same-prefix pending setters are replaced; identical commands are rate-gated (60 s). */
    queueSetter(item: SetterQueueItem) {
      for (const [pendingCommand] of queuedSetterItems) {
        if (pendingCommand.startsWith(item.replacesPrefix)) queuedSetterItems.delete(pendingCommand);
      }
      queuedSetterItems.set(item.command, item);
      schedulerState = withSetterQueued(schedulerState, item.command, item.replacesPrefix, Date.now());
      wakePump();
    },
    /** When the last control write went out — the signal behind the quiet-gap poll suppression */
    lastWriteAt,
    serialIsOpen,
    /** Cumulative wire-level counters plus gate drops and completed poll rounds — for harnesses and debugging */
    exchangeCounters: currentCounters,
  };
}

type InverterSessionCounters = SerialExchangeCounters & {
  droppedImplausibleRounds: number;
  pollRoundsCompleted: number;
};

function counterDeltas(current: InverterSessionCounters, previous: InverterSessionCounters): InverterSessionCounters {
  const deltas = { ...current };
  for (const key of Object.keys(current) as (keyof InverterSessionCounters)[]) {
    deltas[key] = current[key] - previous[key];
  }
  return deltas;
}
