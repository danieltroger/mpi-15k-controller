import {
  Accessor,
  createComputed,
  createMemo,
  createResource,
  createSignal,
  mapArray,
  onCleanup,
  untrack,
} from "solid-js";
import { promises as fs } from "fs";
import { exec } from "./utilities/exec";
import { log, warn } from "./utilities/logging";
import { rand, wait } from "@depict-ai/utilishared/latest";
import { Config } from "./config.types";

export type ThermometerValue = { value: number; time: number; thermometer_device_id: string; label: string };

export function useTemperatures(get_config: Accessor<Config>) {
  const [thermometersEnabled] = createResource(async () => {
    // If already initialised, don't try again as it will throw
    if (!(await hasSensorFolder())) {
      const { stderr, stdout } = await exec("sudo dtoverlay w1-gpio gpiopin=4 pullup=0");
      if (stdout || stderr) {
        log("Enabling thermometers returned", { stdout, stderr });
      }
    }
    // Only start reading thermometers once we have enabled them
    return true;
  });
  const thermometers = createMemo(() => get_config().thermometers);
  const thermometer_ids = createMemo(() =>
    thermometersEnabled() ? (JSON.parse(JSON.stringify(Object.keys(thermometers()))) as string[]) : []
  );

  const thermometer_values = mapArray(thermometer_ids, thermometer_device_id =>
    read_thermometer({
      thermometer_device_id: thermometer_device_id,
      label: createMemo(() => thermometers()[thermometer_device_id]),
    })
  );

  const temperatures = createMemo(() => Object.fromEntries(thermometer_values()));

  return temperatures;
}

function read_thermometer({
  thermometer_device_id,
  label,
}: {
  thermometer_device_id: string;
  label: Accessor<string>;
}) {
  const [get_value, set_value] = createSignal<ThermometerValue>();
  const [get_fails, set_fails] = createSignal(0);

  createResource(async () => {
    let gotCleanedUp = false;

    onCleanup(() => (gotCleanedUp = true));

    log("Starting reading of thermometer", thermometer_device_id, untrack(label));
    while (!gotCleanedUp) {
      const fails = untrack(get_fails);
      if (fails > 0) {
        await wait(rand(1000, 5000));
      } else if (fails > 10) {
        await wait(rand(10_000, 30_000));
      }
      try {
        const value = await get_thermometer_value({ thermometer_device_id, label });
        set_value(value);
        set_fails(0);
      } catch (e) {
        log(`Failed reading thermometer ${thermometer_device_id} (${untrack(label)}):`, e);
        set_fails(prev => prev + 1);
      }
    }
    log("Stopping reading of thermometer", thermometer_device_id, untrack(label));
  });

  createComputed(async () => {
    const fails = get_fails();
    if (fails < 100) return;
    warn(
      `Over 100 fails (${fails}) for thermometer ${thermometer_device_id} (${untrack(
        label
      )}), please implement a way to restart thermometers`
    );
    log("Waiting 60s before resetting, for now");
    await wait(rand(50_000, 80_000));
    log("Resetting thermometer");
    set_fails(0);
  });

  return [thermometer_device_id, get_value] as const;
}

async function get_thermometer_value({
  thermometer_device_id,
  label,
}: {
  thermometer_device_id: string;
  label: Accessor<string>;
}) {
  const handle = await fs.open("/sys/bus/w1/devices/" + thermometer_device_id + "/w1_slave", "r");
  const read_contents = await handle.readFile({
    // example output: '84 01 55 05 7f a5 a5 66 f5 : crc=f5 YES\n84 01 55 05 7f a5 a5 66 f5 t=24250\n'
    encoding: "utf8",
  });
  await handle.close();
  const [line1, line2] = (read_contents || "").split("\n");
  const crc_line = line1?.split("crc=");
  const wanted_part = crc_line?.[crc_line?.length - 1];
  if (wanted_part?.split(" ")?.pop() !== "YES") {
    throw new Error(`CRC didn't match for thermometer ${thermometer_device_id} (${untrack(label)}): ` + read_contents);
  }
  const temperature = +line2?.split("t=")?.pop()! / 1000;
  if (temperature < -30 || temperature > 90 || isNaN(temperature)) {
    throw new Error(
      `Temperature out of range for thermometer ${thermometer_device_id} (${untrack(label)}): ` + temperature + "°C"
    );
  }
  return {
    value: temperature,
    time: +new Date(),
    thermometer_device_id: thermometer_device_id,
    label: untrack(label),
  } as ThermometerValue;
}

/**
 * Asynchronously checks if there's any folder starting with `28-` in `/sys/bus/w1/devices/`.
 * @returns {Promise<boolean>} A promise that resolves to true if such a folder exists, otherwise false.
 */
async function hasSensorFolder(): Promise<boolean> {
  try {
    const dirPath = "/sys/bus/w1/devices/";
    const files = await fs.readdir(dirPath);
    return files.some(file => file.startsWith("28-"));
  } catch (e) {
    return false;
  }
}
