/**
 * The session's periodic "Inverter serial stats" line: counter deltas since the previous line plus
 * the poll cadence. The anomaly warns are rate-limited, so this is where "how many frames were
 * rejected / rounds dropped / writes confirmed or never applied, and how fast are rounds" is
 * answered.
 */
import { logLog } from "../utilities/logging.ts";
import type { SerialExchangeCounters } from "./serialExchange.ts";

export const STATS_LOG_INTERVAL_MS = 5 * 60_000;

export type InverterSessionCounters = SerialExchangeCounters & {
  droppedImplausibleRounds: number;
  pollRoundsCompleted: number;
  /** ACKed setters by verdict: the readback showed them applied / the confirm gave up */
  writesConfirmed: number;
  writesNeverApplied: number;
};

export function logSessionStats(current: InverterSessionCounters, previous: InverterSessionCounters): void {
  const deltas = counterDeltas(current, previous);
  const intervalMinutes = STATS_LOG_INTERVAL_MS / 60_000;
  logLog(
    `Inverter serial stats, last ${intervalMinutes} min:`,
    JSON.stringify(deltas),
    `(${(deltas.pollRoundsCompleted / intervalMinutes).toFixed(1)} poll rounds/min)`
  );
}

function counterDeltas(current: InverterSessionCounters, previous: InverterSessionCounters): InverterSessionCounters {
  const deltas = { ...current };
  for (const key of Object.keys(current) as (keyof InverterSessionCounters)[]) {
    deltas[key] = current[key] - previous[key];
  }
  return deltas;
}
