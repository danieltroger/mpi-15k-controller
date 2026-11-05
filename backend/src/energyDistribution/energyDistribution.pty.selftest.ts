/**
 * End-to-end self-test of the energy-distribution enforcement: the real engine and the real enforcement
 * against fakePi17Inverter.py on a pty, the fake taught what the inverter did on 2026-11-05 (a DM change
 * resets HECS to the factory defaults; a SEP write resets AC charge on, feed to utility off and battery feed
 * to the grid without PV off; EDF1 is NAKed while battery discharge to the loads is off). Stand-ins for
 * buying (EDB0) and feeding (EDF1, EDG1) re-assert their own fields as desired state, holding while the
 * inverter reads 151 as the real ones hold while grid-off is in force.
 *
 * Run 1 (live HECS, the first SEP NAKed): a matching inverter is never written; a config edit propagates at
 * once; in 151 with everything unmanaged nothing is written; after DM050 the reset is written at once,
 * the NAKed SEP01 is retried on the next HECS change, its own reset of EDB/EDC/EDG is re-diffed (EDC by the
 * enforcement, EDB/EDG by their owners), and everything converges without oscillating.
 * Run 2 (priority off, EDC off and unmanaged, every SEP NAKed, settings read every 5 s): the steady NAK is
 * written once, not on every readback; exactly one P2; the unmanaged EDC is never written.
 *
 * Run from backend/ with:  yarn node src/energyDistribution/energyDistribution.pty.selftest.ts
 * Needs python3 and Linux ptys. Takes ~2 min (retries of an identical setter wait out the session's 60 s gate).
 */
import process from "process";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import readline from "readline";
import { fileURLToPath } from "url";
import { createRoot, createSignal } from "solid-js";
import { createInverterSession } from "../inverterComms/inverterSession.ts";
import { createInverterStatusTracker } from "../inverterComms/useInverterStatus.ts";
import type { DecodedFields, DecodedRound, MachineModelCode } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem } from "../inverterComms/inverterComms.types.ts";
import type { SchedulerTiming } from "../inverterComms/schedulerTiming.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { default_config } from "../config/config.ts";
import type { Config, EnergyDistributionProfile } from "../config/config.types.ts";
import { setOnErrorLog } from "../utilities/logging.ts";
import { createEnergyDistributionEnforcement } from "./useEnergyDistributionEnforcement.ts";
import type { EnforcementTiming } from "./energyDistributionEnforcementDecisions.ts";

const FAKE_INVERTER_SCRIPT = fileURLToPath(new URL("../inverterComms/fakePi17Inverter.py", import.meta.url));
const HARD_TIMEOUT_MS = 300_000;
const HARNESS_TIMING: Partial<SchedulerTiming> = {
  firstConfirmAfterWriteMs: 1_000,
  confirmRecheckIntervalMs: 1_000,
  confirmGiveUpAfterWriteMs: 6_000,
  starvedWritePageAfterMs: 7_000,
};
/** What the live inverter read before the DM050 of 2026-11-05 */
const LIVE_HECS_TOKENS = "01,1,0,1,1,1,1,1,0";
const ENFORCED_SETTER = /^\^S00[56](SEP|ED[ACDE])/;

type FakeInverterEvent =
  | { event: "ready"; device: string }
  | { event: "received"; command: string }
  | { event: "committed"; setter: string }
  | { event: "setter_refused"; setter: string }
  | { event: "hecs_reset"; cause: string; hecs: string }
  | { event: "summary" | "frame_sent" | "fault" | "faults_done" | "lost" | "garbage" | "unknown_query" };

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const errorLogsCaptured: string[] = [];
setOnErrorLog(args => errorLogsCaptured.push(args.map(argument => String(argument)).join(" ")));
const hardTimeout = setTimeout(() => {
  console.error(`FAIL: the energy-distribution run did not finish within ${HARD_TIMEOUT_MS} ms`);
  process.exit(1);
}, HARD_TIMEOUT_MS);

const python = spawnSync("python3", ["--version"], { encoding: "utf-8" });
if (python.status !== 0) {
  check("python3 is available for the fake inverter", false, String(python.error ?? python.stderr));
} else {
  await runConvergenceChecks();
  await runSteadyNakChecks();
}
clearTimeout(hardTimeout);
console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all energyDistribution pty selftests passed"}`
);
process.exit(fails.length ? 1 : 0);

async function runConvergenceChecks(): Promise<void> {
  const fake = await startFakeInverter(["--no-faults", "--initial-hecs", LIVE_HECS_TOKENS, "--nak-setters", "SEP:1"]);
  const harness = startHarness(fake.device, { pollSeconds: 600, timingOverrides: undefined });
  await waitFor(() => harness.enforcement.status().profile_name === "normal_hybrid", 10_000);
  await sleep(4_000);
  check(
    "a matching inverter: no setter reaches the wire (the owners' stand-ins are satisfied too)",
    receivedSetters(fake.events).length === 0,
    receivedSetters(fake.events).join(",")
  );

  harness.setNormalHybrid({ solar_charge_battery: "disabled" });
  await waitFor(() => latestHecs(harness)?.solar_charge_battery === "disabled", 8_000);
  check(
    "a config edit propagates at once: EDA0 sent, committed, read back",
    receivedSetters(fake.events).join(",") === "^S005EDA0" && latestHecs(harness)?.solar_charge_battery === "disabled",
    receivedSetters(fake.events).join(",")
  );
  harness.setNormalHybrid({ solar_charge_battery: "enabled" });
  await waitFor(() => latestHecs(harness)?.solar_charge_battery === "enabled", 8_000);
  check("…and back (EDA1)", latestHecs(harness)?.solar_charge_battery === "enabled");

  const beforeOffGrid = receivedSetters(fake.events).length;
  harness.requestMachineModel("151");
  await waitFor(() => harness.enforcement.status().profile_name === "off_grid_iii", 10_000);
  await sleep(4_000);
  check(
    "in 151 with everything unmanaged nothing is written on the reset HECS",
    receivedSetters(fake.events).slice(beforeOffGrid).join(",") === "^S006DM151" &&
      latestHecs(harness)?.battery_discharge_to_loads_when_solar_input_normal === "disabled",
    receivedSetters(fake.events).slice(beforeOffGrid).join(",")
  );

  const beforeNormal = receivedSetters(fake.events).length;
  harness.requestMachineModel("050");
  await waitFor(() => fake.events.some(event => event.event === "setter_refused" && event.setter === "SEP01"), 10_000);
  check(
    "after DM050 the reset is written at once; the first SEP01 is NAKed",
    fake.events.some(event => event.event === "setter_refused" && event.setter === "SEP01")
  );
  await waitFor(() => fake.events.some(event => event.event === "hecs_reset" && event.cause === "SEP01"), 80_000);
  check(
    "the next HECS change (EDD/EDE landed) re-armed SEP01, and it applied (resetting EDB/EDC/EDG)",
    fake.events.some(event => event.event === "committed" && event.setter === "SEP01")
  );
  await waitFor(() => converged(latestHecs(harness)), 80_000);
  check(
    "everything converges: the live profile, EDB off, EDF/EDG on",
    converged(latestHecs(harness)),
    JSON.stringify(latestHecs(harness))
  );
  await sleep(5_000);
  const afterNormal = receivedSetters(fake.events).slice(beforeNormal);
  const enforcedSends = afterNormal.filter(command => ENFORCED_SETTER.test(command));
  check(
    "the enforcement wrote SEP01 twice (NAK, retry), EDD1/EDE1 once, and EDC1 once after SEP's reset",
    count(enforcedSends, "^S006SEP01") === 2 &&
      count(enforcedSends, "^S005EDD1") === 1 &&
      count(enforcedSends, "^S005EDE1") === 1 &&
      count(enforcedSends, "^S005EDC1") === 1 &&
      enforcedSends.length === 5,
    enforcedSends.join(",")
  );
  check(
    "the owners restored their own: EDB0 and EDG1 after each reset, EDF1 once EDD was back",
    count(afterNormal, "^S005EDB0") === 2 && count(afterNormal, "^S005EDG1") === 2 && afterNormal.includes("^S005EDF1"),
    afterNormal.join(",")
  );
  const settled = receivedSetters(fake.events).length;
  await sleep(6_000);
  check("no oscillation: nothing more written once converged", receivedSetters(fake.events).length === settled);
  check("no alert raised", harness.raised.length === 0, harness.raised.map(alert => alert.title).join(","));
  const nakErrorLogs = errorLogsCaptured.filter(line => line.includes("REJECTED (NAK)"));
  check("each NAK streak is one errorLog (SEP01, EDF1)", nakErrorLogs.length <= 2, nakErrorLogs.join(" | "));
  harness.dispose();
  await fake.stop();
}

async function runSteadyNakChecks(): Promise<void> {
  const errorLogsBefore = errorLogsCaptured.length;
  const fake = await startFakeInverter(["--no-faults", "--initial-hecs", "00,1,0,0,1,1,1,1,0", "--nak-setters", "SEP"]);
  const harness = startHarness(fake.device, { pollSeconds: 5, timingOverrides: { p2AfterMs: 8_000 } });
  harness.setNormalHybrid({ feed_power_to_utility: "unmanaged" });
  await waitFor(() => harness.raised.some(alert => alert.severity === "P2"), 20_000);
  // Settings read every 5 s: several more unchanged readbacks
  await sleep(20_000);
  const sends = receivedSetters(fake.events);
  const hecsReads = harness.decodedRounds.filter(round => round.command === "HECS").length;
  check(
    "a steady NAK is written once, not on each of the unchanged readbacks",
    count(sends, "^S006SEP01") === 1 && hecsReads >= 5,
    `${sends.join(",")} over ${hecsReads} HECS readbacks`
  );
  check("exactly one P2", harness.raised.filter(alert => alert.severity === "P2").length === 1);
  check("the unmanaged EDC is never written", !sends.some(command => command.includes("EDC")));
  check(
    "the steady NAK is one errorLog",
    errorLogsCaptured.slice(errorLogsBefore).filter(line => line.includes("REJECTED (NAK) SEP01")).length === 1
  );
  harness.dispose();
  await fake.stop();
}

function converged(hecs: DecodedFields | undefined): boolean {
  return (
    hecs?.solar_energy_distribution_priority === "Load-Battery-Grid" &&
    hecs.solar_charge_battery === "enabled" &&
    hecs.ac_charge_battery === "disabled" &&
    hecs.feed_power_to_utility === "enabled" &&
    hecs.battery_discharge_to_loads_when_solar_input_normal === "enabled" &&
    hecs.battery_discharge_to_loads_when_solar_input_loss === "enabled" &&
    hecs.battery_discharge_to_feed_grid_when_solar_input_normal === "enabled" &&
    hecs.battery_discharge_to_feed_grid_when_solar_input_loss === "enabled"
  );
}

function startHarness(
  device: string,
  { pollSeconds, timingOverrides }: { pollSeconds: number; timingOverrides: Partial<EnforcementTiming> | undefined }
) {
  const decodedRounds: DecodedRound[] = [];
  const raised: Parameters<AlertManager["raise"]>[0][] = [];
  const raise: AlertManager["raise"] = async alert => {
    raised.push(alert);
    return { ...alert, at: new Date().toISOString(), delivery: "dry_run" };
  };
  let enforcement: ReturnType<typeof createEnergyDistributionEnforcement> | undefined;
  let queueSetter: ((item: SetterQueueItem) => void) | undefined;
  let setConfig: ((config: Config) => void) | undefined;
  let currentConfig: (() => Config) | undefined;
  let ownersTimer: ReturnType<typeof setInterval> | undefined;
  let setRequestedModel: ((model: MachineModelCode) => void) | undefined;
  const dispose = createRoot(disposeRoot => {
    // The grid-off switch's request, reduced: what the harness last queued
    const [requestedModel, setRequestedModelSignal] = createSignal<MachineModelCode>("050");
    setRequestedModel = setRequestedModelSignal;
    const [lastDecodedRound, setLastDecodedRound] = createSignal<DecodedRound | undefined>(undefined);
    const [config, setConfigSignal] = createSignal<Config>({
      ...default_config,
      usb_parameter_setting: { ...default_config.usb_parameter_setting, poll_values_interval_seconds: pollSeconds },
    });
    setConfig = setConfigSignal;
    currentConfig = config;
    let statusTracker: ReturnType<typeof createInverterStatusTracker> | undefined;
    const engine = createInverterSession({
      devicePath: device,
      poll_values_interval_seconds: () => pollSeconds,
      onDecodedRound: round => {
        decodedRounds.push(round);
        statusTracker?.trackRound(round);
        setLastDecodedRound(round);
      },
      schedulerTimingOverrides: HARNESS_TIMING,
    });
    statusTracker = createInverterStatusTracker(queries => engine.requestStatusQueries(queries));
    const tracker = statusTracker;
    queueSetter = engine.queueSetter;
    enforcement = createEnergyDistributionEnforcement({
      config,
      queueSetter: engine.queueSetter,
      requestSettingsReadback: engine.requestSettingsReadback,
      lastDecodedRound,
      workingModeCode: () => tracker.inverterStatus().working_mode?.code,
      requestedMachineModel: requestedModel,
      raise,
      wallClockNowMs: () => Date.now(),
      timingOverrides,
    });
    // Buying (EDB0) and feeding (EDF1, EDG1) as desired state, the way they queue it; they hold while 151 is
    // requested or read back, as the real ones do while grid-off is in force
    ownersTimer = setInterval(() => {
      if (requestedModel() === "151" || latestModelIn(decodedRounds) !== "050" || !latestHecsIn(decodedRounds)) return;
      for (const command of ["EDB0", "EDF1", "EDG1"] as const) {
        engine.queueSetter({ command, replacesPrefix: command.slice(0, 3), refreshAfterSend: ["HECS"] });
      }
    }, 1_000);
    return disposeRoot;
  });
  if (!enforcement || !queueSetter || !setConfig || !currentConfig || !setRequestedModel) {
    throw new Error("the harness built nothing");
  }
  const applyConfig = setConfig;
  const readConfig = currentConfig;
  const applyRequestedModel = setRequestedModel;
  const queue = queueSetter;
  return {
    enforcement,
    decodedRounds,
    raised,
    /** As the grid-off switch does it: the request first, then DM queued */
    requestMachineModel: (model: MachineModelCode) => {
      applyRequestedModel(model);
      queue({ command: `DM${model}`, replacesPrefix: "DM", refreshAfterSend: ["GPMP", "HECS", "BATS", "DM"] });
    },
    setNormalHybrid: (changes: Partial<EnergyDistributionProfile>) => {
      const current = readConfig();
      applyConfig({
        ...current,
        inverter_energy_distribution: {
          ...current.inverter_energy_distribution,
          normal_hybrid: { ...current.inverter_energy_distribution.normal_hybrid, ...changes },
        },
      });
    },
    dispose: () => {
      clearInterval(ownersTimer);
      dispose();
    },
  };
}

function latestHecs(harness: { decodedRounds: readonly DecodedRound[] }): DecodedFields | undefined {
  return latestHecsIn(harness.decodedRounds);
}

function latestHecsIn(rounds: readonly DecodedRound[]): DecodedFields | undefined {
  return rounds.findLast(round => round.command === "HECS")?.fields;
}

function latestModelIn(rounds: readonly DecodedRound[]): string | undefined {
  const model = rounds.findLast(round => round.command === "DM")?.fields.machine_model;
  return typeof model === "string" ? model : undefined;
}

function receivedSetters(events: readonly FakeInverterEvent[]): string[] {
  return events.flatMap(event => (event.event === "received" && event.command.startsWith("^S") ? [event.command] : []));
}

function count(commands: readonly string[], command: string): number {
  return commands.filter(candidate => candidate === command).length;
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
