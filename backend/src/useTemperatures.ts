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
import { Config } from "./config";
import { promises as fs } from "fs";
import { exec } from "./utilities/exec";
import { log, warn } from "./utilities/logging";
import { wait } from "@depict-ai/utilishared/latest";

export type ThermometerValue = { value: number; time: number; thermometer_device_id: string; label: string };

export function useTemperatures(get_config: Accessor<Config>) {
  exec("sudo dtoverlay w1-gpio gpiopin=4 pullup=0").then(({ stdout, stderr }) => {
    if (stdout || stderr) {
      log("Enabling thermometers returned", { stdout, stderr });
    }
  });
  const thermometers = createMemo(() => get_config().thermometers);
  const thermometer_ids = createMemo(() => Object.keys(thermometers()));

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
        await wait(1000);
      } else if (fails > 10) {
        await wait(5000);
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
    await wait(60_000);
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
  await handle.close();
  return {
    value: temperature,
    time: +new Date(),
    thermometer_device_id: thermometer_device_id,
    label: untrack(label),
  } as ThermometerValue;
}
