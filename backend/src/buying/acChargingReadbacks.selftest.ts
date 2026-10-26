/**
 * Reactive self-test of the step-down's readback memos (acChargingReadbacks.ts): the BATS AC charging
 * limit and the HECS "AC charge battery" flag, each stamped with when it was observed.
 * Run from backend/ with:  yarn node src/buying/acChargingReadbacks.selftest.ts
 */
import process from "process";
import { createRoot, createSignal } from "solid-js";
import type { DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import type { UsbValues } from "../inverterComms/inverterComms.types.ts";
import { createAcChargingReadbacks } from "./acChargingReadbacks.ts";

const failedChecks: string[] = [];

{
  // The readback memos on their own
  createRoot(dispose => {
    const [lastDecodedRound, setLastDecodedRound] = createSignal<DecodedRound | undefined>(undefined);
    const [acChargeBatteryState, setAcChargeBatteryState] = createSignal<UsbValues["ac_charge_battery"]>("enabled");
    let nowMs = 0;
    const { acChargingLimitReadback, acChargingReading } = createAcChargingReadbacks({
      lastDecodedRound,
      acChargeBatteryState,
      monotonicNowMs: () => nowMs,
      sessionAcChargingReadAtMs: () => undefined,
    });
    check("BATS memo: nothing before a BATS round", acChargingLimitReadback() === undefined);
    check(
      "HECS reading: state from the store, time unknown (-Infinity) before any HECS round",
      acChargingReading()?.state === "enabled" && acChargingReading()?.observedAtMs === -Infinity
    );
    const withSessionTime = createAcChargingReadbacks({
      lastDecodedRound,
      acChargeBatteryState,
      monotonicNowMs: () => nowMs,
      sessionAcChargingReadAtMs: () => -5_000,
    });
    check(
      "HECS reading: …or, if the session knows it, the time of its last HECS decode",
      withSessionTime.acChargingReading()?.observedAtMs === -5_000
    );
    nowMs = 1_000;
    setLastDecodedRound({
      command: "BATS",
      wireCommand: "BATS",
      fields: { "max._ac_charging_current": 261 },
      decodedAt: 0,
    });
    const first = acChargingLimitReadback();
    check("BATS memo: amps + the monotonic time it was observed", first?.amps === 261 && first.observedAtMs === 1_000);
    nowMs = 2_000;
    setLastDecodedRound({ command: "GS", wireCommand: "GS", fields: { battery_voltage: 55 }, decodedAt: 0 });
    check("BATS memo: a GS round keeps the very same readback", acChargingLimitReadback() === first);
    setLastDecodedRound({
      command: "BATS",
      wireCommand: "BATS",
      fields: { "max._ac_charging_current": "garbled" },
      decodedAt: 0,
    });
    check("BATS memo: a non-numeric limit keeps the previous one (and warns)", acChargingLimitReadback() === first);
    nowMs = 3_000;
    setLastDecodedRound({
      command: "HECS",
      wireCommand: "HECS",
      fields: { ac_charge_battery: "enabled" },
      decodedAt: 0,
    });
    check("HECS reading: stamped by a HECS round", acChargingReading()?.observedAtMs === 3_000);
    nowMs = 4_000;
    setLastDecodedRound({
      command: "HECS",
      wireCommand: "HECS",
      fields: { feed_power_to_utility: "enabled" },
      decodedAt: 0,
    });
    check(
      "HECS reading: a HECS round without the flag doesn't restamp it",
      acChargingReading()?.observedAtMs === 3_000
    );
    setAcChargeBatteryState("disabled");
    check("HECS reading: follows the store's state", acChargingReading()?.state === "disabled");
    dispose();
  });
}

if (failedChecks.length) {
  console.error(`\n${failedChecks.length} check(s) FAILED:`, failedChecks.join("; "));
  process.exit(1);
}
console.log("\nAll AC charging readback memo checks passed");

function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) failedChecks.push(name);
}
