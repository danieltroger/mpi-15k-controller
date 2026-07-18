import { type Accessor, createEffect, createMemo, onCleanup, type Setter, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import { errorLog, logLog } from "../utilities/logging.ts";
import { deparallelize_no_drop } from "../vendor/depictUtilishared.ts";
import { reactiveBatteryCurrent, reactiveBatteryVoltage } from "../mqttValues/mqttHelpers.ts";
import { useUsbInverterConfiguration } from "../usbInverterConfiguration/UsbInverterConfigurationProvider.ts";
import type { CommandQueue } from "../usbInverterConfiguration/usb.types.ts";

let lastVoltageSetAt = 0;

export function prematureFloatBugWorkaround({
  config,
  clampedSocAh,
}: {
  config: Accessor<Config>;
  clampedSocAh: Accessor<number | undefined>;
}) {
  const { $usbValues, setCommandQueue } = useUsbInverterConfiguration();
  // Wh discharged below full, derived from the Ah SOC: (100 − SOC)% of the usable pack energy
  // (capacity_ah × mean discharge-branch voltage). Same meaning — and same config key
  // start_bulk_charge_after_wh_discharged — as the deleted Wh energyRemovedSinceFull it replaces.
  const energyRemovedSinceFull = createMemo(() => {
    const soc = clampedSocAh();
    if (soc == undefined) return undefined;
    const { capacity_ah, v_discharge } = config().soc_calculations.ah_ledger;
    return ((100 - soc) / 100) * capacity_ah * v_discharge;
  });
  // Confirmed values come from the periodic BATS readback over serial (plus the immediate +10 s
  // refresh after every write), which replaces the old Shinemonitor cloud readback resource.
  const localStateOfConfiguredVoltageFloat = createMemo(() =>
    parseConfirmedVoltage($usbValues.battery_floating_charge_voltage, "battery_floating_charge_voltage")
  );
  const localStateOfConfiguredVoltageBulk = createMemo(() =>
    parseConfirmedVoltage($usbValues["battery_constant_charge_voltage(c.v.)"], "battery_constant_charge_voltage(c.v.)")
  );
  const deparallelizedSetChargeVoltages = deparallelize_no_drop((targetVoltage: number) =>
    setChargeVoltagesWithThrottling(targetVoltage, setCommandQueue)
  );
  const wantVoltagesToBeSetTo = createMemo<number | undefined>(prev => {
    const voltage = reactiveBatteryVoltage();
    const startChargingBelow = config().start_bulk_charge_voltage;
    const { full_battery_voltage, start_bulk_charge_after_wh_discharged, float_charging_voltage } = config();
    if (!voltage) return prev;
    if (voltage <= startChargingBelow) {
      // Emergency voltage based charging, in case something breaks with DB or something
      return full_battery_voltage;
    } else if (
      voltage >= full_battery_voltage &&
      (reactiveBatteryCurrent() as number) < config().stop_charging_below_current
    ) {
      // When battery full, stop charging
      return float_charging_voltage;
    } else if (prev === full_battery_voltage) {
      // If we are charging, stay charging until above condition is met. Otherwise we'd stop charging as soon as we've charged until start_bulk_charge_after_wh_discharged is still left
      return full_battery_voltage;
    }
    const removedSinceFull = energyRemovedSinceFull();
    const configuredFloat = localStateOfConfiguredVoltageFloat();
    const configuredBulk = localStateOfConfiguredVoltageBulk();
    if (removedSinceFull == undefined || configuredBulk == undefined || configuredFloat == undefined) return prev;
    if (prev === undefined && configuredBulk === configuredFloat) {
      // Probably application/function just (re-)started after a crash, roll with whatever the inverter is currently set to to not interrupt the charging process
      return configuredBulk;
    }
    const shouldChargeDueToDischarged = removedSinceFull >= start_bulk_charge_after_wh_discharged;
    if (shouldChargeDueToDischarged) {
      if (prev !== full_battery_voltage) {
        logLog(
          "Discharged",
          removedSinceFull,
          "wh since full, which is more than",
          start_bulk_charge_after_wh_discharged,
          "wh starting bulk charge"
        );
      }
      return full_battery_voltage;
    }
    if (prev !== float_charging_voltage) {
      logLog(
        "Discharged",
        removedSinceFull,
        "wh since full, which is less than",
        start_bulk_charge_after_wh_discharged,
        "wh, starting to float charge"
      );
    }
    return float_charging_voltage;
  });

  createEffect(() => logLog("We now want the voltage to be set to", wantVoltagesToBeSetTo()));

  createEffect(() =>
    logLog("Got confirmed: configured float voltage from inverter (BATS)", localStateOfConfiguredVoltageFloat())
  );
  createEffect(() =>
    logLog("Got confirmed: configured CV/bulk voltage from inverter (BATS)", localStateOfConfiguredVoltageBulk())
  );

  // One MCHGV writes CV/bulk and float atomically, and the inverter validates the pair WITHIN the
  // command, not against the currently-stored values (verified live 2026-07-18: with 58.0/58.0
  // configured, MCHGV0570,0570 ACKs and applies — a downward move needs no sequencing). The old
  // ordering guards here (never set float above the configured bulk / bulk below the configured
  // float) only existed because the cloud wrote the two ids separately and the inverter rejected
  // the transient float>bulk state between the writes; with the atomic command they're gone. The
  // float ≤ CV constraint itself is still real and enforced per command — MCHGV0560,0570 NAKs
  // with settings unchanged — which queueChargeVoltagesCommand guards before sending.
  createEffect(() =>
    queueVoltageSyncIfNeeded({
      wantsVoltage: wantVoltagesToBeSetTo(),
      confirmedFloat: localStateOfConfiguredVoltageFloat(),
      confirmedBulk: localStateOfConfiguredVoltageBulk(),
      deparallelizedSetChargeVoltages,
    })
  );
  // The effect above only re-fires when a signal actually changes value, but a rejected or dropped
  // MCHGV leaves the confirmed voltages exactly as they were — the store's equality check then
  // suppresses every subsequent BATS readback and nothing would ever retry the write. This
  // interval is the self-heal for that case (the 60 s throttle in the setter keeps it polite).
  const retryInterval = setInterval(
    () => {
      // The inverter ACKs MCHGV immediately but BATS reflects the new values only after ~6 s
      // (verified live) — a tick landing in that window would see stale values and re-send a write
      // that already succeeded, so skip while a recent write's confirmation may still be in flight.
      if (+new Date() - lastVoltageSetAt < 90_000) return;
      untrack(() =>
        queueVoltageSyncIfNeeded({
          wantsVoltage: wantVoltagesToBeSetTo(),
          confirmedFloat: localStateOfConfiguredVoltageFloat(),
          confirmedBulk: localStateOfConfiguredVoltageBulk(),
          deparallelizedSetChargeVoltages,
        })
      );
    },
    1000 * 60 * 5
  );
  onCleanup(() => clearInterval(retryInterval));

  // Return this as "is charging" for feedWhenNoSolar, we say that we're charging if the actual float voltage equals the full battery voltage
  return createMemo(() => {
    if (energyRemovedSinceFull() == undefined || wantVoltagesToBeSetTo() == undefined) return undefined;
    return localStateOfConfiguredVoltageFloat() === config().full_battery_voltage;
  });
}

function decivoltsToWireFormat(decivolts: number) {
  return decivolts.toString().padStart(4, "0");
}

function parseConfirmedVoltage(rawValue: string | undefined, sourceKey: string) {
  if (rawValue == undefined) return undefined;
  const parsed = parseFloat(rawValue);
  if (isNaN(parsed)) {
    errorLog("Could not parse", sourceKey, "from BATS readback as a voltage, got:", rawValue);
    return undefined;
  }
  return parsed;
}

function queueVoltageSyncIfNeeded({
  wantsVoltage,
  confirmedFloat,
  confirmedBulk,
  deparallelizedSetChargeVoltages,
}: {
  wantsVoltage: number | undefined;
  confirmedFloat: number | undefined;
  confirmedBulk: number | undefined;
  deparallelizedSetChargeVoltages: (targetVoltage: number) => void;
}) {
  if (
    !wantsVoltage ||
    confirmedFloat == undefined ||
    confirmedBulk == undefined ||
    (wantsVoltage === confirmedFloat && wantsVoltage === confirmedBulk)
  ) {
    return;
  }
  logLog(
    "Queueing MCHGV to set CV/bulk and float voltage to",
    wantsVoltage,
    ". We think the inverter is configured to float",
    confirmedFloat,
    "V / bulk",
    confirmedBulk,
    "V right now.",
    "Current voltage of battery",
    untrack(reactiveBatteryVoltage),
    "V, current current of battery",
    untrack(reactiveBatteryCurrent),
    "A"
  );
  deparallelizedSetChargeVoltages(wantsVoltage);
}

async function setChargeVoltagesWithThrottling(targetVoltage: number, setCommandQueue: Setter<CommandQueue>) {
  const now = +new Date();
  const setMaxEvery = 60_000;
  const setAgo = now - lastVoltageSetAt;
  if (setAgo < setMaxEvery) {
    const waitFor = setMaxEvery - setAgo;
    logLog("Waiting with setting voltage to", targetVoltage, "for", waitFor, "ms, because it was set very recently");
    await new Promise(resolve => setTimeout(resolve, waitFor));
  }
  queueChargeVoltagesCommand(targetVoltage, setCommandQueue);
  lastVoltageSetAt = +new Date();
}

function queueChargeVoltagesCommand(targetVoltage: number, setCommandQueue: Setter<CommandQueue>) {
  // MCHGV wants 4-digit decivolts (58.0 V → 0580) and mpp-solar's PI17 command regex only accepts
  // 0400–0599, i.e. 40.0–59.9 V — outside that we'd enqueue a command that can never be sent.
  const constantChargeDecivolts = Math.round(targetVoltage * 10);
  const floatChargeDecivolts = constantChargeDecivolts;
  if (constantChargeDecivolts < 400 || constantChargeDecivolts > 599) {
    errorLog(
      "Refusing to set charge voltage to",
      targetVoltage,
      "V — outside the 40.0–59.9 V range MCHGV accepts. Check the voltage values in config.json"
    );
    return;
  }
  // The inverter NAKs any single MCHGV whose float exceeds its CV (verified live 2026-07-18:
  // MCHGV0560,0570 → rejected, settings unchanged). Both values are the same target today, but
  // guard the invariant so a future split of the two can't silently enqueue a doomed command.
  if (floatChargeDecivolts > constantChargeDecivolts) {
    errorLog(
      "Refusing to send MCHGV with float",
      floatChargeDecivolts,
      "decivolts above CV",
      constantChargeDecivolts,
      "decivolts — the inverter rejects that pair"
    );
    return;
  }
  const command =
    `MCHGV${decivoltsToWireFormat(constantChargeDecivolts)},${decivoltsToWireFormat(floatChargeDecivolts)}` as const;
  setCommandQueue(prev => {
    // Replace any not-yet-sent MCHGV so a stale target can't be applied after this newer one
    const newQueue = new Set([...prev].filter(queueItem => !queueItem.command.startsWith("MCHGV")));
    newQueue.add({
      command,
      // Confirm via BATS readback, which feeds localStateOfConfiguredVoltage*. The inverter ACKs
      // immediately but BATS only reflects the new values after ~6 s (verified live), so the
      // immediate refresh may still show the old values — the second refresh 10 s later is the
      // one that actually confirms.
      refreshAfterSend: true,
      onSucceeded: ({ stdout }) => {
        // mpp-solar exits 0 even when the inverter NAKs a setter — rejection only shows up as a
        // "warning0 ... rejected" row in stdout, an accepted write as an "ack ... Successful" row
        if (stdout.includes("rejected") || !stdout.includes("Successful")) {
          errorLog("Inverter did not accept", command, "— full mpp-solar output:", stdout);
          return;
        }
        logLog("Inverter acknowledged", command, "(CV/bulk and float charge voltage →", targetVoltage, "V)");
      },
    });
    return newQueue;
  });
}
