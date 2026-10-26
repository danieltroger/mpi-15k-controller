/**
 * Self-test of the thermometer sweep against a fake sysfs directory: a temp directory laid out like
 * /sys/bus/w1/devices, read and written through the production SysfsAccess (so a missing file or a
 * read-only attribute fails exactly as it would on the pi), plus a small model of w1_therm's bulk read
 * on top and a simulated clock. Covers trigger → wait → read, the bounded wait, the fallback to w1_slave
 * (EACCES, ENOENT, an ignored trigger), one warning per outage, the bulk retry, the 85 °C/garbage guards, and
 * when a silent probe pages at the default, the longest and a back-to-back interval. Run from backend/ with:
 *   yarn node src/temperatureMeasuring/thermometerSweep.selftest.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import process from "process";
import { nodeSysfsAccess, type SysfsAccess } from "./sysfsAccess.ts";
import {
  createThermometerSweepState,
  DEFAULT_THERMOMETER_SWEEP_TIMING,
  type SweepLogger,
  sweepThermometers,
  type ThermometerProbe,
  type ThermometerSweepContextSettings,
  type ThermometerSweepState,
} from "./thermometerSweep.ts";
import { DEFAULT_THERMOMETER_SWEEP_SETTINGS } from "./thermometerSweepSettings.ts";
import { checkPlausibility, parseTemperatureAttribute, parseW1SlaveText } from "./thermometerReadingParsing.ts";
import { errorLogDedupeKey } from "../alerting/alertingLogic.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

/** What the fake kernel does with a trigger; defaults model 5.15 on the pi */
type FakeKernelBehaviour = {
  /** 5.15 sleeps out the conversion inside the trigger write */
  triggerWriteBlocksMs: number;
  /** Status reads still answering -1 after the write returned (a kernel converting in the background) */
  pendingStatusReads: number;
  /** "0" models a trigger the kernel ignored (bus mutex busy, a probe without family data) */
  statusAfterConversion: string;
  /** The trigger write fails with an injected EACCES, as without the udev rule (works when run as root too) */
  denyTriggerWrite: boolean;
};

type ProbeTexts = { temperatureText: string; w1SlaveText: string };

type FakeKernel = {
  devicesDirectory: string;
  bulkReadPath: string;
  behaviour: FakeKernelBehaviour;
  probeTexts: Map<string, ProbeTexts>;
  status: string;
  pendingStatusReadsLeft: number;
  nowMs: number;
  /** Every access, relative to the devices directory, in order */
  events: string[];
  /** Contents of every trigger write that reached the file */
  triggerWrites: string[];
};

type LoggedLine = { level: "log" | "warn" | "error"; text: string };

const SWEEP_INTERVAL_MS = 10_000;
const timing = DEFAULT_THERMOMETER_SWEEP_TIMING;
const SILENT_PAGE_AFTER_MS = DEFAULT_THERMOMETER_SWEEP_SETTINGS.thermometer_silent_page_after_minutes * 60_000;
/** A probe's 5 min of silence before it pages, in sweeps at the default interval: 30, as before it was timed */
const FAILED_SWEEPS_TO_PAGE = SILENT_PAGE_AFTER_MS / SWEEP_INTERVAL_MS;
const fakeDirectories: string[] = [];
const runningAsRoot = process.getuid?.() === 0;

const cell: ThermometerProbe = { thermometer_device_id: "28-dc647e1f64ff", label: "cell_1" };
const outlet: ThermometerProbe = { thermometer_device_id: "28-1d6d7e1f64ff", label: "cooling_outlet_5" };
const busBar: ThermometerProbe = { thermometer_device_id: "28-a76efd0a6461", label: "negative_bus_bar" };

// ——— parsing and plausibility, pure ———
check("temperature attribute: millidegrees", parseTemperatureAttribute("24250\n"), { ok: true, celsius: 24.25 });
check("temperature attribute: below zero", parseTemperatureAttribute("-1250\n"), { ok: true, celsius: -1.25 });
check(
  "temperature attribute: empty (kernel CRC failure or pending) is rejected",
  parseTemperatureAttribute("").ok,
  false
);
check("temperature attribute: whitespace only is rejected", parseTemperatureAttribute(" \n").ok, false);
check("temperature attribute: text is rejected", parseTemperatureAttribute("garbage\n").ok, false);
check("temperature attribute: decimals are rejected", parseTemperatureAttribute("24.25\n").ok, false);
check("temperature attribute: trailing junk is rejected", parseTemperatureAttribute("24250 7\n").ok, false);
check("w1_slave: good CRC", parseW1SlaveText(w1SlaveTextFor(24250)), { ok: true, celsius: 24.25 });
check("w1_slave: negative", parseW1SlaveText(w1SlaveTextFor(-10125)), { ok: true, celsius: -10.125 });
check("w1_slave: CRC NO is rejected", parseW1SlaveText(w1SlaveTextFor(24250, "NO")).ok, false);
check("w1_slave: empty is rejected", parseW1SlaveText("").ok, false);
check("w1_slave: missing t= line is rejected", parseW1SlaveText(w1SlaveTextFor(24250).split("\n")[0] + "\n").ok, false);
check("plausibility: ordinary value", checkPlausibility(21.5, 21.4), { ok: true, celsius: 21.5 });
check("plausibility: 0 °C is a real outdoor value", checkPlausibility(0, undefined), { ok: true, celsius: 0 });
check("plausibility: 85 °C with no history is the power-on value", checkPlausibility(85, undefined).ok, false);
check("plausibility: 85 °C after 22 °C is the power-on value", checkPlausibility(85, 22).ok, false);
check("plausibility: 85 °C after 80 °C is genuine", checkPlausibility(85, 80), { ok: true, celsius: 85 });
check("plausibility: 85.0625 °C is not the power-on value", checkPlausibility(85.0625, 22), {
  ok: true,
  celsius: 85.0625,
});
check("plausibility: above 90 °C is rejected", checkPlausibility(127.937, 22).ok, false);
check("plausibility: below -30 °C is rejected", checkPlausibility(-55, -10).ok, false);
check("plausibility: NaN is rejected", checkPlausibility(NaN, 20).ok, false);

// ——— bulk path, the way 5.15 does it: the write blocks for the conversion, then the status reads 1 ———
{
  const kernel = createFakeKernel([
    [cell, 21500],
    [outlet, -3250],
    [busBar, 85000],
  ]);
  const state = createThermometerSweepState();
  const lines: LoggedLine[] = [];
  const sweep = await runSweep(kernel, state, lines, [cell, outlet, busBar]);
  check("bulk: method", sweep.method, "bulk");
  check("bulk: exactly the 8 bytes the kernel acts on", kernel.triggerWrites, ["trigger\n"]);
  check(
    "bulk: values from the temperature attribute, the 85 °C power-on value left out",
    sweep.readings.map(reading => [reading.label, reading.value]),
    [
      ["cell_1", 21.5],
      ["cooling_outlet_5", -3.25],
    ]
  );
  check(
    "bulk: readings carry device id and read time",
    sweep.readings.map(reading => [reading.thermometer_device_id, reading.time]),
    [
      [cell.thermometer_device_id, 1_000_750],
      [outlet.thermometer_device_id, 1_000_750],
    ]
  );
  check("bulk: trigger, one status read, then each probe's temperature, no w1_slave", kernel.events, [
    'write w1_bus_master1/therm_bulk_read "trigger\\n"',
    "read w1_bus_master1/therm_bulk_read",
    `read ${cell.thermometer_device_id}/temperature`,
    `read ${outlet.thermometer_device_id}/temperature`,
    `read ${busBar.thermometer_device_id}/temperature`,
  ]);
  check("bulk: the sweep takes the conversion time", sweep.durationMs, 750);
  check("bulk: no warnings", warnings(lines), []);
  check(
    "bulk: announced once with its duration",
    lines.filter(line => line.text.startsWith("1-wire bulk read active")).map(line => line.text),
    ["1-wire bulk read active (one conversion for the whole bus per sweep): read 2/3 probes in 750 ms"]
  );
  check(
    "bulk: the power-on value is logged with its reason",
    lines.some(line => line.text.includes(busBar.thermometer_device_id) && line.text.includes("85°C power-on value")),
    true
  );

  kernel.nowMs += SWEEP_INTERVAL_MS;
  setProbeMillidegrees(kernel, cell.thermometer_device_id, 22000);
  setProbeMillidegrees(kernel, busBar.thermometer_device_id, 23500);
  lines.length = 0;
  const nextSweep = await runSweep(kernel, state, lines, [cell, outlet, busBar]);
  check(
    "bulk, next sweep: fresh values, the reset probe back",
    nextSweep.readings.map(reading => reading.value),
    [22, -3.25, 23.5]
  );
  check("bulk, next sweep: no second announcement", lines, []);
}

// ——— bulk path on a kernel that converts in the background: the status is polled until it says done ———
{
  const kernel = createFakeKernel([[cell, 19000]], { triggerWriteBlocksMs: 0, pendingStatusReads: 3 });
  const lines: LoggedLine[] = [];
  const sweep = await runSweep(kernel, createThermometerSweepState(), lines, [cell]);
  check("polling: still bulk", sweep.method, "bulk");
  check("polling: the value written at completion", sweep.readings[0]?.value, 19);
  check("polling: three -1 answers, a poll interval apart, before the probe is read", kernel.events, [
    'write w1_bus_master1/therm_bulk_read "trigger\\n"',
    "read w1_bus_master1/therm_bulk_read",
    "sleep 50",
    "read w1_bus_master1/therm_bulk_read",
    "sleep 50",
    "read w1_bus_master1/therm_bulk_read",
    "sleep 50",
    "read w1_bus_master1/therm_bulk_read",
    `read ${cell.thermometer_device_id}/temperature`,
  ]);
  check("polling: no warnings", warnings(lines), []);
}

// ——— the wait is bounded: a conversion that never reports done falls back for this sweep. While the
// kernel's flags still say "converting", w1_slave reads come back empty too (w1_slave_show has the same
// guard as temperature_show), so that sweep gets no readings and logs every probe as failed. Unreachable
// on 5.15, whose trigger write returns only after the conversion. ———
{
  const kernel = createFakeKernel(
    [
      [cell, 19000],
      [outlet, 24000],
    ],
    { triggerWriteBlocksMs: 0, pendingStatusReads: Infinity }
  );
  const lines: LoggedLine[] = [];
  const sweep = await runSweep(kernel, createThermometerSweepState(), lines, [cell, outlet]);
  check("bounded wait: falls back to w1_slave", sweep.method, "w1_slave");
  check("bounded wait: gives up at the limit", sweep.durationMs, timing.conversionWaitLimitMs);
  check("bounded wait: no readings, w1_slave is empty while the conversion is pending", sweep.readings, []);
  check(
    "bounded wait: both probes logged as failed with an empty w1_slave read",
    [cell, outlet].map(probe =>
      lines.some(
        line =>
          line.level === "log" &&
          line.text.includes(probe.thermometer_device_id) &&
          line.text.includes("w1_slave: empty read")
      )
    ),
    [true, true]
  );
  check("bounded wait: one warning naming the timeout", warnings(lines).length, 1);
  check("bounded wait: the warning says why", warnings(lines)[0]?.includes("still pending 1000 ms"), true);
  check(
    "bounded wait: no temperature attribute read while the conversion is pending",
    kernel.events.some(event => event.endsWith("/temperature")),
    false
  );
}

// ——— a trigger the kernel ignored (status 0 right after it) falls back too ———
{
  const kernel = createFakeKernel([[cell, 19000]], { statusAfterConversion: "0" });
  const lines: LoggedLine[] = [];
  const sweep = await runSweep(kernel, createThermometerSweepState(), lines, [cell]);
  check("ignored trigger: falls back to w1_slave", sweep.method, "w1_slave");
  check("ignored trigger: value via w1_slave", sweep.readings[0]?.value, 19);
  check("ignored trigger: warned", warnings(lines)[0]?.includes("ignored the trigger"), true);
}

// ——— EACCES: fall back, warn once per outage, retry the bulk path every minute, recover ———
{
  const kernel = createFakeKernel(
    [
      [cell, 20000],
      [outlet, 25000],
    ],
    { denyTriggerWrite: true }
  );
  const probes = [cell, outlet];
  const state = createThermometerSweepState();
  const lines: LoggedLine[] = [];
  const outageStartedAtMs = kernel.nowMs;

  const firstSweep = await runSweep(kernel, state, lines, probes);
  check("EACCES: falls back to w1_slave", firstSweep.method, "w1_slave");
  check(
    "EACCES: values via w1_slave",
    firstSweep.readings.map(reading => reading.value),
    [20, 25]
  );
  check(
    "EACCES: w1_slave read for each probe",
    kernel.events.filter(event => event.endsWith("/w1_slave")),
    [`read ${cell.thermometer_device_id}/w1_slave`, `read ${outlet.thermometer_device_id}/w1_slave`]
  );
  check("EACCES: one warning", warnings(lines).length, 1);
  check(
    "EACCES: the warning names the error and the udev rule",
    ["EACCES", "99-w1-therm-bulk-read.rules", "every 1.0 min"].every(part => warnings(lines)[0]?.includes(part)),
    true
  );

  for (let sweepIndex = 1; sweepIndex <= 5; sweepIndex++) {
    kernel.nowMs = outageStartedAtMs + sweepIndex * SWEEP_INTERVAL_MS;
    const sweep = await runSweep(kernel, state, lines, probes);
    check(`EACCES, sweep at +${sweepIndex * 10} s: still w1_slave`, sweep.method, "w1_slave");
  }
  check("EACCES: no trigger attempt before the retry is due", countTriggerAttempts(kernel), 1);
  check("EACCES: still exactly one warning", warnings(lines).length, 1);

  kernel.nowMs = outageStartedAtMs + 60_000;
  const retrySweep = await runSweep(kernel, state, lines, probes);
  check("EACCES, retry at +60 s: the trigger is tried again", countTriggerAttempts(kernel), 2);
  check("EACCES, retry at +60 s: still failing, falls back", retrySweep.method, "w1_slave");
  check("EACCES, retry at +60 s: no new warning, no line for the same cause", warnings(lines).length, 1);
  check("EACCES, retry at +60 s: no 'still unavailable' line", stillUnavailableLines(lines), []);

  // The attribute disappears (all probes detached once): the real O_WRONLY open reports ENOENT, not EACCES
  kernel.behaviour.denyTriggerWrite = false;
  rmSync(kernel.bulkReadPath);
  kernel.nowMs = outageStartedAtMs + 120_000;
  await runSweep(kernel, state, lines, probes);
  check("ENOENT during the outage: logged as a change of cause, not warned", warnings(lines).length, 1);
  check(
    "ENOENT during the outage: the line says ENOENT (no O_CREAT turning it into EACCES)",
    stillUnavailableLines(lines).map(text => text.includes("ENOENT") && !text.includes("EACCES")),
    [true]
  );
  check("ENOENT: nothing created in the fake sysfs", existsSync(kernel.bulkReadPath), false);

  writeStatus(kernel, "0");
  kernel.nowMs = outageStartedAtMs + 180_000;
  const recoveredSweep = await runSweep(kernel, state, lines, probes);
  check("recovered: bulk again", recoveredSweep.method, "bulk");
  check(
    "recovered: values via the temperature attribute",
    recoveredSweep.readings.map(reading => reading.value),
    [20, 25]
  );
  check(
    "recovered: logged with the outage's length and attempts",
    lines.some(line =>
      line.text.startsWith("1-wire bulk read works again after 3.0 min of per-probe reads (3 failed attempts)")
    ),
    true
  );
  check("recovered: no warning for the recovery", warnings(lines).length, 1);

  kernel.behaviour.denyTriggerWrite = true;
  kernel.nowMs += SWEEP_INTERVAL_MS;
  await runSweep(kernel, state, lines, probes);
  check("a new outage after recovery: warned again", warnings(lines).length, 2);
}

// ——— a real permission error from the filesystem (chmod; root ignores mode bits, so skipped as root) ———
if (runningAsRoot) {
  console.log("skip real EACCES via chmod: running as root, which bypasses file permissions");
} else {
  const kernel = createFakeKernel([[cell, 20000]]);
  chmodSync(kernel.bulkReadPath, 0o444);
  const lines: LoggedLine[] = [];
  const sweep = await runSweep(kernel, createThermometerSweepState(), lines, [cell]);
  check("real EACCES: falls back", sweep.method, "w1_slave");
  check("real EACCES: value via w1_slave", sweep.readings[0]?.value, 20);
  check("real EACCES: warned with the code", warnings(lines)[0]?.includes("EACCES"), true);
  chmodSync(kernel.bulkReadPath, 0o644);
}

// ——— the 85 °C power-on value across sweeps, on both paths ———
{
  const kernel = createFakeKernel([[cell, 85000]]);
  const state = createThermometerSweepState();
  const lines: LoggedLine[] = [];
  const valuesBySweep: (number | undefined)[] = [];
  for (const millidegrees of [85000, 22000, 85000, 80000, 85000, 85062]) {
    setProbeMillidegrees(kernel, cell.thermometer_device_id, millidegrees);
    valuesBySweep.push((await runSweep(kernel, state, lines, [cell])).readings[0]?.value);
    kernel.nowMs += SWEEP_INTERVAL_MS;
  }
  check("85 °C: rejected at first and after 22 °C, accepted after 80 °C; 85.062 is an ordinary value", valuesBySweep, [
    undefined,
    22,
    undefined,
    80,
    85,
    85.062,
  ]);

  kernel.behaviour.denyTriggerWrite = true;
  const fallbackState = createThermometerSweepState();
  setProbeMillidegrees(kernel, cell.thermometer_device_id, 85000);
  const fallbackSweep = await runSweep(kernel, fallbackState, lines, [cell]);
  check("85 °C via w1_slave: rejected too", [fallbackSweep.method, fallbackSweep.readings.length], ["w1_slave", 0]);
}

// ——— a probe stuck on its power-on value goes quiet under the guard, so it must page instead. Stuck since
// startup, it has no accepted reading to time its silence from, so the clock starts at its first failure ———
{
  const kernel = createFakeKernel([[busBar, 85000]]);
  const state = createThermometerSweepState();
  const lines: LoggedLine[] = [];
  const pageCountsAfterSweep: number[] = [];
  for (let sweepIndex = 1; sweepIndex <= FAILED_SWEEPS_TO_PAGE + 1; sweepIndex++) {
    await runSweep(kernel, state, lines, [busBar]);
    pageCountsAfterSweep.push(pages(lines).length);
    advanceToNextSweepStart(kernel, SWEEP_INTERVAL_MS);
  }
  check(
    "stuck at 85 °C since startup: no page 290 s after the first failure, one at 300 s",
    [pageCountsAfterSweep[29], pageCountsAfterSweep[30]],
    [0, 1]
  );
  check(
    "stuck at 85 °C: the page names the power-on value",
    pages(lines).map(page => page.includes(busBar.label) && page.includes("85°C power-on value")),
    [true]
  );
}

// ——— garbage, per probe: the rest of the sweep is unaffected ———
{
  const kernel = createFakeKernel([
    [cell, 21000],
    [outlet, 22000],
    [busBar, 23000],
  ]);
  const state = createThermometerSweepState();
  const lines: LoggedLine[] = [];
  const garbageCases: [string, string, string][] = [
    ["empty attribute", "", "empty read"],
    ["text", "garbage\n", "not whole millidegrees"],
    ["out of range", "127937\n", "outside -30…90°C"],
  ];
  for (const [caseName, temperatureText, expectedReason] of garbageCases) {
    setProbeTexts(kernel, outlet.thermometer_device_id, { temperatureText, w1SlaveText: w1SlaveTextFor(22000) });
    lines.length = 0;
    const sweep = await runSweep(kernel, state, lines, [cell, outlet, busBar]);
    check(
      `garbage (${caseName}): the other probes still read`,
      sweep.readings.map(reading => reading.label),
      ["cell_1", "negative_bus_bar"]
    );
    check(
      `garbage (${caseName}): logged with its reason`,
      lines.some(line => line.text.includes(outlet.thermometer_device_id) && line.text.includes(expectedReason)),
      true
    );
    kernel.nowMs += SWEEP_INTERVAL_MS;
  }

  kernel.behaviour.denyTriggerWrite = true;
  setProbeTexts(kernel, outlet.thermometer_device_id, {
    temperatureText: "22000\n",
    w1SlaveText: w1SlaveTextFor(22000, "NO"),
  });
  lines.length = 0;
  const fallbackSweep = await runSweep(kernel, createThermometerSweepState(), lines, [cell, outlet, busBar]);
  check(
    "garbage via w1_slave: a CRC NO is rejected, the others read",
    [fallbackSweep.method, fallbackSweep.readings.map(reading => reading.label)],
    ["w1_slave", ["cell_1", "negative_bus_bar"]]
  );
}

// ——— one probe gone for good after reading fine: logged every sweep, paged once (errorLog → P2) 5 min after
// its last reading, which at the default 10 s interval is the 30th failed sweep; recovery logged ———
{
  const kernel = createFakeKernel([
    [cell, 21000],
    [outlet, 22000],
  ]);
  const state = createThermometerSweepState();
  const lines: LoggedLine[] = [];
  await runSweep(kernel, state, lines, [cell, outlet]);
  advanceToNextSweepStart(kernel, SWEEP_INTERVAL_MS);
  removeProbe(kernel, outlet.thermometer_device_id);
  const pageCountsAfterSweep: number[] = [];
  for (let sweepIndex = 1; sweepIndex <= FAILED_SWEEPS_TO_PAGE + 1; sweepIndex++) {
    const sweep = await runSweep(kernel, state, lines, [cell, outlet]);
    if (sweep.readings.length !== 1) check(`missing probe, sweep ${sweepIndex}: the other probe reads`, false, true);
    pageCountsAfterSweep.push(pages(lines).length);
    advanceToNextSweepStart(kernel, SWEEP_INTERVAL_MS);
  }
  check(
    "missing probe: the page comes once, on the 30th failed sweep",
    [pageCountsAfterSweep[28], pageCountsAfterSweep[29], pageCountsAfterSweep[30]],
    [0, 1, 1]
  );
  check("missing probe: paged, not merely warned", warnings(lines), []);
  const firstPage = pages(lines)[0] ?? "";
  check(
    "missing probe: the page names the probe, the silence, the streak and the cause",
    [outlet.thermometer_device_id, outlet.label, "none for 5.0 min", "30 sweeps", "ENOENT"].every(part =>
      firstPage.includes(part)
    ),
    true
  );
  check(
    "missing probe: the errorLog dedupe key differs per probe and stays put when the cause or the numbers change",
    [
      errorLogDedupeKey([firstPage]) ===
        errorLogDedupeKey([firstPage.replace(outlet.thermometer_device_id, cell.thermometer_device_id)]),
      errorLogDedupeKey([firstPage]) === errorLogDedupeKey([firstPage.replace(/ENOENT.*/, "CRC didn't match")]),
      errorLogDedupeKey([firstPage]) ===
        errorLogDedupeKey([firstPage.replace("5.0 min (30 sweeps", "15.0 min (3 sweeps")]),
    ],
    [false, true, true]
  );
  check(
    "missing probe: every failure logged, with ENOENT",
    lines.filter(line => line.level === "log" && line.text.includes("ENOENT")).length,
    FAILED_SWEEPS_TO_PAGE + 1
  );
  mkdirSync(path.join(kernel.devicesDirectory, outlet.thermometer_device_id));
  setProbeMillidegrees(kernel, outlet.thermometer_device_id, 22500);
  const recoveredSweep = await runSweep(kernel, state, lines, [cell, outlet]);
  check("missing probe back: read again", recoveredSweep.readings[1]?.value, 22.5);
  check(
    "missing probe back: recovery logged",
    lines.some(line => line.text.includes("reads again after 31 failed sweeps")),
    true
  );
  check("missing probe back: streak cleared", state.failureStreaks.size, 0);
}

// ——— at the 60 s maximum with a 1 min delay, one failed sweep is already past the delay: the page waits for
// the third failed sweep, whichever of the two comes later ———
{
  const kernel = createFakeKernel([
    [cell, 21000],
    [outlet, 22000],
  ]);
  const state = createThermometerSweepState();
  const lines: LoggedLine[] = [];
  await runSweep(kernel, state, lines, [cell, outlet], pageAfterMinutes(1));
  removeProbe(kernel, outlet.thermometer_device_id);
  const pageCountsAfterSweep: number[] = [];
  for (let sweepIndex = 1; sweepIndex <= 4; sweepIndex++) {
    advanceToNextSweepStart(kernel, 60_000);
    await runSweep(kernel, state, lines, [cell, outlet], pageAfterMinutes(1));
    pageCountsAfterSweep.push(pages(lines).length);
  }
  check("60 s interval, 1 min delay: paged once, on the 3rd failed sweep", pageCountsAfterSweep, [0, 0, 1, 1]);
  check(
    "60 s interval, 1 min delay: the page says how long the probe has been silent",
    pages(lines)[0]?.includes("none for 3.0 min (3 sweeps in a row)"),
    true
  );
}

// ——— back to back (interval 0, a sweep every ~1.15 s), 30 failed sweeps are 35 s: the page still waits 5 min ———
{
  const BACK_TO_BACK_SWEEP_MS = 1150;
  const kernel = createFakeKernel([
    [cell, 21000],
    [outlet, 22000],
  ]);
  const state = createThermometerSweepState();
  const lines: LoggedLine[] = [];
  await runSweep(kernel, state, lines, [cell, outlet]);
  removeProbe(kernel, outlet.thermometer_device_id);
  const pageCountsAfterSweep: number[] = [];
  for (let sweepIndex = 1; sweepIndex <= 270; sweepIndex++) {
    advanceToNextSweepStart(kernel, BACK_TO_BACK_SWEEP_MS);
    await runSweep(kernel, state, lines, [cell, outlet]);
    pageCountsAfterSweep.push(pages(lines).length);
  }
  check(
    "back to back: no page after 30 failed sweeps, the page on the first one 5 min after the last reading, once",
    [pageCountsAfterSweep[29], pageCountsAfterSweep.indexOf(1) + 1, pages(lines).length],
    [0, Math.ceil(SILENT_PAGE_AFTER_MS / BACK_TO_BACK_SWEEP_MS), 1]
  );
}

// ——— the bulk retry interval is a live setting, timed from the last attempt each sweep ———
{
  const kernel = createFakeKernel([[cell, 20000]], { denyTriggerWrite: true });
  const state = createThermometerSweepState();
  const lines: LoggedLine[] = [];
  const outageStartedAtMs = kernel.nowMs;
  await runSweep(kernel, state, lines, [cell], retryEvery(20));
  check(
    "retry setting: the outage warning names the configured interval",
    warnings(lines)[0]?.includes("trying the bulk trigger again every 20 s"),
    true
  );
  const triggerAttemptsAfterSweep: number[] = [];
  for (const secondsIntoOutage of [10, 20, 30, 40]) {
    kernel.nowMs = outageStartedAtMs + secondsIntoOutage * 1000;
    await runSweep(kernel, state, lines, [cell], retryEvery(20));
    triggerAttemptsAfterSweep.push(countTriggerAttempts(kernel));
  }
  check("retry setting: at 20 s, tried again at +20 s and +40 s", triggerAttemptsAfterSweep, [1, 2, 2, 3]);
  // The last attempt was at +40 s
  kernel.nowMs = outageStartedAtMs + 50_000;
  await runSweep(kernel, state, lines, [cell], retryEvery(60));
  const attemptsAfterLengthening = countTriggerAttempts(kernel);
  kernel.nowMs = outageStartedAtMs + 60_000;
  await runSweep(kernel, state, lines, [cell], retryEvery(10));
  check(
    "retry setting: changed to 60 s, not due 10 s after the last attempt; changed to 10 s, the next sweep tries",
    [attemptsAfterLengthening, countTriggerAttempts(kernel)],
    [3, 4]
  );
}

// ——— the silent-probe delay is a live setting: lowered mid-silence it pages at the next failed sweep, once ———
{
  const kernel = createFakeKernel([
    [cell, 21000],
    [outlet, 22000],
  ]);
  const state = createThermometerSweepState();
  const lines: LoggedLine[] = [];
  await runSweep(kernel, state, lines, [cell, outlet]);
  removeProbe(kernel, outlet.thermometer_device_id);
  const pageCountsAfterSweep: number[] = [];
  for (let sweepIndex = 1; sweepIndex <= 16; sweepIndex++) {
    advanceToNextSweepStart(kernel, SWEEP_INTERVAL_MS);
    // The default 5 min for the first 10 failed sweeps (100 s of silence), then 1 min
    await runSweep(kernel, state, lines, [cell, outlet], pageAfterMinutes(sweepIndex <= 10 ? 5 : 1));
    pageCountsAfterSweep.push(pages(lines).length);
  }
  check(
    "silent setting: lowered to 1 min after 100 s of silence, paged at the next failed sweep and only then",
    [pageCountsAfterSweep[9], pageCountsAfterSweep[10], pageCountsAfterSweep[15]],
    [0, 1, 1]
  );
  check(
    "silent setting: the page says how long the probe had been silent",
    pages(lines)[0]?.includes("none for 1.8 min (11 sweeps in a row)"),
    true
  );
}
{
  const kernel = createFakeKernel([
    [cell, 21000],
    [outlet, 22000],
  ]);
  const state = createThermometerSweepState();
  const lines: LoggedLine[] = [];
  const quarterHour = pageAfterMinutes(15);
  await runSweep(kernel, state, lines, [cell, outlet], quarterHour);
  removeProbe(kernel, outlet.thermometer_device_id);
  const pageCountsAfterSweep: number[] = [];
  for (let sweepIndex = 1; sweepIndex <= 90; sweepIndex++) {
    advanceToNextSweepStart(kernel, SWEEP_INTERVAL_MS);
    await runSweep(kernel, state, lines, [cell, outlet], quarterHour);
    pageCountsAfterSweep.push(pages(lines).length);
  }
  check(
    "silent setting: at 15 min, no page after 5 min of silence, one after 15",
    [pageCountsAfterSweep[29], pageCountsAfterSweep[88], pageCountsAfterSweep[89]],
    [0, 0, 1]
  );
}

for (const fakeDirectory of fakeDirectories) rmSync(fakeDirectory, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall thermometer sweep checks passed");

/**
 * Moves the clock to the next sweep's start, `intervalMs` after the previous one's (start to start, as the loop
 * paces them): the fake trigger write has already advanced it by the conversion time. Assumes a bulk sweep.
 */
function advanceToNextSweepStart(kernel: FakeKernel, intervalMs: number) {
  kernel.nowMs += intervalMs - kernel.behaviour.triggerWriteBlocksMs;
}

function retryEvery(seconds: number): ThermometerSweepContextSettings {
  return { ...DEFAULT_THERMOMETER_SWEEP_SETTINGS, thermometer_bulk_retry_interval_seconds: seconds };
}

function pageAfterMinutes(minutes: number): ThermometerSweepContextSettings {
  return { ...DEFAULT_THERMOMETER_SWEEP_SETTINGS, thermometer_silent_page_after_minutes: minutes };
}

function runSweep(
  kernel: FakeKernel,
  state: ThermometerSweepState,
  lines: LoggedLine[],
  probes: ThermometerProbe[],
  settings: ThermometerSweepContextSettings = DEFAULT_THERMOMETER_SWEEP_SETTINGS
) {
  return sweepThermometers({
    probes,
    state,
    sysfs: fakeSysfsAccess(kernel),
    logger: capturingLogger(lines),
    devicesDirectory: kernel.devicesDirectory,
    timing,
    settings,
  });
}

function createFakeKernel(
  probes: [ThermometerProbe, number][],
  behaviour: Partial<FakeKernelBehaviour> = {}
): FakeKernel {
  const devicesDirectory = mkdtempSync(path.join(tmpdir(), "thermometer-sweep-selftest-"));
  fakeDirectories.push(devicesDirectory);
  mkdirSync(path.join(devicesDirectory, "w1_bus_master1"));
  const kernel: FakeKernel = {
    devicesDirectory,
    bulkReadPath: path.join(devicesDirectory, "w1_bus_master1", "therm_bulk_read"),
    behaviour: {
      triggerWriteBlocksMs: 750,
      pendingStatusReads: 0,
      statusAfterConversion: "1",
      denyTriggerWrite: false,
      ...behaviour,
    },
    probeTexts: new Map(),
    status: "0",
    pendingStatusReadsLeft: 0,
    nowMs: 1_000_000,
    events: [],
    triggerWrites: [],
  };
  writeStatus(kernel, "0");
  for (const [probe, millidegrees] of probes) {
    mkdirSync(path.join(devicesDirectory, probe.thermometer_device_id));
    setProbeMillidegrees(kernel, probe.thermometer_device_id, millidegrees);
  }
  return kernel;
}

function fakeSysfsAccess(kernel: FakeKernel): SysfsAccess {
  return {
    readText: filePath => fakeReadText(kernel, filePath),
    writeText: (filePath, contents) => fakeWriteText(kernel, filePath, contents),
    sleep: milliseconds => fakeSleep(kernel, milliseconds),
    nowMs: () => kernel.nowMs,
  };
}

async function fakeReadText(kernel: FakeKernel, filePath: string) {
  kernel.events.push(`read ${path.relative(kernel.devicesDirectory, filePath)}`);
  const contents = await nodeSysfsAccess.readText(filePath);
  if (filePath === kernel.bulkReadPath && kernel.status === "-1" && kernel.pendingStatusReadsLeft > 0) {
    kernel.pendingStatusReadsLeft--;
    if (kernel.pendingStatusReadsLeft === 0) completeConversion(kernel);
  }
  return contents;
}

async function fakeSleep(kernel: FakeKernel, milliseconds: number) {
  kernel.events.push(`sleep ${milliseconds}`);
  kernel.nowMs += milliseconds;
}

/** w1_therm's trigger_bulk_read, as far as the sweep can observe it */
async function fakeWriteText(kernel: FakeKernel, filePath: string, contents: string) {
  kernel.events.push(`write ${path.relative(kernel.devicesDirectory, filePath)} ${JSON.stringify(contents)}`);
  if (filePath === kernel.bulkReadPath && kernel.behaviour.denyTriggerWrite) {
    throw Object.assign(new Error(`EACCES: permission denied, open '${filePath}'`), {
      code: "EACCES",
      errno: -13,
      syscall: "open",
      path: filePath,
    });
  }
  const statusBefore = kernel.status;
  await nodeSysfsAccess.writeText(filePath, contents);
  if (filePath !== kernel.bulkReadPath) return;
  kernel.triggerWrites.push(contents);
  if (contents !== "trigger\n") {
    // The kernel ignores anything but exactly "trigger\n" and still reports success
    writeStatus(kernel, statusBefore);
    return;
  }
  writeStatus(kernel, "-1");
  // While converting, both attributes read back empty ("Conversion in progress, retry later")
  for (const thermometerDeviceId of kernel.probeTexts.keys()) {
    writeProbeFile(kernel, thermometerDeviceId, "temperature", "");
    writeProbeFile(kernel, thermometerDeviceId, "w1_slave", "");
  }
  kernel.nowMs += kernel.behaviour.triggerWriteBlocksMs;
  kernel.pendingStatusReadsLeft = kernel.behaviour.pendingStatusReads;
  if (kernel.pendingStatusReadsLeft === 0) completeConversion(kernel);
}

function completeConversion(kernel: FakeKernel) {
  writeStatus(kernel, kernel.behaviour.statusAfterConversion);
  for (const [thermometerDeviceId, texts] of kernel.probeTexts) {
    writeProbeFile(kernel, thermometerDeviceId, "temperature", texts.temperatureText);
    writeProbeFile(kernel, thermometerDeviceId, "w1_slave", texts.w1SlaveText);
  }
}

function writeStatus(kernel: FakeKernel, status: string) {
  kernel.status = status;
  writeFileSync(kernel.bulkReadPath, `${status}\n`);
}

function setProbeMillidegrees(kernel: FakeKernel, thermometerDeviceId: string, millidegrees: number) {
  setProbeTexts(kernel, thermometerDeviceId, {
    temperatureText: `${millidegrees}\n`,
    w1SlaveText: w1SlaveTextFor(millidegrees),
  });
}

function setProbeTexts(kernel: FakeKernel, thermometerDeviceId: string, texts: ProbeTexts) {
  kernel.probeTexts.set(thermometerDeviceId, texts);
  writeProbeFile(kernel, thermometerDeviceId, "temperature", texts.temperatureText);
  writeProbeFile(kernel, thermometerDeviceId, "w1_slave", texts.w1SlaveText);
}

function writeProbeFile(kernel: FakeKernel, thermometerDeviceId: string, attribute: string, contents: string) {
  writeFileSync(path.join(kernel.devicesDirectory, thermometerDeviceId, attribute), contents);
}

function removeProbe(kernel: FakeKernel, thermometerDeviceId: string) {
  kernel.probeTexts.delete(thermometerDeviceId);
  rmSync(path.join(kernel.devicesDirectory, thermometerDeviceId), { recursive: true });
}

function w1SlaveTextFor(millidegrees: number, crcVerdict: "YES" | "NO" = "YES") {
  return `84 01 55 05 7f a5 a5 66 f5 : crc=f5 ${crcVerdict}\n84 01 55 05 7f a5 a5 66 f5 t=${millidegrees}\n`;
}

function capturingLogger(lines: LoggedLine[]): SweepLogger {
  return {
    log: (...details) => lines.push({ level: "log", text: details.map(String).join(" ") }),
    warn: (...details) => lines.push({ level: "warn", text: details.map(String).join(" ") }),
    error: (...details) => lines.push({ level: "error", text: details.map(String).join(" ") }),
  };
}

function countTriggerAttempts(kernel: FakeKernel) {
  return kernel.events.filter(event => event.startsWith("write")).length;
}

function warnings(lines: LoggedLine[]) {
  return lines.filter(line => line.level === "warn").map(line => line.text);
}

function pages(lines: LoggedLine[]) {
  return lines.filter(line => line.level === "error").map(line => line.text);
}

function stillUnavailableLines(lines: LoggedLine[]) {
  return lines.filter(line => line.text.startsWith("1-wire bulk read still unavailable")).map(line => line.text);
}
