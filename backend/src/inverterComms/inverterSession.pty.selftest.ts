/**
 * End-to-end self-test of the whole native serial engine — createInverterSession with its real
 * serialConnection/serialExchange/scheduler — against a fake inverter on a pty
 * (fakePi17Inverter.py), with every libuv threadpool thread blocked for the entire run.
 *
 * That blocked pool is the point. On the live pi the pool is shared with the 15 one-wire
 * thermometer reads, and at the first production cutover (2026-10-25) serial writes queued behind
 * them for seconds: retries doubled up, a PS response landed while GS was in flight, and the
 * GS-decoded PS frame published battery_voltage −30.9 V. Here the pool can't run a single job, so
 * any threadpool dependency left in the serial path stalls the engine and fails the throughput
 * checks, while the fake replays the wire-level faults (stale frames of the wrong command, lost
 * and late answers, an implausible round, a CRC-corrupt frame, the firmware's CRC byte bump) and
 * a 3.5 s main-thread stall.
 *
 * Run from backend/ with:  yarn node src/inverterComms/inverterSession.pty.selftest.ts
 * Needs python3 and Linux ptys (both present on ubuntu-latest CI runners). Takes ~35 s.
 */
import process from "process";
import { spawn, spawnSync, execFileSync, type ChildProcessWithoutNullStreams } from "child_process";
import { closeSync, constants as fsConstants, mkdtempSync, openSync, readFile, stat } from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { createRoot } from "solid-js";
import { createInverterSession } from "./inverterSession.ts";
import type { DecodedRound } from "./pi17Protocol.types.ts";
import { implausibleFieldsIn } from "./plausibilityGate.ts";
import { LINE_QUIET_BEFORE_SEND_MS, RESPONSE_TIMEOUT_MS } from "./serialExchange.ts";

const FAKE_INVERTER_SCRIPT = fileURLToPath(new URL("./fakePi17Inverter.py", import.meta.url));
/** More blocked jobs than the pool has threads (default 4; production runs UV_THREADPOOL_SIZE=32) */
const THREADPOOL_BLOCKERS = Math.max(64, 2 * Number(process.env.UV_THREADPOOL_SIZE ?? 4));
const EVENT_LOOP_STALL_MS = 3_500;
/** After the faults and the stall settle, GS cadence is measured over this window (median gap) */
const SETTLED_WINDOW_MS = 8_000;
/** ≤ 1.33 s per GS+PS round; the retired daemon managed ~1.2 s, the live engine ~1.15 s */
const MAX_MEDIAN_GS_GAP_MS = 1_330;
const HARD_TIMEOUT_MS = 90_000;
/** Values every fake GS/PS answer carries (the live 2026-10-25 frames) — a misattributed frame can't */
const FAKE_GS_BATTERY_VOLTAGE = 53.2;
const FAKE_PS_SOLAR_POWER_1 = 80;

type FrameRole = "answer" | "stale" | "late" | "implausible" | "corrupt" | "duplicate";
type FakeInverterEvent =
  | { event: "ready"; t: number; device: string }
  | {
      event: "received";
      t: number;
      command: string;
      overlap: boolean;
      ms_since_last_tx_byte: number;
      follows_anomaly: boolean;
    }
  | {
      event: "frame_sent";
      t: number;
      frame_command: string;
      answering: string;
      role: FrameRole;
      serial: number | null;
    }
  | { event: "committed"; t: number; setter: string }
  | { event: "fault"; t: number; fault: string }
  | { event: "faults_done"; t: number }
  | { event: "lost"; t: number; answering: string }
  | { event: "setter_answer_held"; t: number; answering: string }
  | { event: "crc_bumped_answer"; t: number; serial: number; crc: string }
  | { event: "summary"; t: number; overlaps: number; counts: Record<string, number>; faults_remaining: string[] }
  | { event: "garbage" | "unparseable_command" | "unknown_query"; t: number };

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

/** Set once the pool is blocked — every exit path must run it first (see the hard timeout) */
let releaseBlockedThreadpool: (() => Promise<void>) | undefined;
const hardTimeout = setTimeout(() => {
  console.error(`FAIL: end-to-end run did not finish within ${HARD_TIMEOUT_MS} ms`);
  // process.exit() never returns while pool threads are parked: libuv joins them on shutdown.
  // Unpark them first; if even that hangs, SIGKILL ourselves so CI can't hang on this test.
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 5_000).unref();
  void (releaseBlockedThreadpool?.() ?? Promise.resolve()).finally(() => process.exit(1));
}, HARD_TIMEOUT_MS);

await runEndToEnd();
clearTimeout(hardTimeout);
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all inverterSession pty selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

async function runEndToEnd(): Promise<void> {
  const python = spawnSync("python3", ["--version"], { encoding: "utf-8" });
  if (python.status !== 0) {
    check("python3 is available for the fake inverter", false, String(python.error ?? python.stderr));
    return;
  }

  // Block the whole pool BEFORE the engine exists, so even its device open must avoid it
  const threadpool = blockEntireThreadpool();
  releaseBlockedThreadpool = threadpool.release;
  const fake = startFakeInverter();
  const device = await fake.ready;
  console.log("fake inverter on", device, "— threadpool blocked by", THREADPOOL_BLOCKERS, "FIFO opens");

  const decodedRounds: DecodedRound[] = [];
  const setterResults = new Map<string, boolean>();
  let session: ReturnType<typeof createInverterSession> | undefined;
  const disposeRoot = createRoot(dispose => {
    session = createInverterSession({
      devicePath: device,
      poll_values_interval_seconds: () => 8,
      onDecodedRound: round => decodedRounds.push(round),
      // Harness speed only: the production quiet gap (12 s) / backoff (30 s) are unchanged
      schedulerTimingOverrides: { quietGapAfterWriteMs: 1_500, confirmBackoffMs: 3_000 },
    });
    return dispose;
  });
  if (!session) throw new Error("createInverterSession returned nothing");
  const engine = session;
  const startedAt = Date.now();

  setTimeout(
    () =>
      engine.queueSetter({
        command: "GPMP000950",
        replacesPrefix: "GPMP0",
        refreshAfterSend: ["GPMP"],
        onResult: ({ acknowledged }) => setterResults.set("GPMP000950", acknowledged),
      }),
    4_000
  );
  setTimeout(
    () =>
      engine.queueSetter({
        command: "MCHGV0570,0570",
        replacesPrefix: "MCHGV",
        refreshAfterSend: ["BATS"],
        onResult: ({ acknowledged }) => setterResults.set("MCHGV0570,0570", acknowledged),
      }),
    9_000
  );
  // A burst (the evening-feed flip): the fake holds EDF0's first answer, then sends it late together
  // with the retry's own NAK 150 ms later — which must not be credited to EDG0
  setTimeout(() => {
    for (const command of ["EDF0", "EDG0"] as const) {
      engine.queueSetter({
        command,
        replacesPrefix: command.slice(0, 3),
        refreshAfterSend: ["HECS"],
        onResult: ({ acknowledged }) => setterResults.set(command, acknowledged),
      });
    }
  }, 14_000);

  // Once every wire fault has been served: stall the main thread for longer than the response
  // timeout right after a frame goes out. Its answer lands in the kernel buffer meanwhile; the
  // engine must take it rather than declare a timeout first (timers run before I/O in libuv).
  await fake.faultsDone;
  const stall = await stallRightAfterNextWrite(engine);
  await sleep(2_000);
  const timeoutsAfterStall = engine.exchangeCounters().timeouts;

  const settledWindowStart = Date.now();
  await sleep(SETTLED_WINDOW_MS);
  const settledGsTimes = decodedRounds
    .filter(round => round.command === "GS" && round.decodedAt >= settledWindowStart)
    .map(round => round.decodedAt);
  const settledGsGaps = settledGsTimes.slice(1).map((time, index) => time - settledGsTimes[index]!);
  const medianGsGapMs = median(settledGsGaps);

  const counters = engine.exchangeCounters();
  const threadpoolStillBlocked = !threadpool.probeCompleted();
  const runDurationMs = Date.now() - startedAt;
  disposeRoot();
  const fakeEvents = await fake.stop();
  await threadpool.release();

  console.log("engine counters:", JSON.stringify(counters));
  console.log(
    `${decodedRounds.length} decoded rounds in ${(runDurationMs / 1000).toFixed(1)} s;`,
    `median GS gap ${medianGsGapMs?.toFixed(0)} ms over ${settledGsGaps.length} gaps in the settled ${SETTLED_WINDOW_MS} ms window`
  );

  evaluate({
    decodedRounds,
    fakeEvents,
    counters,
    setterResults,
    stall,
    timeoutsAfterStall,
    medianGsGapMs,
    threadpoolStillBlocked,
  });
}

function evaluate({
  decodedRounds,
  fakeEvents,
  counters,
  setterResults,
  stall,
  timeoutsAfterStall,
  medianGsGapMs,
  threadpoolStillBlocked,
}: {
  decodedRounds: readonly DecodedRound[];
  fakeEvents: readonly FakeInverterEvent[];
  counters: ReturnType<ReturnType<typeof createInverterSession>["exchangeCounters"]>;
  setterResults: ReadonlyMap<string, boolean>;
  stall: { timeoutsBefore: number; framesWrittenAtStall: number };
  timeoutsAfterStall: number;
  medianGsGapMs: number | undefined;
  threadpoolStillBlocked: boolean;
}) {
  check("the threadpool stayed blocked for the whole run (the probe job never ran)", threadpoolStillBlocked);

  const summary = fakeEvents.find(event => event.event === "summary");
  check("fake inverter reported a summary", summary !== undefined);
  if (summary?.event === "summary") {
    check(
      "every planned wire fault was served",
      summary.faults_remaining.length === 0,
      summary.faults_remaining.join(",")
    );
    check(
      "no duplicated in-flight command: nothing was sent while an answer was due or on the wire",
      summary.overlaps === 0,
      `${summary.overlaps} overlap(s)`
    );
  }

  // ---- attribution: every decoded round maps to a genuine answer frame of its own command ----
  const framesSent = fakeEvents.flatMap(event => (event.event === "frame_sent" ? [event] : []));
  const gsRounds = decodedRounds.filter(round => round.command === "GS");
  const psRounds = decodedRounds.filter(round => round.command === "PS");
  const highestSerial = Math.max(0, ...framesSent.map(frame => frame.serial ?? 0));
  check("serial markers stayed unambiguous (GS marker is serial mod 100)", highestSerial < 100, `max ${highestSerial}`);
  const misattributedGs = gsRounds.filter(round => {
    const marker = round.fields.inner_temperature;
    const source = framesSent.find(frame => frame.serial !== null && frame.serial % 100 === marker);
    return !source || source.frame_command !== "GS" || (source.role !== "answer" && source.role !== "late");
  });
  check(
    "every GS round came from a GS answer frame (none from stale/implausible/corrupt or other-command frames)",
    gsRounds.length > 0 && misattributedGs.length === 0,
    `${misattributedGs.length} of ${gsRounds.length} misattributed`
  );
  const misattributedPs = psRounds.filter(round => {
    const source = framesSent.find(frame => frame.serial === round.fields.solar_input_power_2);
    return !source || source.frame_command !== "PS" || source.role !== "answer";
  });
  check(
    "every PS round came from a PS answer frame",
    psRounds.length > 0 && misattributedPs.length === 0,
    `${misattributedPs.length} of ${psRounds.length} misattributed`
  );
  check(
    "every GS round carries the fake's GS values (a foreign frame decoded as GS could not)",
    gsRounds.every(
      round => round.fields.battery_voltage === FAKE_GS_BATTERY_VOLTAGE && round.fields.battery_capacity === 73
    )
  );
  check(
    "every PS round carries the fake's PS values",
    psRounds.every(round => round.fields.solar_input_power_1 === FAKE_PS_SOLAR_POWER_1)
  );
  check(
    "no round carries the GS-as-PS misdecode's surplus fields",
    decodedRounds.every(
      round => !Object.keys(round.fields).some(name => /^unknown_value_in_response_2[2-4]$/.test(name))
    )
  );
  check(
    "the stale frames were all served yet never decoded",
    framesSent.filter(frame => frame.role === "stale").length === 3 && counters.framesRejected >= 3,
    `framesRejected=${counters.framesRejected}`
  );

  // ---- plausibility: nothing implausible reached a consumer ----
  const implausiblePublished = decodedRounds.filter(round => implausibleFieldsIn(round.fields).length > 0);
  check("no published round fails the plausibility gate", implausiblePublished.length === 0);
  check(
    "the fake's 30.9 V GS round was served, dropped and never published",
    framesSent.some(frame => frame.role === "implausible") &&
      counters.droppedImplausibleRounds >= 1 &&
      gsRounds.every(round => Number(round.fields.battery_voltage) >= 40)
  );
  check(
    "the CRC-corrupt frame was the only invalid frame (every firmware-bumped CRC was accepted)",
    counters.invalidFrames === 1,
    `invalidFrames=${counters.invalidFrames}`
  );
  const bumpedAnswerSerial = fakeEvents.flatMap(event =>
    event.event === "crc_bumped_answer" ? [event.serial] : []
  )[0];
  const bumpedAnswerCrc = fakeEvents.flatMap(event => (event.event === "crc_bumped_answer" ? [event.crc] : []))[0];
  check(
    "the answer with a mixed CRC (one byte 0x00, the other bumped) was decoded",
    bumpedAnswerSerial !== undefined &&
      gsRounds.some(round => round.fields.inner_temperature === bumpedAnswerSerial % 100),
    `serial ${bumpedAnswerSerial}, sent CRC ${bumpedAnswerCrc}`
  );

  // ---- timeouts, retries and the quiet line ----
  const received = fakeEvents.flatMap(event => (event.event === "received" ? [event] : []));
  const lostAt = fakeEvents.find(event => event.event === "lost")?.t;
  const retryAfterLoss = lostAt === undefined ? undefined : received.find(event => event.t > lostAt);
  check(
    "a lost answer is retried after the response timeout",
    counters.timeouts >= 1 &&
      retryAfterLoss !== undefined &&
      retryAfterLoss.command === "^P003GS" &&
      retryAfterLoss.ms_since_last_tx_byte >= RESPONSE_TIMEOUT_MS - 100,
    retryAfterLoss ? `retry ${retryAfterLoss.ms_since_last_tx_byte} ms after the last byte` : "no retry seen"
  );
  const tooEagerAfterAnomaly = received.filter(
    event => event.follows_anomaly && event.ms_since_last_tx_byte < LINE_QUIET_BEFORE_SEND_MS - 20
  );
  check(
    `after every wire anomaly the line was quiet ≥ ${LINE_QUIET_BEFORE_SEND_MS} ms before the next send`,
    received.some(event => event.follows_anomaly) && tooEagerAfterAnomaly.length === 0,
    tooEagerAfterAnomaly.map(event => `${event.command} after ${event.ms_since_last_tx_byte} ms`).join(", ")
  );
  check(
    `a ${EVENT_LOOP_STALL_MS} ms main-thread stall right after a write causes no false timeout`,
    stall.framesWrittenAtStall > 0 && timeoutsAfterStall === stall.timeoutsBefore,
    `timeouts ${stall.timeoutsBefore} → ${timeoutsAfterStall}`
  );

  // ---- setters: ACK despite a stale data frame first, then the quiet-gap confirm ----
  check(
    "GPMP000950 was ACKed (the stale data frame before the ACK was rejected)",
    setterResults.get("GPMP000950") === true
  );
  check(
    "GPMP readback 950 decoded after the write",
    decodedRounds.some(round => round.command === "GPMP" && round.fields.maximum_feeding_grid_power === 950)
  );
  check("MCHGV0570,0570 was ACKed", setterResults.get("MCHGV0570,0570") === true);
  check(
    "BATS readback 57.0/57.0 decoded after the write",
    decodedRounds.some(
      round =>
        round.command === "BATS" &&
        round.fields["battery_constant_charge_voltage(c.v.)"] === 57 &&
        round.fields.battery_floating_charge_voltage === 57
    )
  );

  // ---- a setter burst after a late first answer: the retry's own NAK must not shift onto EDG0 ----
  check("EDF0 was ACKed (its first attempt's late ACK, accepted on the retry)", setterResults.get("EDF0") === true);
  check(
    "EDG0 got its own ACK — the retry's duplicate NAK landed as unsolicited during the quiet wait",
    setterResults.get("EDG0") === true &&
      framesSent.some(frame => frame.role === "duplicate") &&
      counters.unsolicitedFrames >= 1,
    `EDG0 acknowledged=${setterResults.get("EDG0")}, unsolicited=${counters.unsolicitedFrames}`
  );
  check(
    "HECS readback confirms both feed-grid flags disabled after the burst",
    decodedRounds.some(
      round =>
        round.command === "HECS" &&
        round.fields.battery_discharge_to_feed_grid_when_solar_input_normal === "disabled" &&
        round.fields.battery_discharge_to_feed_grid_when_solar_input_loss === "disabled"
    )
  );

  // ---- throughput with the pool blocked: back-to-back rounds at least as fast as the old daemon ----
  check(
    `median GS gap ≤ ${MAX_MEDIAN_GS_GAP_MS} ms over a settled ${SETTLED_WINDOW_MS} ms window`,
    medianGsGapMs !== undefined && medianGsGapMs <= MAX_MEDIAN_GS_GAP_MS,
    `${medianGsGapMs?.toFixed(0)} ms`
  );
}

function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function startFakeInverter() {
  const child: ChildProcessWithoutNullStreams = spawn("python3", ["-I", FAKE_INVERTER_SCRIPT], { stdio: "pipe" });
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[fake inverter] ${chunk.toString()}`));
  const events: FakeInverterEvent[] = [];
  let resolveReady: (device: string) => void = () => {};
  let resolveFaultsDone: () => void = () => {};
  const ready = new Promise<string>(resolve => (resolveReady = resolve));
  const faultsDone = new Promise<void>(resolve => (resolveFaultsDone = resolve));
  const exited = new Promise<void>(resolve => child.on("exit", () => resolve()));
  readline.createInterface({ input: child.stdout }).on("line", line => {
    // Trusted harness output, one JSON object per line in the shape documented in the .py file
    const event = JSON.parse(line) as FakeInverterEvent;
    events.push(event);
    if (event.event === "ready") resolveReady(event.device);
    if (event.event === "faults_done") resolveFaultsDone();
  });
  return {
    ready,
    faultsDone,
    async stop(): Promise<readonly FakeInverterEvent[]> {
      child.stdin.end(); // EOF on its stdin makes it print the summary and exit
      await exited;
      return events;
    },
  };
}

/**
 * Parks every pool thread in open(2) on a FIFO nobody writes to — far harsher than the pi's
 * thermometer reads, which at least finish eventually. A stat() probe queued behind them proves
 * the pool stayed blocked; release() lets the readers finish so the process can exit cleanly.
 */
function blockEntireThreadpool() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi17-threadpool-"));
  const fifoPath = path.join(directory, "never-written.fifo");
  execFileSync("mkfifo", [fifoPath]);
  let finishedBlockers = 0;
  for (let blocker = 0; blocker < THREADPOOL_BLOCKERS; blocker++) {
    readFile(fifoPath, () => finishedBlockers++);
  }
  let probeCompleted = false;
  stat(directory, () => (probeCompleted = true));
  let releasing: Promise<void> | undefined;
  return {
    probeCompleted: () => probeCompleted,
    release: () => (releasing ??= unparkFifoReaders(fifoPath, () => finishedBlockers >= THREADPOOL_BLOCKERS)),
  };
}

async function unparkFifoReaders(fifoPath: string, allReadersFinished: () => boolean): Promise<void> {
  // Each writer open/close lets the readers currently parked in open() see EOF; queued ones then
  // park in turn, so cycle until every blocker has finished.
  while (!allReadersFinished()) {
    try {
      closeSync(openSync(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK));
    } catch (openError) {
      // ENXIO = no reader parked right now; the next queued one will be shortly
      if ((openError as NodeJS.ErrnoException).code !== "ENXIO") throw openError;
    }
    await sleep(5);
  }
}

async function stallRightAfterNextWrite(engine: ReturnType<typeof createInverterSession>) {
  const framesWrittenBefore = engine.exchangeCounters().framesWritten;
  while (engine.exchangeCounters().framesWritten === framesWrittenBefore) await sleep(1);
  const timeoutsBefore = engine.exchangeCounters().timeouts;
  const stallUntil = Date.now() + EVENT_LOOP_STALL_MS;
  while (Date.now() < stallUntil) {
    // deliberately blocking the main thread
  }
  return { timeoutsBefore, framesWrittenAtStall: engine.exchangeCounters().framesWritten };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
