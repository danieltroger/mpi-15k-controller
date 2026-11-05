/**
 * End-to-end self-test of the energy-distribution restore: the real engine and the real grid-off switch
 * against fakePi17Inverter.py on a pty, the fake taught what the inverter did on 2026-11-05 (a DM change
 * resets HECS to the factory defaults; EDF1 is NAKed while battery discharge to the loads is off). A
 * stand-in for feeding re-asserts EDF1 as feedWhenNoSolar does (desired state, held while grid-off is in
 * force). Shows: nothing is written while no DM changes; nothing is restored in 151; after DM050 the
 * priority and discharge to the loads come back as SEP01, EDD1, EDE1; feeding's EDF1, NAKed right after the
 * reset, applies on its retry; and a setter the inverter keeps refusing raises exactly one P2.
 *
 * Run from backend/ with:  yarn node src/gridOff/energyDistributionRestore.pty.selftest.ts
 * Needs python3 and Linux ptys. Takes ~2 min (feeding's EDF1 retry waits out the session's 60 s gate).
 */
import process from "process";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";
import { createRoot, createSignal } from "solid-js";
import { createInverterSession } from "../inverterComms/inverterSession.ts";
import type { DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import type { SchedulerTiming } from "../inverterComms/schedulerTiming.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { setOnErrorLog } from "../utilities/logging.ts";
import { createGridOffSwitch } from "./useGridOffSwitch.ts";
import type { RestoreTiming } from "./energyDistributionRestoreDecisions.ts";

const FAKE_INVERTER_SCRIPT = fileURLToPath(new URL("../inverterComms/fakePi17Inverter.py", import.meta.url));
const HARD_TIMEOUT_MS = 240_000;
const HARNESS_TIMING: Partial<SchedulerTiming> = {
  firstConfirmAfterWriteMs: 1_000,
  confirmRecheckIntervalMs: 1_000,
  confirmGiveUpAfterWriteMs: 6_000,
  starvedWritePageAfterMs: 7_000,
};
/** What the live inverter read before the DM050 of 2026-11-05 */
const LIVE_HECS_TOKENS = "01,1,0,1,1,1,1,1,0";
const RESTORE_SETTER = /^\^S00[56](SEP|ED[ACDE])/;

type FakeInverterEvent =
  | { event: "ready"; device: string }
  | { event: "received"; command: string }
  | { event: "committed"; setter: string }
  | { event: "setter_refused"; setter: string }
  | { event: "hecs_reset"; machine_model: string; hecs: string }
  | { event: "summary" | "frame_sent" | "fault" | "faults_done" | "lost" | "garbage" | "unknown_query" };

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const errorLogsCaptured: string[] = [];
setOnErrorLog(args => errorLogsCaptured.push(args.map(argument => String(argument)).join(" ")));
const hardTimeout = setTimeout(() => {
  console.error(`FAIL: the restore run did not finish within ${HARD_TIMEOUT_MS} ms`);
  process.exit(1);
}, HARD_TIMEOUT_MS);

await runRestoreChecks();
await runPersistentNakChecks();
clearTimeout(hardTimeout);
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all energyDistributionRestore pty selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

async function runRestoreChecks(): Promise<void> {
  const python = spawnSync("python3", ["--version"], { encoding: "utf-8" });
  if (python.status !== 0) {
    check("python3 is available for the fake inverter", false, String(python.error ?? python.stderr));
    return;
  }
  const fake = await startFakeInverter(["--no-faults", "--initial-hecs", LIVE_HECS_TOKENS]);
  // A few seconds of settling, so feeding's EDF1 goes out (and is NAKed) before EDD1 lands
  const harness = startHarness(fake.device, { settings_restore_delay_seconds: 3 }, undefined);
  await waitFor(() => harness.gridOffSwitch.status().readback_model === "050", 10_000);
  await sleep(3_000);
  check(
    "boot: DM 050 and the live HECS read",
    latestHecs(harness)?.solar_energy_distribution_priority === "Load-Battery-Grid"
  );
  check(
    "no DM change: no setter reaches the wire (feeding's EDF1 is already satisfied)",
    receivedSetters(fake.events).length === 0,
    receivedSetters(fake.events).join(",")
  );
  check(
    "…and the status shows the live HECS matching the profile",
    harness.gridOffSwitch.status().energy_distribution.mismatches?.length === 0
  );

  await harness.gridOffSwitch.requestOffGrid();
  await waitFor(() => harness.gridOffSwitch.status().readback_model === "151", 10_000);
  check("DM151 applied", harness.gridOffSwitch.status().readback_model === "151");
  check(
    "…and reset HECS on the fake",
    fake.events.some(event => event.event === "hecs_reset" && event.machine_model === "151")
  );
  await sleep(4_000);
  check(
    "in 151 nothing is restored and feeding holds",
    receivedSetters(fake.events).filter(command => RESTORE_SETTER.test(command) || command.includes("EDF")).length ===
      0,
    receivedSetters(fake.events).join(",")
  );

  const errorLogsBeforeNormal = errorLogsCaptured.length;
  await harness.gridOffSwitch.requestNormal();
  await waitFor(() => harness.gridOffSwitch.status().readback_model === "050", 10_000);
  check("DM050 applied", harness.gridOffSwitch.status().readback_model === "050");
  await waitFor(() => fake.events.some(event => event.event === "setter_refused" && event.setter === "EDF1"), 10_000);
  check(
    "feeding's EDF1 right after the reset is NAKed (discharge to the loads is off)",
    fake.events.some(event => event.event === "setter_refused" && event.setter === "EDF1")
  );
  await waitFor(() => harness.gridOffSwitch.status().energy_distribution.mismatches?.length === 0, 30_000);
  const restoreSends = receivedSetters(fake.events).filter(command => RESTORE_SETTER.test(command));
  check(
    "the restore sends SEP01, EDD1, EDE1, in that order, after the DM050",
    restoreSends.join(",") === "^S006SEP01,^S005EDD1,^S005EDE1",
    restoreSends.join(",")
  );
  check(
    "…and they commit: the HECS readback matches the profile",
    ["SEP01", "EDD1", "EDE1"].every(setter =>
      fake.events.some(event => event.event === "committed" && event.setter === setter)
    ) &&
      latestHecs(harness)?.solar_energy_distribution_priority === "Load-Battery-Grid" &&
      latestHecs(harness)?.battery_discharge_to_loads_when_solar_input_normal === "enabled" &&
      latestHecs(harness)?.battery_discharge_to_loads_when_solar_input_loss === "enabled"
  );
  await waitFor(() => harness.gridOffSwitch.status().energy_distribution.restore === undefined, 15_000);
  check("the episode ends", harness.gridOffSwitch.status().energy_distribution.restore === undefined);
  await waitFor(() => fake.events.some(event => event.event === "committed" && event.setter === "EDF1"), 75_000);
  check(
    "feeding's EDF1 retry (past the 60 s gate) is ACKed and commits once EDD is back",
    fake.events.some(event => event.event === "committed" && event.setter === "EDF1")
  );
  await waitFor(
    () => latestHecs(harness)?.battery_discharge_to_feed_grid_when_solar_input_normal === "enabled",
    10_000
  );
  check(
    "…HECS shows battery feed with PV enabled again",
    latestHecs(harness)?.battery_discharge_to_feed_grid_when_solar_input_normal === "enabled"
  );
  const nakErrorLogs = errorLogsCaptured.slice(errorLogsBeforeNormal).filter(line => line.includes("REJECTED (NAK)"));
  check("the EDF1 NAK is one errorLog", nakErrorLogs.length === 1, nakErrorLogs.join(" | "));
  check("no alert raised", harness.raised.length === 0, harness.raised.map(alert => alert.title).join(","));
  const sendsBefore = receivedSetters(fake.events).length;
  await sleep(4_000);
  check("nothing more written once restored", receivedSetters(fake.events).length === sendsBefore);
  harness.dispose();
  await fake.stop();
}

async function runPersistentNakChecks(): Promise<void> {
  const fake = await startFakeInverter(["--no-faults", "--initial-hecs", LIVE_HECS_TOKENS, "--nak-setters", "SEP"]);
  const harness = startHarness(fake.device, { settings_restore_delay_seconds: 0 }, { p2AfterMs: 8_000 });
  await waitFor(() => harness.gridOffSwitch.status().readback_model === "050", 10_000);
  await harness.gridOffSwitch.requestOffGrid();
  await waitFor(() => harness.gridOffSwitch.status().readback_model === "151", 10_000);
  await harness.gridOffSwitch.requestNormal();
  await waitFor(() => harness.gridOffSwitch.status().readback_model === "050", 10_000);
  await waitFor(() => harness.raised.some(alert => alert.severity === "P2"), 30_000);
  // Past two more guard ticks: still one page for the episode
  await sleep(22_000);
  const p2s = harness.raised.filter(alert => alert.severity === "P2");
  check(
    "a SEP the inverter keeps refusing raises exactly one P2",
    p2s.length === 1,
    p2s.map(alert => alert.key).join(",")
  );
  check(
    "…while EDD/EDE landed and the priority still differs",
    latestHecs(harness)?.battery_discharge_to_loads_when_solar_input_normal === "enabled" &&
      harness.gridOffSwitch
        .status()
        .energy_distribution.mismatches?.map(mismatch => mismatch.field)
        .join(",") === "solar_energy_distribution_priority"
  );
  check(
    "…and the episode keeps running (resent with back-off)",
    harness.gridOffSwitch.status().energy_distribution.restore?.p2_raised === true
  );
  harness.dispose();
  await fake.stop();
}

function startHarness(
  device: string,
  gridOffOverrides: Partial<Config["grid_off"]>,
  restoreTimingOverrides: Partial<RestoreTiming> | undefined
) {
  const decodedRounds: DecodedRound[] = [];
  const raised: Parameters<AlertManager["raise"]>[0][] = [];
  const raise: AlertManager["raise"] = async alert => {
    raised.push(alert);
    return { ...alert, at: new Date().toISOString(), delivery: "dry_run" };
  };
  // GS/PS are polled every round: the switch's freshness guard sees the link alive
  const mqttValues = {
    get battery_voltage() {
      return { value: 53.2, time: Date.now() };
    },
    get ac_output_total_active_power() {
      return { value: 547, time: Date.now() };
    },
  };
  let gridOffSwitch: ReturnType<typeof createGridOffSwitch> | undefined;
  let session: ReturnType<typeof createInverterSession> | undefined;
  let feedingTimer: ReturnType<typeof setInterval> | undefined;
  const dispose = createRoot(disposeRoot => {
    const [lastDecodedRound, setLastDecodedRound] = createSignal<DecodedRound | undefined>(undefined);
    const [config] = createSignal<Config>({
      ...default_config,
      grid_off: { ...default_config.grid_off, ...gridOffOverrides },
    });
    const engine = createInverterSession({
      devicePath: device,
      // Only the boot round reads the settings by itself: every later readback is a confirm or a request
      poll_values_interval_seconds: () => 600,
      onDecodedRound: round => {
        decodedRounds.push(round);
        setLastDecodedRound(round);
      },
      schedulerTimingOverrides: HARNESS_TIMING,
    });
    session = engine;
    const switchUnderTest = createGridOffSwitch({
      config,
      queueSetter: engine.queueSetter,
      requestSettingsReadback: engine.requestSettingsReadback,
      lastDecodedRound,
      mqttValues,
      soc: () => 60,
      raise,
      wallClockNowMs: () => Date.now(),
      energyDistributionSnapshotStore: { load: () => undefined, save: () => undefined, clear: () => undefined },
      restoreTimingOverrides,
    });
    gridOffSwitch = switchUnderTest;
    // feedWhenNoSolar's EDF/EDG effect, reduced: battery feed wanted on, queued as desired state whenever
    // HECS has been read, held while grid-off is in force
    feedingTimer = setInterval(() => {
      if (switchUnderTest.gridOffInForce()) return;
      if (latestHecsIn(decodedRounds)?.battery_discharge_to_feed_grid_when_solar_input_normal === undefined) return;
      engine.queueSetter({ command: "EDF1", replacesPrefix: "EDF", refreshAfterSend: ["HECS"] });
    }, 1_000);
    return disposeRoot;
  });
  if (!gridOffSwitch || !session) throw new Error("the harness built nothing");
  return {
    gridOffSwitch,
    decodedRounds,
    raised,
    dispose: () => {
      clearInterval(feedingTimer);
      dispose();
    },
  };
}

function latestHecs(harness: { decodedRounds: readonly DecodedRound[] }) {
  return latestHecsIn(harness.decodedRounds);
}

function latestHecsIn(rounds: readonly DecodedRound[]) {
  return rounds.findLast(round => round.command === "HECS")?.fields;
}

function receivedSetters(events: readonly FakeInverterEvent[]): string[] {
  return events.flatMap(event => (event.event === "received" && event.command.startsWith("^S") ? [event.command] : []));
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
