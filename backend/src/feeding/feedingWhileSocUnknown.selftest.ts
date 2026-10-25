/**
 * Pure self-test: battery feeding while the SOC (and so `charging`) is unknown — the power cut that lands
 * mid-sell while InfluxDB is still booting (#55 review). Walks batteryStateFeedingGate through that boot.
 * Selling itself can't export meanwhile: shouldSellPower's export is undefined while the SOC is, which
 * feedWhenNoSolar treats as no export (and its forced feed amount falls back to feed_amount_watts).
 * Run from backend/ with:  yarn node src/feeding/feedingWhileSocUnknown.selftest.ts
 */
import process from "process";
import { default_config } from "../config/config.ts";
import {
  batteryStateFeedingGate,
  CHARGING_UNKNOWN_GRACE_MS,
  type BatteryStateGate,
} from "./batteryStateFeedingGate.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const feedingConfig = default_config.feed_from_battery_when_no_solar;
const cutoffVolts = feedingConfig.disable_below_battery_voltage;
const describe = (gate: BatteryStateGate) =>
  gate.settled
    ? `settled → ${gate.decision} (${gate.reason})`
    : `not settled (${gate.batteryVoltage} V, charging ${gate.charging})`;

// ---------- the boot: power came back mid-sell, the inverter still holds EDF1 + the sell GPMP ----------
{
  const beforeFirstGs = batteryStateFeedingGate({
    batteryVoltage: undefined,
    charging: undefined,
    previousDecision: undefined,
    msSinceFeedingStarted: 1_000,
    ...feedingConfig,
  });
  check(
    "t=1 s, no voltage yet → no decision, nothing written",
    beforeFirstGs.settled && beforeFirstGs.decision === undefined,
    describe(beforeFirstGs)
  );

  const firstVoltage = batteryStateFeedingGate({
    batteryVoltage: 52.6,
    charging: undefined,
    previousDecision: undefined,
    msSinceFeedingStarted: 3_000,
    ...feedingConfig,
  });
  check(
    "t=3 s, voltage known but SOC/BATS not yet → wait (a normal boot decides within this grace)",
    firstVoltage.settled && firstVoltage.decision === undefined,
    describe(firstVoltage)
  );

  const graceOver = batteryStateFeedingGate({
    batteryVoltage: 52.4,
    charging: undefined,
    previousDecision: undefined,
    msSinceFeedingStarted: CHARGING_UNKNOWN_GRACE_MS,
    ...feedingConfig,
  });
  check(
    "t=60 s, SOC still unknown (InfluxDB down) → stop feeding from the battery: EDF0/EDG0, GPMP to baseline",
    graceOver.settled && graceOver.decision === false && graceOver.reason.includes("no SOC"),
    describe(graceOver)
  );

  const stillDown = batteryStateFeedingGate({
    batteryVoltage: 52.3,
    charging: undefined,
    previousDecision: false,
    msSinceFeedingStarted: 8 * 60_000,
    ...feedingConfig,
  });
  check(
    "t=8 min, still unknown → stays off (no flapping back to the persisted export)",
    stillDown.settled && stillDown.decision === false,
    describe(stillDown)
  );

  const socKnown = batteryStateFeedingGate({
    batteryVoltage: 52.2,
    charging: false,
    previousDecision: false,
    msSinceFeedingStarted: 11 * 60_000,
    ...feedingConfig,
  });
  check(
    "t=11 min, InfluxDB answered → the normal feeding logic decides again",
    !socKnown.settled && socKnown.batteryVoltage === 52.2 && socKnown.charging === false,
    describe(socKnown)
  );
}

// ---------- the voltage cutoff no longer waits behind the unknown SOC ----------
{
  const lowDuringGrace = batteryStateFeedingGate({
    batteryVoltage: cutoffVolts,
    charging: undefined,
    previousDecision: undefined,
    msSinceFeedingStarted: 2_000,
    ...feedingConfig,
  });
  check(
    "voltage at the cutoff during the grace → off immediately",
    lowDuringGrace.settled && lowDuringGrace.decision === false && lowDuringGrace.reason.includes("disable threshold"),
    describe(lowDuringGrace)
  );
  const lowWhileFeeding = batteryStateFeedingGate({
    batteryVoltage: cutoffVolts - 0.5,
    charging: undefined,
    previousDecision: true,
    msSinceFeedingStarted: 30 * 60_000,
    ...feedingConfig,
  });
  check(
    "feeding, SOC unknown, voltage below the cutoff → off (this used to hold the feed)",
    lowWhileFeeding.settled && lowWhileFeeding.decision === false,
    describe(lowWhileFeeding)
  );
  const lowWithSocKnown = batteryStateFeedingGate({
    batteryVoltage: cutoffVolts - 0.5,
    charging: false,
    previousDecision: true,
    msSinceFeedingStarted: 30 * 60_000,
    ...feedingConfig,
  });
  check("SOC known, voltage below the cutoff → off, as before", lowWithSocKnown.settled && !lowWithSocKnown.decision);
}

// ---------- a decision that exists rides out a momentary unknown ----------
{
  const reanchorBlink = batteryStateFeedingGate({
    batteryVoltage: 52.9,
    charging: undefined,
    previousDecision: true,
    msSinceFeedingStarted: 5 * 60 * 60_000,
    ...feedingConfig,
  });
  check(
    "feeding, SOC blinks undefined for a re-anchor tick → keep feeding (no trip through the 3-min throttle)",
    reanchorBlink.settled && reanchorBlink.decision === true,
    describe(reanchorBlink)
  );
  const voltageGone = batteryStateFeedingGate({
    batteryVoltage: undefined,
    charging: true,
    previousDecision: true,
    msSinceFeedingStarted: 5 * 60 * 60_000,
    ...feedingConfig,
  });
  check("voltage reading missing → hold, as before", voltageGone.settled && voltageGone.decision === true);
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all feedingWhileSocUnknown selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
