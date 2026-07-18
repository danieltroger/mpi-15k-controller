import type { Config } from "../../../backend/src/config/config.types";
import type { ConfigPatch } from "../../../backend/src/wsContract.types";

type Defined<T> = Exclude<T, undefined>;

/**
 * Typed constructor for a "set" patch: the value type is derived from the path tuple, so a typo'd
 * path or a wrongly typed value fails to compile. Overloads cover Config's nesting depth (≤ 4);
 * Record sections (schedules, thermometers) accept any string at their key segment.
 */
export function configSet<K1 extends keyof Config & string>(
  path: readonly [K1],
  value: Defined<Config[K1]>
): ConfigPatch;
export function configSet<K1 extends keyof Config & string, K2 extends keyof Defined<Config[K1]> & string>(
  path: readonly [K1, K2],
  value: Defined<Defined<Config[K1]>[K2]>
): ConfigPatch;
export function configSet<
  K1 extends keyof Config & string,
  K2 extends keyof Defined<Config[K1]> & string,
  K3 extends keyof Defined<Defined<Config[K1]>[K2]> & string,
>(path: readonly [K1, K2, K3], value: Defined<Defined<Defined<Config[K1]>[K2]>[K3]>): ConfigPatch;
export function configSet<
  K1 extends keyof Config & string,
  K2 extends keyof Defined<Config[K1]> & string,
  K3 extends keyof Defined<Defined<Config[K1]>[K2]> & string,
  K4 extends keyof Defined<Defined<Defined<Config[K1]>[K2]>[K3]> & string,
>(path: readonly [K1, K2, K3, K4], value: Defined<Defined<Defined<Defined<Config[K1]>[K2]>[K3]>[K4]>): ConfigPatch;
export function configSet(path: readonly string[], value: unknown): ConfigPatch {
  return { path, op: "set", value };
}

/**
 * Paths a client may remove — mirrors the backend's UNSETTABLE_PATH_PATTERNS in configPatch.ts
 * (which stays the runtime authority): keys that legitimately come and go. Everything else must
 * always exist, so unsetting it doesn't even compile here.
 */
type UnsettableConfigPath =
  | readonly ["scheduled_power_selling", "schedule", string]
  | readonly ["scheduled_power_buying", "schedule", string]
  | readonly ["thermometers", string]
  | readonly ["elpatron_switching", "mode"]
  | readonly ["influxdb"];

export function configUnset(path: UnsettableConfigPath): ConfigPatch {
  return { path, op: "unset" };
}
