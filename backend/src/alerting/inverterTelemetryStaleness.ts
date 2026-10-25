/**
 * Per-command freshness of the inverter telemetry store — pure. The "Inverter data stale" rule used
 * to take the newest time across GS *and* PS fields, so a command whose rounds all fail the
 * plausibility gate (or simply stop decoding) stayed invisible as long as the other kept arriving.
 * Now the stalest command decides.
 */
import { influxFieldName, PI17_QUERY_RESPONSE_FIELDS } from "../inverterComms/pi17FieldTables.ts";

export const TELEMETRY_COMMANDS = ["GS", "PS"] as const;
export type TelemetryCommand = (typeof TELEMETRY_COMMANDS)[number];

const FIELD_NAMES_BY_COMMAND: Readonly<Record<TelemetryCommand, readonly string[]>> = {
  GS: PI17_QUERY_RESPONSE_FIELDS.GS.map(spec => influxFieldName(spec.name)),
  PS: PI17_QUERY_RESPONSE_FIELDS.PS.map(spec => influxFieldName(spec.name)),
};

export type TimedTelemetry = Readonly<Partial<Record<string, { time: number } | undefined>>>;

export type TelemetryStaleness = {
  /** The command that has been silent longest */
  stalest: TelemetryCommand;
  silentForMs: number;
  /** How long each command has been silent (a never-seen command counts from boot) */
  silentForMsByCommand: Readonly<Record<TelemetryCommand, number>>;
};

/** Undefined while nothing at all has arrived yet (boot) — no verdict, like the old rule. */
export function inverterTelemetryStaleness(
  values: TimedTelemetry,
  nowMs: number,
  bootedAtMs: number
): TelemetryStaleness | undefined {
  const newestGs = newestTimeOf(values, "GS");
  const newestPs = newestTimeOf(values, "PS");
  if (newestGs === 0 && newestPs === 0) return undefined;
  const silentForMsByCommand: Record<TelemetryCommand, number> = {
    GS: nowMs - (newestGs || bootedAtMs),
    PS: nowMs - (newestPs || bootedAtMs),
  };
  const stalest = TELEMETRY_COMMANDS.reduce((worst, command) =>
    silentForMsByCommand[command] > silentForMsByCommand[worst] ? command : worst
  );
  return { stalest, silentForMs: silentForMsByCommand[stalest], silentForMsByCommand };
}

function newestTimeOf(values: TimedTelemetry, command: TelemetryCommand): number {
  return Math.max(0, ...FIELD_NAMES_BY_COMMAND[command].map(name => values[name]?.time ?? 0));
}

/** Alert text: names the silent command, and says so when the other one is still fresh. */
export function describeTelemetryStaleness(staleness: TelemetryStaleness, freshWithinMs: number): string {
  const minutes = Math.round(staleness.silentForMs / 60_000);
  const freshCommands = TELEMETRY_COMMANDS.filter(
    command => command !== staleness.stalest && staleness.silentForMsByCommand[command] < freshWithinMs
  );
  if (freshCommands.length) {
    return (
      `No ${staleness.stalest} inverter values for ${minutes} min while ${freshCommands.join("/")} keeps arriving ` +
      `— ${staleness.stalest} rounds rejected (plausibility gate?)`
    );
  }
  return `No inverter value updates for ${minutes} min — serial session dead?`;
}
