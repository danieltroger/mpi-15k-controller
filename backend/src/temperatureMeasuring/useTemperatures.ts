import {
  type Accessor,
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  mapArray,
  onCleanup,
  type Setter,
  untrack,
} from "solid-js";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import { wait } from "../vendor/depictUtilishared.ts";
import type { Config } from "../config/config.types.ts";
import type { TemperatureReadingBroadcast } from "../sharedTypes.ts";
import { enableOneWireBus, ONE_WIRE_DEVICES_DIRECTORY } from "./oneWireBus.ts";
import { nodeSysfsAccess } from "./sysfsAccess.ts";
import {
  createThermometerSweepState,
  DEFAULT_THERMOMETER_SWEEP_TIMING,
  sweepThermometers,
  type ThermometerProbe,
} from "./thermometerSweep.ts";

/**
 * A sweep starts every 10 s. A bulk sweep takes ~1 s: the trigger write blocks for the 750 ms conversion,
 * then 14 scratchpad reads take ~15 ms each. The w1_slave fallback takes ~11 s, so its sweeps run back to back.
 * 10 s keeps each probe on about the cadence it had when every read ran its own conversion (one probe every
 * ~0.8 s, so each probe every ~11 s). MQTT/Influx volume, Grafana and the stale-temperature alert see the same
 * rhythm as before, only now all 14 values land together.
 */
const SWEEP_INTERVAL_MS = 10_000;

type ProbeSignal = {
  thermometerDeviceId: string;
  reading: Accessor<TemperatureReadingBroadcast | undefined>;
  setReading: Setter<TemperatureReadingBroadcast | undefined>;
};

/** Every configured thermometer's latest accepted reading, keyed by device id, swept over the 1-wire bus. */
export function useTemperatures(getConfig: Accessor<Config>) {
  const [busEnabled] = createResource(async () => {
    await enableOneWireBus(Object.keys(untrack(getConfig).thermometers));
    return true;
  });
  const thermometers = createMemo(() => getConfig().thermometers);
  const thermometerIds = createMemo(() => (busEnabled() ? Object.keys(thermometers()) : []));
  const probeSignals = createMemo(
    mapArray(thermometerIds, (thermometerDeviceId): ProbeSignal => {
      const [reading, setReading] = createSignal<TemperatureReadingBroadcast>();
      return { thermometerDeviceId, reading, setReading };
    })
  );
  const temperatures = createMemo(() =>
    Object.fromEntries(probeSignals().map(probe => [probe.thermometerDeviceId, probe.reading] as const))
  );

  createEffect(() => {
    if (!busEnabled()) return;
    const loopControl = { stopped: false };
    onCleanup(() => (loopControl.stopped = true));
    void runSweepLoop({ loopControl, probeSignals, thermometers });
  });

  return temperatures;
}

async function runSweepLoop({
  loopControl,
  probeSignals,
  thermometers,
}: {
  loopControl: { stopped: boolean };
  probeSignals: Accessor<ProbeSignal[]>;
  thermometers: Accessor<Config["thermometers"]>;
}) {
  const sweepState = createThermometerSweepState();
  logLog("Starting thermometer sweeps every", SWEEP_INTERVAL_MS / 1000, "s");
  while (!loopControl.stopped) {
    const sweepStartedAtMs = Date.now();
    try {
      const sweep = await sweepThermometers({
        probes: untrack(() => probesToSweep(probeSignals(), thermometers())),
        state: sweepState,
        sysfs: nodeSysfsAccess,
        logger: { log: logLog, warn: warnLog },
        devicesDirectory: ONE_WIRE_DEVICES_DIRECTORY,
        timing: DEFAULT_THERMOMETER_SWEEP_TIMING,
      });
      if (!loopControl.stopped) publishReadings(untrack(probeSignals), sweep.readings);
    } catch (error) {
      errorLog("Thermometer sweep threw although it handles sysfs failures itself, retrying next interval", error);
    }
    await wait(Math.max(0, SWEEP_INTERVAL_MS - (Date.now() - sweepStartedAtMs)));
  }
  logLog("Stopped thermometer sweeps");
}

function probesToSweep(probeSignals: ProbeSignal[], thermometers: Config["thermometers"]): ThermometerProbe[] {
  return probeSignals.map(probe => ({
    thermometer_device_id: probe.thermometerDeviceId,
    label: thermometers[probe.thermometerDeviceId],
  }));
}

function publishReadings(probeSignals: ProbeSignal[], readings: TemperatureReadingBroadcast[]) {
  const setterByDeviceId = new Map(probeSignals.map(probe => [probe.thermometerDeviceId, probe.setReading]));
  // One batch per sweep, so the ws broadcast and the alert memos recompute once rather than once per probe.
  // A probe removed from the config during the sweep has no setter any more, and its reading is dropped.
  batch(() => {
    for (const reading of readings) setterByDeviceId.get(reading.thermometer_device_id)?.(reading);
  });
}
