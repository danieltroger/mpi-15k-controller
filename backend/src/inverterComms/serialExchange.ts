/**
 * One request/response exchange at a time on the inverter serial line — and the rules that keep a
 * response from ever being credited to the wrong command (the first production cutover on
 * 2026-10-25 had to be rolled back because of exactly that; see pi17ResponseShapes.ts):
 *
 * 1. The response timer starts only once the frame is actually written: serialConnection's write
 *    resolves on libuv's write-completion event for the non-blocking tty stream — no threadpool
 *    queue between "sent" and "on the wire".
 * 2. A frame is accepted only if it can answer the command in flight (setters: ACK/NAK; queries:
 *    a data frame of that query's shape). Anything else is rejected, counted and logged, and the
 *    exchange keeps waiting for its real answer.
 * 3. After any anomaly — timeout, rejected/invalid/unsolicited frame, stray bytes — the line must
 *    fall silent for LINE_QUIET_BEFORE_SEND_MS before the next frame goes out, and everything
 *    buffered is flushed, so a late response can't land on the next command.
 * 4. A timeout is only declared after the event loop has had its I/O turn (setImmediate): after a
 *    main-thread stall the timer and an already-arrived response become ready together, and libuv
 *    runs timers before I/O callbacks.
 * 5. One retry, then the exchange fails loudly (the session errorLogs it).
 */
import { classifyFrame, createFrameAccumulator, type ClassifiedFrame } from "./pi17Frames.ts";
import { frameMismatchForExpectation, type ExchangeExpectation } from "./pi17ResponseShapes.ts";
import { createSerialConnection, type SerialConnection } from "./serialConnection.ts";
import { createRateLimitedWarnLog } from "../utilities/rateLimitedWarnLog.ts";
import { warnLog } from "../utilities/logging.ts";
import { wait } from "../vendor/depictUtilishared.ts";

/**
 * 2400 baud ≈ 240 bytes/s and the longest routine response is ~120 B ≈ 0.5 s of wire time; the
 * inverter starts answering within ~50 ms (strace on the live pi, 2026-10-25). 3 s is generous.
 */
export const RESPONSE_TIMEOUT_MS = 3_000;
export const RESPONSE_RETRIES = 1;
/** Silence required on the line after an anomaly before anything is sent again */
export const LINE_QUIET_BEFORE_SEND_MS = 300;
/** A line that never falls silent still gets flushed and a fresh attempt after this long */
export const LINE_QUIET_MAX_WAIT_MS = 5_000;
/** Each anomaly category logs its first occurrence, then at most once per this interval (with a count) */
const ANOMALY_LOG_INTERVAL_MS = 60_000;

export type AcceptedFrame = Exclude<ClassifiedFrame, { kind: "invalid" }>;
export type ExchangeResult = { frame: AcceptedFrame } | { failed: string };

/** Cumulative counts since the session started — observability for harnesses and debugging */
export type SerialExchangeCounters = {
  framesWritten: number;
  framesAccepted: number;
  /** Valid frames that could not answer the command in flight (late/stray responses) */
  framesRejected: number;
  invalidFrames: number;
  unsolicitedFrames: number;
  discardedBytes: number;
  timeouts: number;
  quietWaits: number;
};

export type SerialExchange = {
  exchange(frameBytes: Buffer, expectation: ExchangeExpectation, description: string): Promise<ExchangeResult>;
  isOpen(): boolean;
  close(): void;
  counters(): SerialExchangeCounters;
};

export function createSerialExchange({
  devicePath,
  onOpen,
}: {
  devicePath: string;
  /** After each successful (re)open of the device */
  onOpen: () => void;
}): SerialExchange {
  const state: ExchangeState = {
    connection: undefined,
    frameAccumulator: createFrameAccumulator(),
    inFlight: undefined,
    lastByteReceivedAt: 0,
    lineNeedsQuiet: false,
    lineNeedsQuietSince: 0,
    counters: {
      framesWritten: 0,
      framesAccepted: 0,
      framesRejected: 0,
      invalidFrames: 0,
      unsolicitedFrames: 0,
      discardedBytes: 0,
      timeouts: 0,
      quietWaits: 0,
    },
    warnStrayBytes: createRateLimitedWarnLog(ANOMALY_LOG_INTERVAL_MS),
    warnFramingProblem: createRateLimitedWarnLog(ANOMALY_LOG_INTERVAL_MS),
    warnInvalidFrame: createRateLimitedWarnLog(ANOMALY_LOG_INTERVAL_MS),
    warnUnsolicitedFrame: createRateLimitedWarnLog(ANOMALY_LOG_INTERVAL_MS),
    warnRejectedFrame: createRateLimitedWarnLog(ANOMALY_LOG_INTERVAL_MS),
    warnFlushedBytes: createRateLimitedWarnLog(ANOMALY_LOG_INTERVAL_MS),
  };
  const connection = createSerialConnection({
    devicePath,
    onData: chunk => handleIncomingBytes(state, chunk),
    onOpen: () => {
      const droppedByteCount = state.frameAccumulator.flush();
      if (droppedByteCount) warnLog("Dropped", droppedByteCount, "buffered byte(s) from before the serial reopen");
      onOpen();
    },
  });
  state.connection = connection;
  return {
    exchange: (frameBytes, expectation, description) => exchangeWithRetry(state, frameBytes, expectation, description),
    isOpen: () => connection.isOpen(),
    close: () => connection.close(),
    counters: () => ({ ...state.counters }),
  };
}

type InFlightExchange = {
  expectation: ExchangeExpectation;
  description: string;
  rejectedFrameReasons: string[];
  settle: (outcome: SingleAttemptOutcome) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

type SingleAttemptOutcome = { answered: AcceptedFrame } | { timedOut: true; rejectedFrameReasons: string[] };

type RateLimitedWarn = ReturnType<typeof createRateLimitedWarnLog>;

type ExchangeState = {
  connection: SerialConnection | undefined;
  frameAccumulator: ReturnType<typeof createFrameAccumulator>;
  inFlight: InFlightExchange | undefined;
  lastByteReceivedAt: number;
  lineNeedsQuiet: boolean;
  /** When the most recent anomaly happened — the quiet window counts from here or the last byte, whichever is later */
  lineNeedsQuietSince: number;
  counters: SerialExchangeCounters;
  warnStrayBytes: RateLimitedWarn;
  warnFramingProblem: RateLimitedWarn;
  warnInvalidFrame: RateLimitedWarn;
  warnUnsolicitedFrame: RateLimitedWarn;
  warnRejectedFrame: RateLimitedWarn;
  warnFlushedBytes: RateLimitedWarn;
};

async function exchangeWithRetry(
  state: ExchangeState,
  frameBytes: Buffer,
  expectation: ExchangeExpectation,
  description: string
): Promise<ExchangeResult> {
  const rejectedAcrossAttempts: string[] = [];
  for (let attempt = 0; attempt <= RESPONSE_RETRIES; attempt++) {
    let outcome: SingleAttemptOutcome;
    try {
      outcome = await exchangeOnce(state, frameBytes, expectation, description);
    } catch (writeError) {
      // The write itself failed (device closed/unplugged — serialConnection already logs and reopens)
      return { failed: `write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}` };
    }
    if ("answered" in outcome) return { frame: outcome.answered };
    rejectedAcrossAttempts.push(...outcome.rejectedFrameReasons);
    if (attempt < RESPONSE_RETRIES) {
      warnLog(
        "No matching response to",
        description,
        "within",
        RESPONSE_TIMEOUT_MS,
        "ms — retrying once the line is quiet",
        describeRejections(outcome.rejectedFrameReasons)
      );
    }
  }
  return {
    failed: `no matching response within ${RESPONSE_TIMEOUT_MS} ms (after ${RESPONSE_RETRIES + 1} attempts)${describeRejections(rejectedAcrossAttempts)}`,
  };
}

async function exchangeOnce(
  state: ExchangeState,
  frameBytes: Buffer,
  expectation: ExchangeExpectation,
  description: string
): Promise<SingleAttemptOutcome> {
  if (state.lineNeedsQuiet) await waitForQuietLine(state, description);
  // Whatever is still buffered belongs to an earlier exchange — never match it to this command
  const staleByteCount = state.frameAccumulator.flush();
  if (staleByteCount)
    state.warnFlushedBytes("Flushed", staleByteCount, "stale buffered byte(s) before sending", description);
  if (!state.connection) throw new Error("Inverter serial exchange used before its connection exists");
  // libuv runs write-completion callbacks in its pending phase, before the poll phase delivers
  // reads, so the in-flight exchange below exists before any answer can be processed (and a frame
  // that somehow beat it would only count as unsolicited — never be misattributed).
  await state.connection.write(frameBytes);
  state.counters.framesWritten++;
  return new Promise<SingleAttemptOutcome>(resolve => {
    const inFlight: InFlightExchange = {
      expectation,
      description,
      rejectedFrameReasons: [],
      settle: resolve,
      timer: undefined,
    };
    state.inFlight = inFlight;
    inFlight.timer = setTimeout(
      () =>
        setImmediate(() => {
          if (state.inFlight !== inFlight) return; // answered during the I/O turn we just yielded
          state.inFlight = undefined;
          state.counters.timeouts++;
          markLineNeedsQuiet(state); // a late answer may still be on its way
          resolve({ timedOut: true, rejectedFrameReasons: inFlight.rejectedFrameReasons });
        }),
      RESPONSE_TIMEOUT_MS
    );
  });
}

function handleIncomingBytes(state: ExchangeState, chunk: Buffer): void {
  state.lastByteReceivedAt = Date.now();
  const { frames, discardedByteCount, problems } = state.frameAccumulator.push(chunk);
  if (discardedByteCount) {
    state.counters.discardedBytes += discardedByteCount;
    markLineNeedsQuiet(state);
    state.warnStrayBytes("Discarded", discardedByteCount, "stray byte(s) from the inverter serial stream");
  }
  for (const problem of problems) {
    markLineNeedsQuiet(state);
    state.warnFramingProblem("Inverter serial framing:", problem);
  }
  for (const frame of frames) {
    const classified = classifyFrame(frame);
    if (classified.kind === "invalid") {
      state.counters.invalidFrames++;
      markLineNeedsQuiet(state);
      state.warnInvalidFrame("Dropping invalid frame from inverter:", classified.reason);
      continue;
    }
    const inFlight = state.inFlight;
    if (!inFlight) {
      state.counters.unsolicitedFrames++;
      markLineNeedsQuiet(state);
      state.warnUnsolicitedFrame(
        "Unsolicited",
        classified.kind,
        "frame from inverter (no command in flight) — ignoring"
      );
      continue;
    }
    const mismatch = frameMismatchForExpectation(inFlight.expectation, classified);
    if (mismatch !== undefined) {
      state.counters.framesRejected++;
      inFlight.rejectedFrameReasons.push(mismatch);
      markLineNeedsQuiet(state);
      state.warnRejectedFrame("Rejected a frame while", inFlight.description, "was in flight —", mismatch);
      continue;
    }
    state.counters.framesAccepted++;
    clearTimeout(inFlight.timer);
    state.inFlight = undefined;
    inFlight.settle({ answered: classified });
  }
}

async function waitForQuietLine(state: ExchangeState, description: string): Promise<void> {
  state.counters.quietWaits++;
  const waitStartedAt = Date.now();
  while (true) {
    const now = Date.now();
    const quietForMs = now - Math.max(state.lastByteReceivedAt, state.lineNeedsQuietSince);
    if (quietForMs >= LINE_QUIET_BEFORE_SEND_MS) break;
    if (now - waitStartedAt >= LINE_QUIET_MAX_WAIT_MS) {
      warnLog(
        "Inverter serial line still not quiet after",
        LINE_QUIET_MAX_WAIT_MS,
        "ms — flushing and sending",
        description,
        "anyway (frame attribution still guards the answer)"
      );
      break;
    }
    await wait(LINE_QUIET_BEFORE_SEND_MS - quietForMs);
  }
  state.lineNeedsQuiet = false;
}

function markLineNeedsQuiet(state: ExchangeState): void {
  state.lineNeedsQuiet = true;
  state.lineNeedsQuietSince = Date.now();
}

function describeRejections(reasons: readonly string[]): string {
  if (!reasons.length) return "";
  const shown = reasons.slice(0, 3).join("; ");
  return ` (rejected ${reasons.length} non-matching frame(s): ${shown}${reasons.length > 3 ? "; …" : ""})`;
}
