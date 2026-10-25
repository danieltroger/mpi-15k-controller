/**
 * Pure self-test: "Inverter data stale" judges GS and PS separately, so a command whose every round
 * fails the plausibility gate can't hide behind the other one's fresh values.
 * Run from backend/ with:  yarn node src/alerting/inverterTelemetryStaleness.selftest.ts
 */
import process from "process";
import { influxFieldName, PI17_QUERY_RESPONSE_FIELDS } from "../inverterComms/pi17FieldTables.ts";
import {
  describeTelemetryStaleness,
  inverterTelemetryStaleness,
  type TimedTelemetry,
} from "./inverterTelemetryStaleness.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

const gsFields = PI17_QUERY_RESPONSE_FIELDS.GS.map(spec => influxFieldName(spec.name));
const psFields = PI17_QUERY_RESPONSE_FIELDS.PS.map(spec => influxFieldName(spec.name));
function telemetry({ gsAt, psAt }: { gsAt?: number; psAt?: number }): TimedTelemetry {
  const values: Record<string, { time: number }> = {};
  if (gsAt !== undefined) for (const name of gsFields) values[name] = { time: gsAt };
  if (psAt !== undefined) for (const name of psFields) values[name] = { time: psAt };
  return values;
}
const bootedAtMs = 1_000_000;
const nowMs = bootedAtMs + 30 * 60_000;
const limitMs = 10 * 60_000;

check("nothing received yet → no verdict (boot)", inverterTelemetryStaleness({}, nowMs, bootedAtMs) === undefined);
{
  const staleness = inverterTelemetryStaleness(
    telemetry({ gsAt: nowMs - 1_000, psAt: nowMs - 2_000 }),
    nowMs,
    bootedAtMs
  );
  check("both fresh → not stale", staleness !== undefined && staleness.silentForMs < limitMs);
}
{
  // The reviewer's scenario: every GS round dropped for 15 min, PS healthy
  const values = telemetry({ gsAt: nowMs - 15 * 60_000, psAt: nowMs - 1_000 });
  const oldRuleNewestMs = Math.max(...Object.values(values).map(value => value?.time ?? 0));
  check("(the old newest-across-GS-and-PS rule would have stayed quiet)", nowMs - oldRuleNewestMs < limitMs);
  const staleness = inverterTelemetryStaleness(values, nowMs, bootedAtMs);
  check(
    "GS silent 15 min while PS is fresh → stale, GS named",
    staleness !== undefined && staleness.stalest === "GS" && staleness.silentForMs > limitMs
  );
  const text = staleness ? describeTelemetryStaleness(staleness, limitMs) : "";
  check(
    "the alert text names GS and says PS keeps arriving",
    text.includes("No GS inverter values for 15 min") && text.includes("PS keeps arriving"),
    text
  );
}
{
  // GS never decoded since boot (dropped from the first round), PS flowing
  const staleness = inverterTelemetryStaleness(telemetry({ psAt: nowMs - 1_000 }), nowMs, bootedAtMs);
  check(
    "GS never seen since boot counts as silent since boot",
    staleness?.stalest === "GS" && staleness.silentForMs === nowMs - bootedAtMs
  );
}
{
  const staleness = inverterTelemetryStaleness(
    telemetry({ gsAt: nowMs - 12 * 60_000, psAt: nowMs - 11 * 60_000 }),
    nowMs,
    bootedAtMs
  );
  const text = staleness ? describeTelemetryStaleness(staleness, limitMs) : "";
  check(
    "both silent → the classic 'serial session dead?' text with the longer silence",
    staleness?.stalest === "GS" &&
      staleness.silentForMs === 12 * 60_000 &&
      text === "No inverter value updates for 12 min — serial session dead?",
    text
  );
}
{
  // Only a few fields of a command arriving is enough for that command to count as fresh
  const values: Record<string, { time: number }> = {
    battery_voltage: { time: nowMs - 500 },
    solar_input_power_1: { time: nowMs - 700 },
  };
  const staleness = inverterTelemetryStaleness(values, nowMs, bootedAtMs);
  check("a command counts as fresh by its newest field", staleness !== undefined && staleness.silentForMs === 700);
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all inverterTelemetryStaleness selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
