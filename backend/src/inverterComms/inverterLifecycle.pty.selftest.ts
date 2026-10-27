/**
 * Lifecycle self-test of the serial engine against fake inverters on ptys (fakePi17Inverter.py):
 * open/close/reopen and disposal, the paths the main pty test never takes (review of PR #48,
 * findings 3–5, turned from the reviewer's throwaway harnesses into regressions):
 *
 *  A. close() in the same tick as createSerialConnection — what a boot-time main() crash does —
 *     must not open the device afterwards (it used to, leaving a live second reader on the tty).
 *  B. open/close cycles must leave no fd behind (libuv's tty reopen used to leak ours each time).
 *  C. a "replug": the by-id symlink moves to a new tty while the old one hangs up; the connection
 *     must reopen onto the new device and hold exactly one fd on it, none on the old one.
 *  D. disposing a session mid-exchange (every main() crash-restart) must not errorLog (= a P2 push)
 *     nor deliver rounds afterwards; E. the same right at boot.
 *
 * Run from backend/ with:  yarn node src/inverterComms/inverterLifecycle.pty.selftest.ts
 * Needs python3 and Linux ptys. Takes ~25 s.
 */
import process from "process";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import { mkdtempSync, readdirSync, readlinkSync, renameSync, symlinkSync } from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { createRoot } from "solid-js";
import { createSerialConnection } from "./serialConnection.ts";
import { createInverterSession } from "./inverterSession.ts";
import { buildQueryFrame } from "./pi17Frames.ts";
import { setOnErrorLog } from "../utilities/logging.ts";

const FAKE_INVERTER_SCRIPT = fileURLToPath(new URL("./fakePi17Inverter.py", import.meta.url));
const HARD_TIMEOUT_MS = 90_000;

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const errorLogsCaptured: { atMs: number; text: string }[] = [];
setOnErrorLog(args =>
  errorLogsCaptured.push({ atMs: Date.now(), text: args.map(argument => String(argument)).join(" ") })
);
const hardTimeout = setTimeout(() => {
  console.error(`FAIL: lifecycle run did not finish within ${HARD_TIMEOUT_MS} ms`);
  process.exit(1);
}, HARD_TIMEOUT_MS);

await runLifecycleChecks();
clearTimeout(hardTimeout);
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all inverterLifecycle pty selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

async function runLifecycleChecks(): Promise<void> {
  const python = spawnSync("python3", ["--version"], { encoding: "utf-8" });
  if (python.status !== 0) {
    check("python3 is available for the fake inverter", false, String(python.error ?? python.stderr));
    return;
  }
  await checkCloseInTheSameTick();
  await checkFdsStableAcrossCycles();
  await checkReplugOntoANewDevice();
  await checkDisposeMidExchange();
  await checkDisposeAtBoot();
}

async function checkCloseInTheSameTick(): Promise<void> {
  const fake = await startFakeInverter();
  let openCalls = 0;
  const connection = createSerialConnection({ devicePath: fake.device, onData: () => {}, onOpen: () => openCalls++ });
  connection.close();
  await sleep(1_500);
  check(
    "A: close() during the stty await never opens the device",
    openCalls === 0 && !connection.isOpen() && fdsOn(fake.device) === 0,
    `onOpen ${openCalls}×, isOpen ${connection.isOpen()}, fds ${fdsOn(fake.device)}`
  );
  await fake.stop();
}

async function checkFdsStableAcrossCycles(): Promise<void> {
  const fake = await startFakeInverter();
  const fdsWhileOpen: number[] = [];
  const fdsAfterClose: number[] = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    let opened = false;
    const connection = createSerialConnection({
      devicePath: fake.device,
      onData: () => {},
      onOpen: () => (opened = true),
    });
    await waitFor(() => opened, 5_000);
    fdsWhileOpen.push(fdsOn(fake.device));
    connection.close();
    await sleep(200);
    fdsAfterClose.push(fdsOn(fake.device));
  }
  check(
    "B: exactly one fd on the tty while open, none after close, over 4 cycles",
    fdsWhileOpen.every(count => count === 1) && fdsAfterClose.every(count => count === 0),
    `open [${fdsWhileOpen.join(",")}], closed [${fdsAfterClose.join(",")}]`
  );
  await fake.stop();
}

async function checkReplugOntoANewDevice(): Promise<void> {
  const firstFake = await startFakeInverter();
  const secondFake = await startFakeInverter();
  const directory = mkdtempSync(path.join(os.tmpdir(), "pi17-by-id-"));
  const byIdPath = path.join(directory, "usb-FAKE_FT232R-if00-port0");
  symlinkSync(firstFake.device, byIdPath);

  let opens = 0;
  let bytesReceived = 0;
  const connection = createSerialConnection({
    devicePath: byIdPath,
    onData: chunk => (bytesReceived += chunk.length),
    onOpen: () => opens++,
  });
  await waitFor(() => opens === 1, 5_000);
  await connection.write(buildQueryFrame("GS"));
  await waitFor(() => bytesReceived >= 100, 3_000);
  check("C: opened through the by-id symlink and got a GS answer", bytesReceived >= 100, `${bytesReceived} bytes`);

  // Replug: the symlink now names the new tty (atomically, like udev), then the old one hangs up
  const replacementLink = `${byIdPath}.new`;
  symlinkSync(secondFake.device, replacementLink);
  renameSync(replacementLink, byIdPath);
  // A pty hang-up reads as EOF (a warnLog'd unexpected close); a real FTDI unplug errors with EIO
  // and then fails to reopen, both errorLogged — either way the connection must reopen
  await firstFake.stop();
  await waitFor(() => opens === 2, 15_000);
  check("C: the hang-up was noticed and the connection reopened", opens === 2);
  bytesReceived = 0;
  await connection.write(buildQueryFrame("GS"));
  await waitFor(() => bytesReceived >= 100, 3_000);
  check(
    "C: after the replug it talks to the new device, holding one fd there and none on the old one",
    bytesReceived >= 100 && fdsOn(secondFake.device) === 1 && fdsOn(firstFake.device) === 0,
    `${bytesReceived} bytes, fds new ${fdsOn(secondFake.device)} / old ${fdsOn(firstFake.device)}`
  );
  connection.close();
  await sleep(200);
  check("C: close after a reopen leaves no fd", fdsOn(secondFake.device) === 0);
  await secondFake.stop();
}

async function checkDisposeMidExchange(): Promise<void> {
  const fake = await startFakeInverter();
  let roundsDecoded = 0;
  let roundsAfterDispose = 0;
  let disposed = false;
  let session: ReturnType<typeof createInverterSession> | undefined;
  const disposeRoot = createRoot(dispose => {
    session = createInverterSession({
      devicePath: fake.device,
      poll_values_interval_seconds: () => 600,
      onDecodedRound: () => (disposed ? roundsAfterDispose++ : roundsDecoded++),
    });
    return dispose;
  });
  if (!session) throw new Error("createInverterSession returned nothing");
  const engine = session;
  await waitFor(() => roundsDecoded >= 2, 10_000);
  // Dispose right after the next frame goes out, while its answer is still due
  const framesBefore = engine.exchangeCounters().framesWritten;
  await waitFor(() => engine.exchangeCounters().framesWritten > framesBefore, 5_000);
  const errorLogsBefore = errorLogsCaptured.length;
  disposed = true;
  disposeRoot();
  await sleep(4_500); // longer than the 3 s response timeout + 300 ms quiet wait + retry
  const errorLogsAfterDispose = errorLogsCaptured.slice(errorLogsBefore).map(logged => logged.text);
  check(
    "D: disposing a session mid-exchange errorLogs nothing (no P2 per main() crash)",
    errorLogsAfterDispose.length === 0,
    errorLogsAfterDispose.join(" | ")
  );
  check("D: no rounds are delivered after dispose", roundsAfterDispose === 0, `${roundsAfterDispose}`);
  check("D: the disposed session holds no fd", fdsOn(fake.device) === 0, `${fdsOn(fake.device)}`);
  await fake.stop();
}

async function checkDisposeAtBoot(): Promise<void> {
  const fake = await startFakeInverter();
  let rounds = 0;
  const errorLogsBefore = errorLogsCaptured.length;
  const disposeRoot = createRoot(dispose => {
    createInverterSession({
      devicePath: fake.device,
      poll_values_interval_seconds: () => 600,
      onDecodedRound: () => rounds++,
    });
    return dispose;
  });
  disposeRoot(); // same tick: the stty await is still running
  await sleep(2_000);
  check(
    "E: a session disposed at boot never opens the device, decodes or errorLogs",
    fdsOn(fake.device) === 0 && rounds === 0 && errorLogsCaptured.length === errorLogsBefore,
    `fds ${fdsOn(fake.device)}, rounds ${rounds}, errorLogs ${errorLogsCaptured.length - errorLogsBefore}`
  );
  await fake.stop();
}

async function startFakeInverter(): Promise<{ device: string; stop: () => Promise<void> }> {
  const child: ChildProcessWithoutNullStreams = spawn("python3", ["-I", FAKE_INVERTER_SCRIPT], { stdio: "pipe" });
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[fake inverter] ${chunk.toString()}`));
  const exited = new Promise<void>(resolve => child.on("exit", () => resolve()));
  const device = await new Promise<string>(resolve =>
    readline.createInterface({ input: child.stdout }).on("line", line => {
      // Trusted harness output, one JSON object per line
      const event = JSON.parse(line) as { event: string; device?: string };
      if (event.event === "ready" && event.device) resolve(event.device);
    })
  );
  return {
    device,
    stop: async () => {
      child.stdin.end(); // EOF on its stdin makes it exit (closing the pty)
      await exited;
    },
  };
}

/** fds of this process pointing at `device` (a /dev/pts path; symlinks resolve to it in /proc) */
function fdsOn(device: string): number {
  let count = 0;
  for (const entry of readdirSync("/proc/self/fd")) {
    try {
      if (readlinkSync(`/proc/self/fd/${entry}`) === device) count++;
    } catch {
      // closed between readdir and readlink: not an fd to count
    }
  }
  return count;
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await sleep(10);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
