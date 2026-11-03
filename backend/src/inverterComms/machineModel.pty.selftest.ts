/**
 * End-to-end self-test of the machine model (DM) path: the real engine against fakePi17Inverter.py on a
 * pty. The boot settings round reads DM 050; a DM050 queued while the inverter reads 050 is dropped unsent
 * (the switch is inert until asked); DM151 goes out as ^S006DM151, is ACKed, commits and is confirmed by
 * the DM readback; DM050 brings it back; and a DM code off the whitelist never reaches the wire.
 * The confirm windows are scaled down as in setterConfirm.pty.selftest.ts.
 *
 * Run from backend/ with:  yarn node src/inverterComms/machineModel.pty.selftest.ts
 * Needs python3 and Linux ptys. Takes ~15 s.
 */
import process from "process";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";
import { createRoot } from "solid-js";
import { createInverterSession } from "./inverterSession.ts";
import type { DecodedRound } from "./pi17Protocol.types.ts";
import type { SetterQueueItem } from "./inverterComms.types.ts";
import type { SchedulerTiming } from "./schedulerTiming.ts";
import { setOnErrorLog } from "../utilities/logging.ts";

const FAKE_INVERTER_SCRIPT = fileURLToPath(new URL("./fakePi17Inverter.py", import.meta.url));
const HARD_TIMEOUT_MS = 60_000;
const HARNESS_TIMING: Partial<SchedulerTiming> = {
  firstConfirmAfterWriteMs: 1_000,
  confirmRecheckIntervalMs: 1_000,
  confirmGiveUpAfterWriteMs: 6_000,
  starvedWritePageAfterMs: 7_000,
};

type FakeInverterEvent =
  | { event: "ready"; device: string }
  | { event: "received"; command: string }
  | { event: "committed"; setter: string }
  | { event: "summary" | "frame_sent" | "fault" | "faults_done" | "lost" | "garbage" | "unknown_query" };

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const errorLogsCaptured: string[] = [];
setOnErrorLog(args => errorLogsCaptured.push(args.map(argument => String(argument)).join(" ")));
const hardTimeout = setTimeout(() => {
  console.error(`FAIL: machine model run did not finish within ${HARD_TIMEOUT_MS} ms`);
  process.exit(1);
}, HARD_TIMEOUT_MS);

await runMachineModelChecks();
clearTimeout(hardTimeout);
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all machineModel pty selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

async function runMachineModelChecks(): Promise<void> {
  const python = spawnSync("python3", ["--version"], { encoding: "utf-8" });
  if (python.status !== 0) {
    check("python3 is available for the fake inverter", false, String(python.error ?? python.stderr));
    return;
  }
  const fake = await startFakeInverter(["--no-faults"]);
  const engine = startEngine(fake.device);
  await waitFor(() => latestMachineModel(engine.decodedRounds) !== undefined, 10_000);
  check("the boot settings round reads DM 050", latestMachineModel(engine.decodedRounds) === "050");
  check(
    "the DM query goes out as ^P003DM",
    fake.events.some(event => event.event === "received" && event.command === "^P003DM")
  );

  // Never sent before, so no identical-setter gate holds it: only the satisfied drop keeps it off the wire
  engine.session.queueSetter(machineModelItem("DM050", () => undefined));
  await sleep(2_000);
  check(
    "DM050 queued while the inverter reads 050 is dropped unsent (inert)",
    receivedCount(fake.events, "^S006DM050") === 0,
    `${receivedCount(fake.events, "^S006DM050")} sends`
  );

  const offGrid = await queueAndAwaitResult(engine.session, "DM151");
  check("DM151 is ACKed", offGrid.acknowledged === true);
  await waitFor(() => latestMachineModel(engine.decodedRounds) === "151", 8_000);
  check("the DM readback confirms 151", latestMachineModel(engine.decodedRounds) === "151");
  check(
    "DM151 went out as ^S006DM151 and committed",
    fake.events.some(event => event.event === "received" && event.command === "^S006DM151") &&
      fake.events.some(event => event.event === "committed" && event.setter === "DM151")
  );
  await waitFor(() => engine.session.exchangeCounters().writesConfirmed >= 1, 8_000);
  check("the session's confirm counts DM151 confirmed", engine.session.exchangeCounters().writesConfirmed >= 1);

  const normal = await queueAndAwaitResult(engine.session, "DM050");
  check("DM050 is ACKed", normal.acknowledged === true);
  await waitFor(() => latestMachineModel(engine.decodedRounds) === "050", 8_000);
  check("the DM readback confirms 050 again", latestMachineModel(engine.decodedRounds) === "050");

  const errorLogsBefore = errorLogsCaptured.length;
  let refusedResult: boolean | undefined;
  // A cast past the types, as a future caller could: the session's own gate must stop it
  engine.session.queueSetter(
    machineModelItem("DM150" as SetterQueueItem["command"], acknowledged => (refusedResult = acknowledged))
  );
  await sleep(1_500);
  check("DM150 is refused with acknowledged: false", refusedResult === false);
  check(
    "DM150 never reaches the wire",
    !fake.events.some(event => event.event === "received" && event.command.includes("DM150"))
  );
  check(
    "the refusal is an errorLog",
    errorLogsCaptured.slice(errorLogsBefore).some(line => line.includes("DM150") && line.includes("refused"))
  );
  check(
    "no unknown queries and no other errorLogs",
    !fake.events.some(event => event.event === "unknown_query") && errorLogsBefore === 0,
    errorLogsCaptured.slice(0, errorLogsBefore).join(" | ")
  );
  engine.dispose();
  await fake.stop();
}

function machineModelItem(
  command: SetterQueueItem["command"],
  onAcknowledged: (acknowledged: boolean) => void
): SetterQueueItem {
  return {
    command,
    replacesPrefix: "DM",
    refreshAfterSend: ["GPMP", "HECS", "BATS", "DM"],
    onResult: ({ acknowledged }) => onAcknowledged(acknowledged),
  };
}

async function queueAndAwaitResult(
  session: ReturnType<typeof createInverterSession>,
  command: SetterQueueItem["command"]
): Promise<{ acknowledged: boolean | undefined }> {
  let acknowledgedResult: boolean | undefined;
  session.queueSetter(machineModelItem(command, acknowledged => (acknowledgedResult = acknowledged)));
  await waitFor(() => acknowledgedResult !== undefined, 5_000);
  return { acknowledged: acknowledgedResult };
}

function latestMachineModel(rounds: readonly DecodedRound[]): string | undefined {
  const model = rounds.findLast(round => round.command === "DM")?.fields.machine_model;
  return typeof model === "string" ? model : undefined;
}

function receivedCount(events: readonly FakeInverterEvent[], command: string): number {
  return events.filter(event => event.event === "received" && event.command === command).length;
}

function startEngine(device: string) {
  const decodedRounds: DecodedRound[] = [];
  let session: ReturnType<typeof createInverterSession> | undefined;
  const dispose = createRoot(disposeRoot => {
    session = createInverterSession({
      devicePath: device,
      // Only the boot round reads the settings: every later DM readback is a confirm
      poll_values_interval_seconds: () => 600,
      onDecodedRound: round => decodedRounds.push(round),
      schedulerTimingOverrides: HARNESS_TIMING,
    });
    return disposeRoot;
  });
  if (!session) throw new Error("createInverterSession returned nothing");
  return { session, decodedRounds, dispose };
}

async function startFakeInverter(fakeArguments: readonly string[]): Promise<{
  device: string;
  /** Live: grows as the fake reports */
  events: readonly FakeInverterEvent[];
  stop: () => Promise<readonly FakeInverterEvent[]>;
}> {
  const child: ChildProcessWithoutNullStreams = spawn("python3", ["-I", FAKE_INVERTER_SCRIPT, ...fakeArguments], {
    stdio: "pipe",
  });
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[fake inverter] ${chunk.toString()}`));
  const events: FakeInverterEvent[] = [];
  const exited = new Promise<void>(resolve => child.on("exit", () => resolve()));
  const device = await new Promise<string>(resolve =>
    readline.createInterface({ input: child.stdout }).on("line", line => {
      // Trusted harness output, one JSON object per line in the shape documented in the .py file
      const event = JSON.parse(line) as FakeInverterEvent;
      events.push(event);
      if (event.event === "ready") resolve(event.device);
    })
  );
  return {
    device,
    events,
    stop: async () => {
      child.stdin.end(); // EOF on its stdin makes it print the summary and exit
      await exited;
      return events;
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await sleep(20);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
