/**
 * Pure PI17 protocol types — no runtime imports (no Node built-ins) so they can be imported
 * type-only from anywhere, including potential frontend code.
 */

/** Query commands the backend has decode tables for. */
export type Pi17QueryCommandName = "GS" | "PS" | "GPMP" | "HECS" | "BATS" | "MOD";

/** The slow-cadence settings queries — also used as targeted post-write confirm queries. */
export type SettingsQueryCommandName = "GPMP" | "HECS" | "BATS";

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
  fields: DecodedFields;
  /** Date.now() when the response frame was decoded — becomes the per-field `time` in the store */
  decodedAt: number;
};
