/**
 * Guard (c) of the grid-off switch: a clean stop (systemctl stop/restart sends SIGTERM, a terminal SIGINT)
 * while the inverter may be off the grid sends DM050 first and waits a few seconds for its ACK. Best effort:
 * the inverter commits an ACKed write by itself, and whatever this misses, the next start's fail-safe
 * switches back (useGridOffSwitch.ts). The handlers exist only while grid-off is in force, so every other
 * stop behaves exactly as without them.
 */
import { type Accessor, createEffect, onCleanup, untrack } from "solid-js";
import process from "process";
import type { SetterResult } from "../inverterComms/inverterComms.types.ts";
import type { GridOffConfig } from "../config/config.types.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;
type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export function holdGridOffThroughShutdown({
  inverterMayBeOffGrid,
  settings,
  sendNormalHybrid,
}: {
  /** 151 requested or read back, stuck or not */
  inverterMayBeOffGrid: Accessor<boolean>;
  /** The corrected grid_off knobs */
  settings: Accessor<Pick<GridOffConfig, "shutdown_wait_seconds">>;
  /** Queues DM050 with this result callback */
  sendNormalHybrid: (onResult: (result: SetterResult) => void) => void;
}) {
  const shutdown: ShutdownState = { started: false };
  createEffect(() => {
    if (!inverterMayBeOffGrid()) return;
    const handler = (signal: ShutdownSignal) =>
      switchBackThenExit(signal, untrack(settings).shutdown_wait_seconds, sendNormalHybrid, shutdown);
    for (const signal of SHUTDOWN_SIGNALS) process.on(signal, handler);
    onCleanup(() => {
      for (const signal of SHUTDOWN_SIGNALS) process.off(signal, handler);
    });
  });
}

type ShutdownState = { started: boolean };

function switchBackThenExit(
  signal: ShutdownSignal,
  shutdown_wait_seconds: number,
  sendNormalHybrid: (onResult: (result: SetterResult) => void) => void,
  shutdown: ShutdownState
): void {
  if (shutdown.started) {
    warnLog(`Grid off: a second ${signal} during the shutdown switch-back — exiting now`);
    process.exit(1);
  }
  shutdown.started = true;
  warnLog(
    `Grid off: ${signal} while grid-off is in force — queueing DM050 and waiting up to ${shutdown_wait_seconds} s for its ACK before exiting`
  );
  const acknowledgement = new Promise<SetterResult>(resolve => sendNormalHybrid(resolve));
  const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), shutdown_wait_seconds * 1000));
  Promise.race([acknowledgement, timeout])
    .then(outcome => {
      if (outcome === undefined) {
        // Also what a DM050 the session dropped unsent looks like (the readback already showed 050)
        warnLog(
          `Grid off: no answer to DM050 within ${shutdown_wait_seconds} s of ${signal} — exiting anyway; the next start switches back if the inverter still reads 151`
        );
      } else if (outcome.acknowledged) {
        logLog(`Grid off: DM050 ACKed after ${signal} — the inverter commits it by itself; exiting`);
      } else {
        errorLog(`Grid off: DM050 REJECTED (NAK) after ${signal} — exiting anyway; the next start retries`);
      }
    })
    .catch(error => errorLog("Grid off: the shutdown switch-back failed", error))
    .finally(() => process.exit(0));
}
