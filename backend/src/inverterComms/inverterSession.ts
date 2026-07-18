/**
 * THE one persistent PI17 session: a single command mutex over the serial device, with priority
 * control writes > confirm queries > background polls, and the post-write quiet gap the inverter's
 * commit behaviour demands (see schedulerCore.ts for the measured numbers). Replaces both the
 * external mpp-solar MQTT daemon and the per-command mpp-solar CLI spawns — and with them the
 * stop-daemon/run-CLI/start-daemon dance (5m48s MQTT blackout on 2026-07-18). No systemctl calls
 * anywhere in this path: the mpp-solar unit is retired at cutover.
 *
 * Scheduling state lives in pure schedulerCore functions; this file is the async shell that
 * performs I/O, plus the reactive surface (lastWriteAt / isOpen signals) for observers.
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
import {
  buildQueryFrame,
  buildSetterFrame,
  classifyFrame,
  createFrameAccumulator,
  type ClassifiedFrame,
} from "./pi17Frames.ts";
import { decodeQueryPayload } from "./pi17Decode.ts";
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
} from "./schedulerCore.ts";
import { createSerialConnection, INVERTER_SERIAL_DEVICE } from "./serialConnection.ts";

/**
 * 2400 baud ≈ 240 bytes/s and the longest routine response is ~120 B ≈ 0.5 s of wire time, so 3 s
 * is generous — on 2026-07-18 the inverter answered every single well-formed frame. One retry on
 * timeout, then the command fails loudly.
 */
const RESPONSE_TIMEOUT_MS = 3_000;
const RESPONSE_RETRIES = 1;
/** The continuous background poll: GS+PS every round, settings queries on their slower cadence */
const BACKGROUND_POLL_COMMANDS = ["GS", "PS"] as const;
const SETTINGS_POLL_COMMANDS = ["GPMP", "HECS", "BATS"] as const;

export function createInverterSession({
  poll_values_interval_seconds,
  onDecodedRound,
  devicePath = INVERTER_SERIAL_DEVICE,
}: {
  /** Cadence of the slow settings poll — config().usb_parameter_setting.poll_values_interval_seconds */
  poll_values_interval_seconds: Accessor<number>;
  onDecodedRound: (round: DecodedRound) => void;
  /** Overridable only so harnesses can point the whole engine at a pty instead of the inverter */
  devicePath?: string;
}) {
  const [lastWriteAt, setLastWriteAt] = createSignal<number | undefined>(undefined);
  const [serialIsOpen, setSerialIsOpen] = createSignal(false);

  let schedulerState: SchedulerState = initialSchedulerState();
  const queuedSetterItems = new Map<string, SetterQueueItem>();
  let disposed = false;
  let wakeWaiter: (() => void) | undefined;
  let resolveInFlight: ((frame: ClassifiedFrame) => void) | undefined;
  let consecutiveTransactFailures = 0;
  let lastTransactFailureErrorLogAt = 0;

  const frameAccumulator = createFrameAccumulator();
  const connection = createSerialConnection({
    devicePath,
    onData: chunk => {
      const { frames, discardedByteCount, problems } = frameAccumulator.push(chunk);
      if (discardedByteCount) warnLog("Discarded", discardedByteCount, "stray byte(s) from the inverter serial stream");
      for (const problem of problems) warnLog("Inverter serial framing:", problem);
      for (const frame of frames) {
        const classified = classifyFrame(frame);
        if (classified.kind === "invalid") {
          warnLog("Dropping invalid frame from inverter:", classified.reason);
          continue;
        }
        if (resolveInFlight) {
          // Strict request-response protocol: the first valid frame belongs to the in-flight command
          resolveInFlight(classified);
        } else {
          warnLog("Unsolicited", classified.kind, "frame from inverter (no command in flight) — ignoring");
        }
      }
    },
    onOpen: () => {
      const droppedByteCount = frameAccumulator.flush();
      if (droppedByteCount) warnLog("Dropped", droppedByteCount, "buffered byte(s) from before the serial reopen");
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

  /** Send one frame and wait for the response frame (or timeout). The pump's strict sequencing is the mutex. */
  function transactOnce(frameBytes: Buffer, description: string): Promise<ClassifiedFrame | "timeout"> {
    // A previous timed-out exchange may still have bytes trickling in — they must never be
    // matched to this command, so drop anything buffered before sending.
    const staleByteCount = frameAccumulator.flush();
    if (staleByteCount) warnLog("Flushed", staleByteCount, "stale buffered byte(s) before sending", description);
    return new Promise<ClassifiedFrame | "timeout">((resolve, reject) => {
      let settled = false;
      const resolveWithFrame = (frame: ClassifiedFrame) => {
        clearTimeout(timer);
        if (resolveInFlight === resolveWithFrame) resolveInFlight = undefined;
        settled = true;
        resolve(frame);
      };
      const timer = setTimeout(() => {
        if (resolveInFlight === resolveWithFrame) resolveInFlight = undefined;
        settled = true;
        resolve("timeout");
      }, RESPONSE_TIMEOUT_MS);
      resolveInFlight = resolveWithFrame;
      connection.write(frameBytes).catch((writeError: unknown) => {
        if (settled) {
          // Rejecting a settled promise is a silent no-op — this write error must still be heard
          warnLog("Inverter serial write for", description, "failed after the exchange already settled", writeError);
          return;
        }
        clearTimeout(timer);
        if (resolveInFlight === resolveWithFrame) resolveInFlight = undefined;
        settled = true;
        reject(writeError);
      });
    });
  }

  async function transactWithRetry(
    frameBytes: Buffer,
    description: string
  ): Promise<ClassifiedFrame | { failed: string }> {
    for (let attempt = 0; attempt <= RESPONSE_RETRIES; attempt++) {
      let result: ClassifiedFrame | "timeout";
      try {
        result = await transactOnce(frameBytes, description);
      } catch (writeError) {
        // The write itself failed (device closed/unplugged — serialConnection already logs and reopens)
        return { failed: `write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}` };
      }
      if (result !== "timeout") {
        reportTransactSuccess();
        return result;
      }
      if (attempt < RESPONSE_RETRIES) {
        warnLog("No response to", description, "within", RESPONSE_TIMEOUT_MS, "ms — retrying once");
      }
    }
    return { failed: `no response within ${RESPONSE_TIMEOUT_MS} ms (after ${RESPONSE_RETRIES + 1} attempts)` };
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

  async function runQuery(command: Pi17QueryCommandName): Promise<DecodedFields | undefined> {
    const description = `query ${command}`;
    const result = await transactWithRetry(buildQueryFrame(command), description);
    if ("failed" in result) {
      reportTransactFailure(description, result.failed);
      return undefined;
    }
    if (result.kind !== "data") {
      errorLog("Inverter answered", description, "with", result.kind, "— expected a data frame");
      return undefined;
    }
    const { fields, problems } = decodeQueryPayload(command, result.payloadText);
    for (const problem of problems) warnLog("Decoding", command, "response:", problem);
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
    const result = await transactWithRetry(buildSetterFrame(command), description);
    const sentAt = Date.now();
    setLastWriteAt(sentAt);
    if ("failed" in result) {
      reportTransactFailure(description, result.failed);
      // Old CLI contract: a command that never got a response invokes no callback — the owning
      // control loop's own retry logic (rate-limited by the identical-setter gate) handles it.
      schedulerState = afterSetterSent(schedulerState, command, item?.refreshAfterSend ?? [], sentAt, false);
      return;
    }
    if (result.kind === "ack") {
      logLog("Inverter ACKed", command, "— confirming actual commit via readback after the quiet gap");
      schedulerState = afterSetterSent(schedulerState, command, item?.refreshAfterSend ?? [], sentAt, true);
      item?.onResult?.({ acknowledged: true });
      return;
    }
    if (result.kind === "nak") {
      errorLog("Inverter REJECTED (NAK)", command, "— settings unchanged");
    } else {
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
    for (const command of commands) {
      // A freshly queued control write preempts the rest of the round
      if (disposed || hasEligibleSetter(schedulerState, Date.now())) break;
      await runQuery(command);
    }
    schedulerState = afterPollRound(schedulerState, roundStartedAt, includeSettingsPoll);
  }

  void (async function pump() {
    while (!disposed) {
      try {
        if (!connection.isOpen()) {
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
    connection.close();
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
  };
}
