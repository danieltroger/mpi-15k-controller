/**
 * Pure self-test for path-scoped config patching (no hardware, no DB). Run from backend/ with:
 *   yarn node src/config/configPatch.selftest.ts
 */
import process from "process";
import { applyConfigPatch, applyConfigPatches } from "./configPatch.ts";
import { default_config } from "./config.ts";
import type { Config } from "./config.types.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}
function expectError(name: string, result: ReturnType<typeof applyConfigPatch>, messageContains: string) {
  const gotError = "error" in result ? result.error : "(no error)";
  check(name, "error" in result && gotError.includes(messageContains), `(${gotError})`);
}

const base: Config = structuredClone(default_config);

// ---------- set: happy paths ----------
{
  const result = applyConfigPatch(base, { path: ["automatic_trading", "enabled"], op: "set", value: true });
  check("set leaf boolean", "patched" in result && result.patched.automatic_trading.enabled === true);
  check("set does not mutate input", base.automatic_trading.enabled === false);
  check(
    "set clones only along the path (untouched sections keep identity)",
    "patched" in result &&
      result.patched.alerting === base.alerting &&
      result.patched.automatic_trading !== base.automatic_trading
  );
}
{
  const result = applyConfigPatch(base, {
    path: ["soc_calculations", "ah_ledger", "soft_empty", "voltage"],
    op: "set",
    value: 48.5,
  });
  check(
    "set depth-4 leaf next to machine-owned siblings",
    "patched" in result && result.patched.soc_calculations.ah_ledger.soft_empty.voltage === 48.5
  );
}
{
  const result = applyConfigPatch(base, { path: ["soc_calculations", "battery_empty_at"], op: "set", value: 45 });
  check(
    "set sibling of machine-owned subtree is allowed",
    "patched" in result && result.patched.soc_calculations.battery_empty_at === 45
  );
}
{
  // influxdb is optional and absent in default_config — set must create the intermediate object
  const result = applyConfigPatch(base, { path: ["influxdb", "host"], op: "set", value: "192.168.1.126" });
  check(
    "set creates missing optional section",
    "patched" in result && result.patched.influxdb?.host === "192.168.1.126"
  );
}
{
  const entry = { end_time: "2026-07-19T14:00:00.000Z", power_watts: 12000 };
  const result = applyConfigPatch(base, {
    path: ["scheduled_power_selling", "schedule", "2026-07-19T12:00:00.000Z"],
    op: "set",
    value: entry,
  });
  check(
    "set adds a schedule entry",
    "patched" in result &&
      result.patched.scheduled_power_selling.schedule["2026-07-19T12:00:00.000Z"]?.power_watts === 12000
  );
}

// ---------- set: rejections ----------
expectError(
  "set with wrong primitive type is rejected",
  applyConfigPatch(base, { path: ["elpatron_switching", "min_solar_input"], op: "set", value: "6000" }),
  "Type mismatch"
);
expectError(
  "set object over primitive is rejected",
  applyConfigPatch(base, { path: ["mqtt_host"], op: "set", value: { host: "x" } }),
  "Type mismatch"
);
expectError(
  "set without value is rejected",
  applyConfigPatch(base, { path: ["automatic_trading", "enabled"], op: "set" }),
  "no value"
);
expectError(
  "set null is rejected",
  applyConfigPatch(base, { path: ["automatic_trading", "enabled"], op: "set", value: null }),
  "null"
);
expectError(
  "unknown top-level key is rejected",
  applyConfigPatch(base, { path: ["not_a_real_key"], op: "set", value: 1 }),
  "known config key"
);
expectError("empty path is rejected", applyConfigPatch(base, { path: [], op: "set", value: 1 }), "non-empty");
expectError(
  "non-string segment is rejected",
  applyConfigPatch(base, { path: ["alerting", 5 as unknown as string], op: "set", value: 1 }),
  "non-empty"
);
expectError(
  "__proto__ segment is rejected",
  applyConfigPatch(base, { path: ["alerting", "__proto__"], op: "set", value: {} }),
  "forbidden"
);
expectError(
  "descending into a primitive is rejected",
  applyConfigPatch(base, { path: ["mqtt_host", "port"], op: "set", value: 1883 }),
  "not an object"
);

// ---------- machine-owned protection ----------
expectError(
  "machine-owned leaf is rejected",
  applyConfigPatch(base, { path: ["soc_calculations", "ah_ledger", "drain_a"], op: "set", value: 1 }),
  "machine-owned"
);
expectError(
  "machine-owned capacity_ah is rejected",
  applyConfigPatch(base, { path: ["soc_calculations", "ah_ledger", "capacity_ah"], op: "set", value: 1240 }),
  "machine-owned"
);
expectError(
  "parent object of machine-owned key is rejected (no smuggling)",
  applyConfigPatch(base, { path: ["soc_calculations", "ah_ledger"], op: "set", value: { drain_a: 0 } }),
  "machine-owned"
);
expectError(
  "whole soc_calculations write is rejected",
  applyConfigPatch(base, { path: ["soc_calculations"], op: "set", value: {} }),
  "machine-owned"
);

// ---------- unset ----------
{
  const startKey = Object.keys(base.scheduled_power_selling.schedule)[0];
  const result = applyConfigPatch(base, { path: ["scheduled_power_selling", "schedule", startKey], op: "unset" });
  check(
    "unset removes a schedule entry",
    "patched" in result && !(startKey in result.patched.scheduled_power_selling.schedule)
  );
}
{
  const result = applyConfigPatch(base, { path: ["thermometers", "not-there"], op: "unset" });
  check("unset of absent leaf is an idempotent no-op", "patched" in result);
}
{
  const result = applyConfigPatch(base, { path: ["influxdb"], op: "unset" });
  check("unset of absent optional section succeeds", "patched" in result && !("influxdb" in result.patched));
}
expectError(
  "unset of a required key is rejected",
  applyConfigPatch(base, { path: ["alerting", "enabled"], op: "unset" }),
  "removable"
);
expectError(
  "unset below an unsettable section is rejected (pattern is exact-length)",
  applyConfigPatch(base, { path: ["influxdb", "host"], op: "unset" }),
  "removable"
);
expectError(
  "unset with a value is rejected",
  applyConfigPatch(base, { path: ["thermometers", "x"], op: "unset", value: 1 }),
  "takes no value"
);

// ---------- unknown op ----------
expectError(
  "unknown op is rejected",
  applyConfigPatch(base, { path: ["alerting", "enabled"], op: "merge" as "set", value: true }),
  "Unknown patch op"
);

// ---------- applyConfigPatches ----------
{
  const result = applyConfigPatches(base, [
    { path: ["automatic_trading", "enabled"], op: "set", value: true },
    { path: ["automatic_trading", "extra_reserve_kwh"], op: "set", value: 5 },
  ]);
  check(
    "applyConfigPatches applies all in order",
    "patched" in result &&
      result.patched.automatic_trading.enabled === true &&
      result.patched.automatic_trading.extra_reserve_kwh === 5
  );
}
{
  const result = applyConfigPatches(base, [
    { path: ["automatic_trading", "enabled"], op: "set", value: true },
    { path: ["soc_calculations", "ah_ledger", "drain_a"], op: "set", value: 0 },
  ]);
  check("applyConfigPatches stops at the first invalid patch", "error" in result);
}

console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all configPatch selftests passed"}`);
process.exit(fails.length ? 1 : 0);
