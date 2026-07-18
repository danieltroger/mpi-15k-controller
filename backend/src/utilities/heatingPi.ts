/**
 * Client for the heating pi (github.com/danieltroger/heating): a ws server on :9321 that owns the
 * boiler-room GPIOs, among them the water heater element ("elpatron"). Shared by the solar-based
 * element switching and the auto-trader's elpatron load forecast so both use one connection.
 */

import { WebSocket } from "ws";
import { DepictAPIWS, random_string } from "../vendor/depictUtilishared.ts";
import { warnLog } from "./logging.ts";

// DepictAPIWS expects a browser-style global WebSocket
// @ts-ignore
globalThis.WebSocket = WebSocket;

const sockets = new Map<string, DepictAPIWS>();

export function getHeatingPiSocket(heatingPiIp: string): DepictAPIWS {
  let socket = sockets.get(heatingPiIp);
  if (!socket) {
    socket = new DepictAPIWS(`ws://${heatingPiIp}:9321`);
    sockets.set(heatingPiIp, socket);
  }
  return socket;
}

/** Both pins are active-low (raw 0 = powered); undefined = the output was missing in the reply */
export type HeatingGpioSnapshot = { elementOn: boolean | undefined; stoveOn: boolean | undefined };

let gpioReadCache: { heatingPiIp: string; atMs: number; value: HeatingGpioSnapshot | undefined } | undefined;

/**
 * Current heating-pi output states: the water heater element and the pellet stove (the latter
 * tells the consumption model whether the element can be assumed to be the tank's only heat
 * source). Returns undefined when the heating pi doesn't answer in time — ensure_sent retries
 * forever, and a plan run must not hang on an unreachable pi in another building. Results
 * (including failures) are cached (default 10 minutes) so the guard's 15-min ticks don't hammer
 * or stall on the pi; the frontend's live state poll passes a shorter maxAge.
 */
export async function readHeatingGpio(
  heatingPiIp: string,
  maxAgeMs = 10 * 60_000
): Promise<HeatingGpioSnapshot | undefined> {
  if (gpioReadCache && gpioReadCache.heatingPiIp === heatingPiIp && Date.now() - gpioReadCache.atMs < maxAgeMs) {
    return gpioReadCache.value;
  }
  const value = await readHeatingGpioUncached(heatingPiIp);
  gpioReadCache = { heatingPiIp, atMs: Date.now(), value };
  return value;
}

/** Whether the element GPIO is currently on. See readHeatingGpio for semantics and caching. */
export async function readElpatronGpioIsOn(heatingPiIp: string, maxAgeMs = 10 * 60_000): Promise<boolean | undefined> {
  return (await readHeatingGpio(heatingPiIp, maxAgeMs))?.elementOn;
}

/**
 * After we wrote the element GPIO ourselves the element state is known — spare the next reader a
 * roundtrip. Only updates the element within the cache's existing freshness window: the carried
 * stove state was NOT just observed, so a write must not extend the snapshot's age (else frequent
 * element flips could postpone a real stove read indefinitely).
 */
export function primeElpatronGpioCache(heatingPiIp: string, isOn: boolean) {
  const previous = gpioReadCache?.heatingPiIp === heatingPiIp ? gpioReadCache : undefined;
  gpioReadCache = {
    heatingPiIp,
    atMs: previous?.atMs ?? 0,
    value: { elementOn: isOn, stoveOn: previous?.value?.stoveOn },
  };
}

/**
 * A {type:"change", key:"gpio"} broadcast from the heating pi carries the fresh state of ALL
 * outputs — cache the full snapshot as just-observed.
 */
export function primeHeatingGpioFromBroadcast(heatingPiIp: string, outputs: Record<string, number>) {
  if (outputs.electric_heating_element === undefined) return;
  gpioReadCache = {
    heatingPiIp,
    atMs: Date.now(),
    value: {
      elementOn: outputs.electric_heating_element === 0,
      stoveOn: outputs.stove === undefined ? undefined : outputs.stove === 0,
    },
  };
}

async function readHeatingGpioUncached(heatingPiIp: string): Promise<HeatingGpioSnapshot | undefined> {
  const socket = getHeatingPiSocket(heatingPiIp);
  const request = socket.ensure_sent({ id: random_string(), command: "read", key: "gpio" }) as Promise<
    [{ status: string; value?: { outputs?: Record<string, number> } }, unknown]
  >;
  const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 5000));
  const result = await Promise.race([request.then(([response]) => response), timeout]);
  if (!result || result.status !== "ok") {
    warnLog("Heating pi: gpio read failed or timed out", heatingPiIp, result);
    return undefined;
  }
  const outputs = result.value?.outputs;
  if (outputs?.electric_heating_element === undefined) {
    warnLog("Heating pi: gpio response has no electric_heating_element output", result.value);
    return undefined;
  }
  return {
    elementOn: outputs.electric_heating_element === 0,
    stoveOn: outputs.stove === undefined ? undefined : outputs.stove === 0,
  };
}
