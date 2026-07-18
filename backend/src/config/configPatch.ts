import type { Config } from "./config.types.ts";
import type { ConfigPatch } from "../wsContract.types.ts";

/**
 * Path-scoped config writes: applies exactly the named key-path, immutably, onto `current`.
 * This is THE config write validation — wsMessaging routes every ws patch through here, and the
 * frontend imports it (pure module, type-only imports) to preview the post-save config locally.
 * Values are not schema-checked beyond primitive-type preservation (same trust level as the old
 * whole-object write); the path rules below are what protect concurrent backend-owned state.
 */
export function applyConfigPatch(current: Config, patch: ConfigPatch): ConfigPatchResult {
  const { path, op, value } = patch;
  const shownPath = describePath(path);

  if (!Array.isArray(path) || path.length === 0 || path.some(segment => typeof segment !== "string" || !segment)) {
    return { error: `Patch path must be a non-empty array of non-empty strings, got: ${shownPath}` };
  }
  if (path.some(segment => FORBIDDEN_SEGMENTS.has(segment))) {
    return { error: `Patch path ${shownPath} contains a forbidden segment` };
  }
  if (!(path[0] in TOP_LEVEL_CONFIG_KEYS)) {
    return {
      error: `Patch path ${shownPath} does not start with a known config key. Known keys: ${Object.keys(TOP_LEVEL_CONFIG_KEYS).join(", ")}`,
    };
  }
  const machineOwned = MACHINE_OWNED_PATHS.find(owned => pathsOverlap(path, owned));
  if (machineOwned) {
    return {
      error:
        `Refusing to patch ${shownPath}: ${describePath(machineOwned)} is machine-owned (written only by the ` +
        `Ah ledger's online parameter tracking). To seed it manually, stop the service and edit config.json.`,
    };
  }

  if (op === "set") {
    if (value === undefined) {
      return { error: `Patch of ${shownPath} has op "set" but no value — use op "unset" to remove a key` };
    }
    if (value === null) {
      return { error: `Refusing to set ${shownPath} to null — no config value is null; use op "unset" to remove` };
    }
    return setAtPath(current, path, value);
  }
  if (op === "unset") {
    if (value !== undefined) {
      return { error: `Patch of ${shownPath} has op "unset" and a value — an unset takes no value` };
    }
    if (!UNSETTABLE_PATH_PATTERNS.some(pattern => pathMatchesPattern(path, pattern))) {
      return {
        error: `Refusing to unset ${shownPath}: only schedule entries, thermometers and optional keys are removable — set a value instead`,
      };
    }
    return unsetAtPath(current, path);
  }
  return { error: `Unknown patch op "${op}" for ${shownPath} — allowed: "set", "unset"` };
}

/** Applies patches left to right; stops at (and reports) the first invalid one. */
export function applyConfigPatches(current: Config, patches: readonly ConfigPatch[]): ConfigPatchResult {
  let config = current;
  for (const patch of patches) {
    const result = applyConfigPatch(config, patch);
    if ("error" in result) return result;
    config = result.patched;
  }
  return { patched: config };
}

export type ConfigPatchResult = { patched: Config } | { error: string };

/** Whether `unset` may remove this path — the config editor uses it to decide if clearing a text
 * field means "remove the key" (optional) or "set empty string" (required). */
export function pathIsUnsettable(path: readonly string[]): boolean {
  return UNSETTABLE_PATH_PATTERNS.some(pattern => pathMatchesPattern(path, pattern));
}

/**
 * Every top-level Config key, as a runtime object so patch paths can be validated on the wire.
 * `satisfies Record<keyof Config, true>` makes forgetting a newly added key a compile error.
 */
const TOP_LEVEL_CONFIG_KEYS = {
  automatic_trading: true,
  alerting: true,
  usb_parameter_setting: true,
  current_measuring: true,
  scheduled_power_selling: true,
  scheduled_power_buying: true,
  influxdb: true,
  soc_calculations: true,
  elpatron_switching: true,
  stop_charging_below_current: true,
  full_battery_voltage: true,
  float_charging_voltage: true,
  start_bulk_charge_voltage: true,
  temperature_report_interval: true,
  thermometers: true,
  mqtt_host: true,
  temperature_saving: true,
  feed_from_battery_when_no_solar: true,
  start_bulk_charge_after_wh_discharged: true,
  shinemonitor_password: true,
  shinemonitor_user: true,
  shinemonitor_company_key: true,
  inverter_sn: true,
  inverter_pn: true,
  savedAuth_do_not_edit: true,
} satisfies Record<keyof Config, true>;

/**
 * Written only by the Ah ledger's online parameter tracking — a client write would silently fight
 * it (the 2026-07-16 drain_a revert incident). Overlap is checked in both directions so neither a
 * parent-object write nor a deeper write can smuggle these in.
 */
const MACHINE_OWNED_PATHS: readonly (readonly string[])[] = [
  ["soc_calculations", "ah_ledger", "drain_a"],
  ["soc_calculations", "ah_ledger", "capacity_ah"],
];

/**
 * The only paths `unset` may remove: keys that legitimately come and go. Everything else must
 * always exist — consumers do raw arithmetic on config values, and mergeWithDefaults only heals
 * missing keys in the deep-merged sections, so a stray unset elsewhere would NaN a controller.
 * "*" matches exactly one path segment (a schedule's ISO start key, a thermometer id).
 */
const UNSETTABLE_PATH_PATTERNS: readonly (readonly string[])[] = [
  ["scheduled_power_selling", "schedule", "*"],
  ["scheduled_power_buying", "schedule", "*"],
  ["thermometers", "*"],
  ["elpatron_switching", "mode"],
  ["influxdb"],
  ["shinemonitor_password"],
  ["shinemonitor_user"],
  ["inverter_sn"],
  ["inverter_pn"],
  ["savedAuth_do_not_edit"],
];

/** Assigning these via bracket notation mutates the prototype chain instead of the object. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function describePath(path: readonly string[]): string {
  return Array.isArray(path) ? JSON.stringify(path) : String(path);
}

/** True when one path is a prefix of the other (equal counts as overlap). */
function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const shorter = Math.min(a.length, b.length);
  for (let i = 0; i < shorter; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function pathMatchesPattern(path: readonly string[], pattern: readonly string[]): boolean {
  if (path.length !== pattern.length) return false;
  return pattern.every((segment, i) => segment === "*" || segment === path[i]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setAtPath(current: Config, path: readonly string[], value: unknown): ConfigPatchResult {
  const patched = cloneAndSet(current as unknown as Record<string, unknown>, path, 0, value);
  return typeof patched === "string" ? { error: patched } : { patched: patched as unknown as Config };
}

/** Immutable set: clones only the nodes along the path; missing intermediates are created. */
function cloneAndSet(
  node: Record<string, unknown>,
  path: readonly string[],
  depth: number,
  value: unknown
): Record<string, unknown> | string {
  const key = path[depth];
  if (depth === path.length - 1) {
    const existing = node[key];
    // Type-preservation: a "6000" landing where a number lives would silently NaN arithmetic.
    // Only enforced when the key already exists — new optional keys/entries have no precedent.
    if (
      existing !== undefined &&
      (typeof existing !== typeof value || isPlainObject(existing) !== isPlainObject(value))
    ) {
      return `Type mismatch at ${describePath(path)}: config has ${typeofForMessage(existing)}, patch value is ${typeofForMessage(value)}`;
    }
    return { ...node, [key]: value };
  }
  const child = node[key] ?? {};
  if (!isPlainObject(child)) {
    return `Cannot descend into ${describePath(path.slice(0, depth + 1))}: it is ${typeofForMessage(child)}, not an object`;
  }
  const patchedChild = cloneAndSet(child, path, depth + 1, value);
  if (typeof patchedChild === "string") return patchedChild;
  return { ...node, [key]: patchedChild };
}

function unsetAtPath(current: Config, path: readonly string[]): ConfigPatchResult {
  const patched = cloneAndUnset(current as unknown as Record<string, unknown>, path, 0);
  return typeof patched === "string" ? { error: patched } : { patched: patched as unknown as Config };
}

/** Immutable delete with "ensure absent" semantics: if the leaf (or any ancestor) is already
 * missing the unset is an idempotent no-op success — re-sending a delete must not fail. */
function cloneAndUnset(
  node: Record<string, unknown>,
  path: readonly string[],
  depth: number
): Record<string, unknown> | string {
  const key = path[depth];
  if (depth === path.length - 1) {
    if (!(key in node)) return node;
    const copy = { ...node };
    delete copy[key];
    return copy;
  }
  const child = node[key];
  if (child === undefined) return node; // nothing to remove anywhere below
  if (!isPlainObject(child)) {
    return `Cannot descend into ${describePath(path.slice(0, depth + 1))}: it is ${typeofForMessage(child)}, not an object`;
  }
  const patchedChild = cloneAndUnset(child, path, depth + 1);
  if (typeof patchedChild === "string") return patchedChild;
  return { ...node, [key]: patchedChild };
}

function typeofForMessage(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}
