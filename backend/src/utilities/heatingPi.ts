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

let gpioReadCache: { heatingPiIp: string; atMs: number; value: boolean | undefined } | undefined;

/**
 * Whether the element GPIO is currently on (the pin is active-low: raw 0 = element powered).
 * Returns undefined when the heating pi doesn't answer in time — ensure_sent retries forever, and
 * a plan run must not hang on an unreachable pi in another building. Results (including failures)
 * are cached for 10 minutes so the guard's 15-min ticks don't hammer or stall on the pi.
 */
export async function readElpatronGpioIsOn(heatingPiIp: string): Promise<boolean | undefined> {
  if (gpioReadCache && gpioReadCache.heatingPiIp === heatingPiIp && Date.now() - gpioReadCache.atMs < 10 * 60_000) {
    return gpioReadCache.value;
  }
  const value = await readElpatronGpioUncached(heatingPiIp);
  gpioReadCache = { heatingPiIp, atMs: Date.now(), value };
  return value;
}

async function readElpatronGpioUncached(heatingPiIp: string): Promise<boolean | undefined> {
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
  const rawState = result.value?.outputs?.electric_heating_element;
  if (rawState === undefined) {
    warnLog("Heating pi: gpio response has no electric_heating_element output", result.value);
    return undefined;
  }
  return rawState === 0;
}
