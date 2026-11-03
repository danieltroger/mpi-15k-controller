/**
 * Pure PI17 protocol types — no runtime imports (no Node built-ins) so they can be imported
 * type-only from anywhere, including potential frontend code.
 */

/** Query commands the backend has decode tables for (HFS takes a slot argument on the wire: HFS03). */
export type Pi17QueryCommandName = "GS" | "PS" | "GPMP" | "HECS" | "BATS" | "DM" | "MOD" | "CFS" | "WS" | "HFS";

/** The slow-cadence settings queries — also used as targeted post-write confirm queries. */
export type SettingsQueryCommandName = "GPMP" | "HECS" | "BATS" | "DM";

/**
 * The machine models (PI17 DM, the spec's "machine model": the grid code plus the operation mode)
 * this backend may ever write: "050" Hybrid type VDE certification is what the inverter runs on
 * (its cloud log, 2026-10), "151" "Off Grid 3 type" is the manual's Off-Grid III, the one mode
 * whose grid relay stays open on battery. Every other code is refused (machineModel.ts).
 */
export type MachineModelCode = "050" | "151";

/** How one comma-separated token in a PI17 data response decodes. */
export type Pi17FieldReading =
  /** Plain integer on the wire, divided down (the docs' `int:r/10` etc.) */
  | { kind: "int"; divisor: 1 | 10 | 100 }
  | { kind: "string" }
  /** The token is an index into `options` */
  | { kind: "option"; options: readonly string[] }
  /** The token is a key into `mapping` */
  | { kind: "str_keyed"; mapping: Readonly<Record<string, string>> }
  /** Token exists on the wire but is dropped from the output (mpp-solar's "exclude") */
  | { kind: "exclude" };

export type Pi17FieldSpec = {
  /** Human-readable name from the PI17 docs / mpp-solar; the store/influx name derives via influxFieldName() */
  name: string;
  reading: Pi17FieldReading;
  unit: string;
};

export type DecodedFieldValue = number | string;

/** Decoded response fields keyed by their mpp-solar/influx name (lowercased, spaces → underscores). */
export type DecodedFields = Record<string, DecodedFieldValue>;

/** One decoded query response, as delivered to the reactive stores and the MQTT publisher. */
export type DecodedRound = {
  command: Pi17QueryCommandName;
  /** The query as it went on the wire: the same as `command` except for arguments (HFS03) */
  wireCommand: string;
  fields: DecodedFields;
  /** Date.now() when the response frame was decoded — becomes the per-field `time` in the store */
  decodedAt: number;
};
