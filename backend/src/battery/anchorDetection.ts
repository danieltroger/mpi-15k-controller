import { type Accessor, createEffect, createSignal, untrack } from "solid-js";
import type { AsyncMqttClient } from "async-mqtt";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import { reactiveBatteryVoltage, reactiveBatteryVoltageTime } from "../mqttValues/mqttHelpers.ts";
import { fullConditionMet, emptyConditionMet } from "./anchorConditions.ts";
import { warnLog } from "../utilities/logging.ts";
import { SOC_ANCHORS_MEASUREMENT, type AnchorType } from "./ahLedgerMath.ts";
import type { Config } from "../config/config.types.ts";

/**
 * Edge-detects the three anchor kinds from live voltage + 1-min-smoothed hall amps and latches the
 * time of each most-recent event (one per event, not once per sample — so the Ah ledger re-anchors and
 * re-queries the DB integral only when something actually happened). Every detection also drops a
 * marker into the `soc_anchors` measurement so a later restart can restore the anchor directly.
 *
 * Re-arm hysteresis keeps a pack hovering at a threshold from chattering: full re-arms below
 * full − 0.5 V, empty above empty + 0.5 V, soft-empty above its voltage + 0.5 V (the last per spec).
 * On the first reading we only arm the conditions we are clearly NOT already in, so a restart while
 * sitting at float/full doesn't emit a spurious marker (the DB restore covers the current state).
 */
export function anchorDetection({
  config,
  smoothedBatteryCurrentAmps,
}: {
  config: Accessor<Config>;
  smoothedBatteryCurrentAmps: Accessor<number | undefined>;
}) {
  const { mqttClient } = useFromMqttProvider();
  const [lastFullEventAt, setLastFullEventAt] = createSignal<number | undefined>(undefined);
  const [lastEmptyEventAt, setLastEmptyEventAt] = createSignal<number | undefined>(undefined);
  const [lastSoftEmptyEventAt, setLastSoftEmptyEventAt] = createSignal<number | undefined>(undefined);

  let primed = false;
  let armedFull = false;
  let armedEmpty = false;
  let armedSoftEmpty = false;
  let previousVoltage: number | undefined;

  createEffect(() => {
    const voltage = reactiveBatteryVoltage();
    const eventTime = reactiveBatteryVoltageTime();
    const smoothedAmps = smoothedBatteryCurrentAmps();
    if (voltage == undefined || eventTime == undefined) return;

    const fullBatteryVoltage = config().full_battery_voltage;
    const stopChargingBelowCurrent = config().stop_charging_below_current;
    const batteryEmptyAt = config().soc_calculations.battery_empty_at;
    const softEmpty = config().soc_calculations.ah_ledger.soft_empty;

    if (!primed) {
      primed = true;
      previousVoltage = voltage;
      // Arm only where we're clearly outside the condition, so booting mid-full/at-rest stays quiet.
      armedFull = voltage < fullBatteryVoltage - 0.5;
      armedEmpty = voltage > batteryEmptyAt + 0.5;
      armedSoftEmpty = voltage > softEmpty.voltage + 0.5;
      return;
    }

    // Full — level condition, needs the smoothed current. Re-arm is current-independent.
    if (armedFull) {
      if (
        smoothedAmps != undefined &&
        fullConditionMet(voltage, smoothedAmps, fullBatteryVoltage, stopChargingBelowCurrent)
      ) {
        armedFull = false;
        setLastFullEventAt(eventTime);
        publishAnchorMarker(untrack(mqttClient), "full");
      }
    } else if (voltage < fullBatteryVoltage - 0.5) {
      armedFull = true;
    }

    // Empty — level condition on voltage only (hall current not required, unchanged from the Wh path).
    if (armedEmpty) {
      if (emptyConditionMet(voltage, batteryEmptyAt)) {
        armedEmpty = false;
        setLastEmptyEventAt(eventTime);
        publishAnchorMarker(untrack(mqttClient), "empty");
      }
    } else if (voltage > batteryEmptyAt + 0.5) {
      armedEmpty = true;
    }

    // Soft-empty — a downward voltage crossing while nearly at rest.
    if (armedSoftEmpty) {
      const crossedDown =
        previousVoltage != undefined && previousVoltage > softEmpty.voltage && voltage <= softEmpty.voltage;
      if (crossedDown && smoothedAmps != undefined && Math.abs(smoothedAmps) < softEmpty.max_abs_amps) {
        armedSoftEmpty = false;
        setLastSoftEmptyEventAt(eventTime);
        publishAnchorMarker(untrack(mqttClient), "soft_empty");
      }
    } else if (voltage > softEmpty.voltage + 0.5) {
      armedSoftEmpty = true;
    }

    previousVoltage = voltage;
  });

  return { lastFullEventAt, lastEmptyEventAt, lastSoftEmptyEventAt };
}

function publishAnchorMarker(client: AsyncMqttClient | undefined, type: AnchorType) {
  if (!client || !client.connected) {
    warnLog("MQTT not connected — soc_anchors marker lost; restore will fall back to the voltage queries", type);
    return;
  }
  // Line protocol with a tag so Grafana can split by kind; markers are rare, so a failure is worth a log.
  const line = `${SOC_ANCHORS_MEASUREMENT},type=${type} value=1`;
  client
    .publish(SOC_ANCHORS_MEASUREMENT, line)
    .catch(error => warnLog("Failed to publish soc_anchors marker", type, error));
}
