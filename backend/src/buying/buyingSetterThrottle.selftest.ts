/**
 * Reactive self-test of the MUCHGC write throttle inside the buying setters (buyingSetterWiring.ts →
 * throttledSetterTarget.ts), on the wiring harness: a window start goes out in its tick at full target,
 * noise is held to one write per interval, a large decrease and the window end's idle cap go out in their
 * tick (the step-down's hold intact), the knobs apply live, and each change is logged with its reason. The
 * step-down's own re-asks and alternate cap bypass the throttle: buyingSetterWiring.selftest.ts and
 * buyingSetterSession.selftest.ts run them through this graph at the default knobs. The rules alone:
 * inverterComms/setterChangeThrottle.selftest.ts.
 * Run from backend/ with:  yarn node src/buying/buyingSetterThrottle.selftest.ts
 */
import process from "process";
import {
  DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS,
  SETTER_CHANGE_THROTTLE_BOUNDS,
} from "../inverterComms/setterChangeThrottle.ts";
import {
  advanceTo,
  createWiringHarness,
  decodeBats,
  decodeHecs,
  queuedDuring,
  recordSend,
  type WiringHarness,
} from "./buyingSetterWiringHarness.ts";

const failedChecks: string[] = [];

{
  const harness = beforeWindow();
  const logLines: string[] = [];
  const startTick = withLogsCaptured(logLines, () => queuedDuring(harness, () => harness.setChargingAmperage(261)));
  check(
    "window start: EDB1 and the full MUCHGC2610 in its tick",
    startTick.includes("EDB1") && startTick.includes("MUCHGC2610"),
    startTick.join(" ")
  );
  check(
    "…logged as the buy window start",
    logLines.some(line => line.includes("MUCHGC target 10 → 261 A: buy window start")),
    logLines.join(" | ")
  );
  acceptWindowStart(harness);

  // 258↔263 A every 2 s, like the per-phase load noise of 2026-10-27; a held target goes out on a clock tick
  const queuedBeforeNoise = harness.queued.length;
  for (let atMs = 14_000; atMs <= 140_000; atMs += 2_000) {
    advanceTo(harness, atMs);
    harness.setChargingAmperage((atMs / 2_000) % 2 ? 263 : 258);
  }
  const noiseLimitWrites = harness.queued.slice(queuedBeforeNoise).filter(entry => isLimitWrite(entry.command));
  check(
    "noise for 2 min after the start: one MUCHGC per 45 s (at 46, 92 and 138 s), nothing before",
    noiseLimitWrites.map(write => write.atMs).join() === "46000,92000,138000",
    noiseLimitWrites.map(write => `${write.atMs}:${write.command}`).join(" ")
  );

  advanceTo(harness, 141_000);
  logLines.length = 0;
  const loadStepTick = withLogsCaptured(logLines, () => queuedDuring(harness, () => harness.setChargingAmperage(185)));
  check(
    "a load step 3 s after a change (the EV starting): MUCHGC1850 in its tick",
    loadStepTick.includes("MUCHGC1850"),
    loadStepTick.join(" ")
  );
  check(
    "…logged as a safety decrease",
    logLines.some(line => line.includes("→ 185 A: safety decrease")),
    logLines.join(" | ")
  );

  advanceTo(harness, 142_000);
  logLines.length = 0;
  const endTick = withLogsCaptured(logLines, () => queuedDuring(harness, () => harness.setChargingAmperage(0)));
  check(
    "window end 1 s after that: the step-down's MUCHGC0100 in its tick, no EDB0, the hold in force",
    endTick.includes("MUCHGC0100") && !endTick.includes("EDB0") && harness.wiring.holdsAcChargingOn(),
    endTick.join(" ")
  );
  check(
    "…logged as the window end",
    logLines.some(line => line.includes("MUCHGC target 185 → 10 A: no buy window wants charging")),
    logLines.join(" | ")
  );
  advanceTo(harness, 144_000);
  const reEntryTick = queuedDuring(harness, () => harness.setChargingAmperage(261));
  check(
    "the window re-entered 2 s later: MUCHGC2610 in its tick",
    reEntryTick.includes("MUCHGC2610") && !reEntryTick.includes("EDB0"),
    reEntryTick.join(" ")
  );
  harness.dispose();
}

{
  // The knobs, changed live (the config page's ws patch reaches the wiring as a new settings value)
  const harness = beforeWindow();
  harness.setChargingAmperage(261);
  acceptWindowStart(harness);
  advanceTo(harness, 20_000);
  const heldIncrease = queuedDuring(harness, () => harness.setChargingAmperage(268));
  check("an increase 20 s in is held at the default 45 s", !heldIncrease.some(isLimitWrite), heldIncrease.join(" "));
  const shorterInterval = queuedDuring(harness, () =>
    harness.setSetterChangeThrottle({
      ...DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS,
      min_seconds_between_setting_changes: 15,
    })
  );
  check(
    "the interval cut to 15 s: the held MUCHGC2680 goes out in that tick",
    shorterInterval.includes("MUCHGC2680"),
    shorterInterval.join(" ")
  );
  harness.setSetterChangeThrottle({
    ...DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS,
    ac_charging_current_immediate_decrease_amps: 30,
  });
  advanceTo(harness, 22_000);
  const heldDecrease = queuedDuring(harness, () => harness.setChargingAmperage(248));
  check("the margin raised to 30 A: a 20 A decrease is held", !heldDecrease.some(isLimitWrite), heldDecrease.join(" "));
  const marginBack = queuedDuring(harness, () =>
    harness.setSetterChangeThrottle(DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS)
  );
  check("…and goes out the moment the margin is back at 10 A", marginBack.includes("MUCHGC2480"), marginBack.join(" "));
  // The interval at its 15 s floor (config can't go lower): a blip back and forth inside it is never written
  harness.setSetterChangeThrottle({
    ...DEFAULT_SETTER_CHANGE_THROTTLE_SETTINGS,
    min_seconds_between_setting_changes: SETTER_CHANGE_THROTTLE_BOUNDS.min_seconds_between_setting_changes.min,
  });
  const blipWrites: string[] = [];
  for (const [atMs, amps] of [
    [23_000, 251],
    [24_000, 249],
    [25_000, 252],
  ] as const) {
    advanceTo(harness, atMs);
    blipWrites.push(...queuedDuring(harness, () => harness.setChargingAmperage(amps)).filter(isLimitWrite));
  }
  // The clock ticks while advancing: the held 252 goes out on the first tick 15 s after the last write (22 s)
  const afterFloor = queuedDuring(harness, () => advanceTo(harness, 38_000)).filter(isLimitWrite);
  check(
    "interval at its 15 s floor: changes within 15 s of the last write are held, the latest goes out once it has passed",
    blipWrites.length === 0 && afterFloor.join(" ") === "MUCHGC2520",
    `held: ${blipWrites.join(" ") || "nothing written"}; by 38 s: ${afterFloor.join(" ")}`
  );
  harness.dispose();
}

if (failedChecks.length) {
  console.error(`\n${failedChecks.length} check(s) FAILED:`, failedChecks.join("; "));
  process.exit(1);
}
console.log("\nAll buying setter throttle checks passed");

/** Idle since long before (AC charging off, the idle cap read back), the clock at 0 */
function beforeWindow(): WiringHarness {
  const harness = createWiringHarness(
    { chargingAmperageForBuying: 0, acChargeBatteryState: "disabled", hallBatteryAmps: -3 },
    { clock: { monotonicMs: -600_000 } }
  );
  decodeHecs(harness, "disabled");
  decodeBats(harness, 10);
  advanceTo(harness, 0);
  return harness;
}

/** The session sends the start's EDB1 and MUCHGC2610, and the settings poll shows both by 13 s */
function acceptWindowStart(harness: WiringHarness) {
  advanceTo(harness, 300);
  recordSend(harness, "EDB1");
  advanceTo(harness, 600);
  recordSend(harness, "MUCHGC2610");
  advanceTo(harness, 13_000);
  decodeHecs(harness, "enabled");
  decodeBats(harness, 261);
}

function isLimitWrite(command: string): boolean {
  return command.startsWith("MUCHGC");
}

/** Runs `action` with console.log (where logLog prints) also collected into `lines` */
function withLogsCaptured<Result>(lines: string[], action: () => Result): Result {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
    originalLog(...args);
  };
  try {
    return action();
  } finally {
    console.log = originalLog;
  }
}

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) failedChecks.push(name);
}
