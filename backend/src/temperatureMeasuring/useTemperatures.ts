import {
  type Accessor,
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  mapArray,
  type Setter,
  untrack,
} from "solid-js";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import type { Config } from "../config/config.types.ts";
import type { TemperatureReadingBroadcast } from "../sharedTypes.ts";
import { enableOneWireBus, ONE_WIRE_DEVICES_DIRECTORY } from "./oneWireBus.ts";
import { nodeSysfsAccess } from "./sysfsAccess.ts";
import {
  createThermometerSweepState,
  DEFAULT_THERMOMETER_SWEEP_TIMING,
  type SweepLogger,
  sweepThermometers,
  type ThermometerProbe,
} from "./thermometerSweep.ts";
import { startThermometerSweepLoop, SYSTEM_SWEEP_CLOCK } from "./thermometerSweepLoop.ts";

type ProbeSignal = {
  thermometerDeviceId: string;
  reading: Accessor<TemperatureReadingBroadcast | undefined>;
  setReading: Setter<TemperatureReadingBroadcast | undefined>;
};

const SWEEP_LOGGER: SweepLogger = { log: logLog, warn: warnLog, error: errorLog };

/**
 * Every configured thermometer's latest accepted reading, keyed by device id, swept over the 1-wire bus every
 * temperature_saving.thermometer_sweep_interval_seconds (thermometerSweepLoop.ts).
 */
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
    const sweepState = createThermometerSweepState();
    startThermometerSweepLoop({
      getConfig,
      sweep: () =>
        sweepThermometers({
          probes: untrack(() => probesToSweep(probeSignals(), thermometers())),
          state: sweepState,
          sysfs: nodeSysfsAccess,
          logger: SWEEP_LOGGER,
          devicesDirectory: ONE_WIRE_DEVICES_DIRECTORY,
          timing: DEFAULT_THERMOMETER_SWEEP_TIMING,
        }),
      publish: sweep => publishReadings(untrack(probeSignals), sweep.readings),
      clock: SYSTEM_SWEEP_CLOCK,
      logger: SWEEP_LOGGER,
    });
  });

  return temperatures;
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
