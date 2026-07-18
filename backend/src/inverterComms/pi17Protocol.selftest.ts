/**
 * Pure self-test for the PI17 protocol layer (no hardware). Run from backend/ with:
 *   yarn node src/inverterComms/pi17Protocol.selftest.ts
 *
 * Every fixture below was captured from the real MPI 15K on 2026-07-18 (or comes from the repo
 * owner's mpp-solar fork test_responses) — CRCs included, byte for byte.
 */
import process from "process";
import {
  ACK_FRAME,
  NAK_FRAME,
  buffersEqual,
  buildQueryFrame,
  buildSetterFrame,
  classifyFrame,
  concatenateBuffers,
  crc16XModem,
  createFrameAccumulator,
} from "./pi17Frames.ts";
import { decodeQueryPayload, fixMpiAcInputFields } from "./pi17Decode.ts";
import { influxFieldName, PI17_QUERY_RESPONSE_FIELDS } from "./pi17FieldTables.ts";
import type { DecodedFields } from "./pi17Protocol.types.ts";
import { influxLineForField, INVERTER_MEASUREMENT_TOPIC } from "./publishInverterRoundsToMqtt.ts";
import { rawMQTTValuesSchema } from "../mqttValues/rawValuesSchema.ts";
import { mqttValueKeys } from "../sharedTypes.ts";
import { USB_VALUE_KEYS } from "./useInverterValues.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

function latin1(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

// Live captures (2026-07-18) unless noted
const BATS_LIVE = latin1("^D0763000,0580,0580,0000,060,0530,0400,0510,0460,0522,0,,,0,0530,000,0100,0375\xcc\x14\r");
const BATS_LIVE_FLOAT_579 = latin1(
  "^D0763000,0580,0579,0000,060,0530,0400,0510,0460,0522,0,,,0,0530,000,0100,0375\x8cu\r"
);
const BATS_LIVE_570 = latin1(
  "^D0763000,0570,0570,0000,060,0530,0400,0510,0460,0522,0,,,0,0530,000,0100,0375\x0e\xa1\r"
);
const T_LIVE = latin1("^D01720260718131927\x82\xb7\r");
const EY_LIVE = latin1("^D012012256436\x0c\x86\r");
const GS_REFERENCE = latin1(
  "^D1100000,0000,0000,0000,0394,000,+00000,2389,2427,2459,5002,0000,0000,0000,2378,2434,2455,5001,,,,029,029,000,0\xf8n\r"
);
const PS_REFERENCE = latin1(
  "^D10100263,00381,,-00855,-03141,-03156,-07152,0000,0000,0000,00000,0193,0147,0195,00535,003,1,1,1,2,2,12\x1c\r"
);
const GPMP_REFERENCE = latin1("^D00815000\xe1\xa1\r");
// mpp-solar's own HECS fixture carries a declared-length typo (says 19, actual 21) — kept as the
// regression case for the accumulator's terminator-scan fallback
const HECS_REFERENCE_WRONG_DECLARED_LENGTH = latin1("^D01900,0,0,0,0,0,0,0,0\x35\xfc\r");
const MOD_REFERENCE = latin1("^D00505\xd9\x9f\r");

// ---------- frame building (byte-exact, live-verified wire format) ----------
check("build ^P003GS", buffersEqual(buildQueryFrame("GS"), latin1("^P003GS\r")));
check("build ^P005BATS", buffersEqual(buildQueryFrame("BATS"), latin1("^P005BATS\r")));
check("build ^S015MCHGV0580,0580", buffersEqual(buildSetterFrame("MCHGV0580,0580"), latin1("^S015MCHGV0580,0580\r")));
check("build ^S011MUCHGC0100", buffersEqual(buildSetterFrame("MUCHGC0100"), latin1("^S011MUCHGC0100\r")));
check("build ^S010MCHGC3000", buffersEqual(buildSetterFrame("MCHGC3000"), latin1("^S010MCHGC3000\r")));
check("build ^S005EDA1", buffersEqual(buildSetterFrame("EDA1"), latin1("^S005EDA1\r")));

// ---------- CRC16-XModem ----------
check("crc16XModem(^1) = 0x0BC2", crc16XModem(latin1("^1")) === 0x0bc2);
check("crc16XModem(^0) = 0x1BE3", crc16XModem(latin1("^0")) === 0x1be3);
for (const [name, fixture] of [
  ["BATS live", BATS_LIVE],
  ["BATS live float 57.9", BATS_LIVE_FLOAT_579],
  ["BATS live 57.0", BATS_LIVE_570],
  ["T live", T_LIVE],
  ["EY live", EY_LIVE],
  ["GS reference", GS_REFERENCE],
  ["PS reference", PS_REFERENCE],
  ["GPMP reference", GPMP_REFERENCE],
  ["MOD reference", MOD_REFERENCE],
] as const) {
  check(`fixture CRC validates: ${name}`, classifyFrame(fixture).kind === "data");
}
{
  const corrupted = concatenateBuffers([BATS_LIVE]);
  corrupted[10] ^= 0x01; // flip one payload bit
  const classified = classifyFrame(corrupted);
  check("corrupted fixture fails CRC", classified.kind === "invalid" && classified.reason.includes("CRC"));
}

// ---------- classification ----------
check("ACK frame classifies", classifyFrame(ACK_FRAME).kind === "ack");
check("NAK frame classifies", classifyFrame(NAK_FRAME).kind === "nak");
check("ACK with corrupted CRC is invalid", classifyFrame(latin1("^1\x0b\xc3\r")).kind === "invalid");
check("garbage classifies invalid", classifyFrame(latin1("hello\r")).kind === "invalid");
check("truncated data frame classifies invalid", classifyFrame(BATS_LIVE.subarray(0, 20)).kind === "invalid");
{
  const classified = classifyFrame(GPMP_REFERENCE);
  check("data payload extraction", classified.kind === "data" && classified.payloadText === "15000");
}

// ---------- decoding ----------
function decodeFixture(command: "GS" | "PS" | "GPMP" | "HECS" | "BATS" | "MOD", fixture: Buffer): DecodedFields {
  const classified = classifyFrame(fixture);
  if (classified.kind !== "data") throw new Error(`fixture for ${command} did not classify as data`);
  const { fields, problems } = decodeQueryPayload(command, classified.payloadText);
  check(`${command} fixture decodes without problems`, problems.length === 0, problems.join("; "));
  return fields;
}
{
  const fields = decodeFixture("BATS", BATS_LIVE);
  check("BATS max charge current 300.0 A", fields.battery_maximum_charge_current === 300);
  check("BATS CV 58.0 V", fields["battery_constant_charge_voltage(c.v.)"] === 58);
  check("BATS float 58.0 V", fields.battery_floating_charge_voltage === 58);
  check(
    "BATS keep charged time 60 min",
    fields.keep_charged_time_of_battery_catch_stopped_charging_current_level === 60
  );
  check("BATS weak voltage release 52.2 V (int:r/10)", fields.battery_weak_voltage_release_in_hybrid_mode === 52.2);
  check("BATS max AC charging current 10.0 A", fields["max._ac_charging_current"] === 10);
  check("BATS discharge max current 375 A (plain int)", fields.battery_discharge_max_current_in_hybrid_mode === 375);
  check(
    "BATS empty reserved/install-date fields skipped",
    !("reserved" in fields) && !("battery_install_date" in fields)
  );
  check(
    "BATS keep-voltage function option",
    fields["ac_charger_keep_battery_voltage_function_enable/diable"] === "Disabled"
  );
}
{
  const fields = decodeFixture("BATS", BATS_LIVE_FLOAT_579);
  check("BATS variant float 57.9 V", fields.battery_floating_charge_voltage === 57.9);
}
{
  const fields = decodeFixture("GS", GS_REFERENCE);
  check("GS battery voltage 39.4 V (int:r/10)", fields.battery_voltage === 39.4);
  check("GS battery current +00000 → 0", fields.battery_current === 0);
  check("GS AC input voltage R 238.9 V", fields.ac_input_voltage_r === 238.9);
  check("GS AC input frequency 50.02 Hz (int:r/100)", fields.ac_input_frequency === 50.02);
  check("GS AC output voltage R 237.8 V", fields.ac_output_voltage_r === 237.8);
  check("GS inner temperature 29", fields.inner_temperature === 29);
  check("GS empty AC output currents skipped", !("ac_output_current_r" in fields));
  check("GS setting change bit option", fields.setting_change_bit === "No setting change");
}
{
  const classified = classifyFrame(GS_REFERENCE);
  if (classified.kind !== "data") throw new Error("unreachable");
  // The live schema even contains "Invalid option: 4" for setting_change_bit — reproduce mpp-solar's wording
  const { fields } = decodeQueryPayload("GS", classified.payloadText.replace(/,0$/, ",4"));
  check("GS out-of-range option renders like mpp-solar", fields.setting_change_bit === "Invalid option: 4");
}
{
  const fields = decodeFixture("PS", PS_REFERENCE);
  check("PS solar input power 1", fields.solar_input_power_1 === 263);
  check("PS empty battery power skipped", !("battery_power" in fields));
  check("PS AC input power R sign recovered (repair)", fields.ac_input_active_power_r === -855);
  check("PS genuine total kept (repair)", fields.ac_input_total_active_power === -7152);
  check("PS output connect status", fields.ac_output_connect_status === "Connected");
  check("PS battery power direction", fields.battery_power_direction === "Discharging");
  check("PS dc/ac power direction", fields["dc/ac_power_direction"] === "DC to AC");
  check("PS line power direction", fields.line_power_direction === "Input");
}
check("GPMP decodes", decodeFixture("GPMP", GPMP_REFERENCE).maximum_feeding_grid_power === 15000);
{
  const fields = decodeFixture("HECS", HECS_REFERENCE_WRONG_DECLARED_LENGTH);
  check("HECS priority str_keyed", fields.solar_energy_distribution_priority === "Battery-Load-Grid");
  check("HECS ac charge battery", fields.ac_charge_battery === "disabled");
  check("HECS feed-grid-normal", fields.battery_discharge_to_feed_grid_when_solar_input_normal === "disabled");
  check("HECS reserved field excluded", !("reserved" in fields));
}
check("MOD decodes", decodeFixture("MOD", MOD_REFERENCE).working_mode === "Hybrid mode (Line mode, Grid mode)");

// ---------- the AC-input repair scenarios (from the reference implementation's cases) ----------
{
  // Unsigned R, total genuinely matching sum with negative R → recover the negative sign, keep total
  const fields: DecodedFields = {
    ac_input_active_power_r: 855,
    ac_input_active_power_s: -3141,
    ac_input_active_power_t: -3156,
    ac_input_total_active_power: -7152,
    line_power_direction: "Input",
  };
  fixMpiAcInputFields(fields);
  check(
    "repair: total matches negative-R sum",
    fields.ac_input_active_power_r === -855 && fields.ac_input_total_active_power === -7152
  );
}
{
  // Unbalanced import on R while S+T export: total matches sum with positive R → R stays positive
  const fields: DecodedFields = {
    ac_input_active_power_r: 500,
    ac_input_active_power_s: -200,
    ac_input_active_power_t: -100,
    ac_input_total_active_power: 200,
    line_power_direction: "Output",
  };
  fixMpiAcInputFields(fields);
  check(
    "repair: total matches positive-R sum",
    fields.ac_input_active_power_r === 500 && fields.ac_input_total_active_power === 200
  );
}
{
  // ≥10 kW export: total frozen at the firmware's +7937 garbage → reconstruct from phases, R negative per direction
  const fields: DecodedFields = {
    ac_input_active_power_r: 3300,
    ac_input_active_power_s: -3400,
    ac_input_active_power_t: -3500,
    ac_input_total_active_power: 7937,
    line_power_direction: "Output",
  };
  fixMpiAcInputFields(fields);
  check(
    "repair: garbage total while exporting",
    fields.ac_input_active_power_r === -3300 && fields.ac_input_total_active_power === -10200
  );
}
{
  // ≥10 kW import: total is wrapping junk → reconstruct, R positive per direction
  const fields: DecodedFields = {
    ac_input_active_power_r: 3300,
    ac_input_active_power_s: 3400,
    ac_input_active_power_t: 3500,
    ac_input_total_active_power: -31000,
    line_power_direction: "Input",
  };
  fixMpiAcInputFields(fields);
  check(
    "repair: garbage total while importing",
    fields.ac_input_active_power_r === 3300 && fields.ac_input_total_active_power === 10200
  );
}
{
  // Missing direction (or any input) → leave everything untouched, like the reference's None guard
  const fields: DecodedFields = {
    ac_input_active_power_r: 855,
    ac_input_active_power_s: -3141,
    ac_input_active_power_t: -3156,
    ac_input_total_active_power: 7937,
  };
  fixMpiAcInputFields(fields);
  check(
    "repair: missing direction leaves fields untouched",
    fields.ac_input_active_power_r === 855 && fields.ac_input_total_active_power === 7937
  );
}

// ---------- frame reassembly ----------
const wireStream = concatenateBuffers([BATS_LIVE, ACK_FRAME, GS_REFERENCE]);
function reassembleInChunksOf(chunkSize: number): { frames: Buffer[]; totalDiscarded: number } {
  const accumulator = createFrameAccumulator();
  const frames: Buffer[] = [];
  let totalDiscarded = 0;
  for (let offset = 0; offset < wireStream.length; offset += chunkSize) {
    const pushed = accumulator.push(wireStream.subarray(offset, offset + chunkSize));
    frames.push(...pushed.frames);
    totalDiscarded += pushed.discardedByteCount;
  }
  return { frames, totalDiscarded };
}
for (const chunkSize of [1, 7, 8, wireStream.length]) {
  const { frames, totalDiscarded } = reassembleInChunksOf(chunkSize);
  check(
    `reassembly in ${chunkSize}-byte chunks yields the 3 exact frames, nothing discarded`,
    frames.length === 3 &&
      totalDiscarded === 0 &&
      buffersEqual(frames[0]!, BATS_LIVE) &&
      buffersEqual(frames[1]!, ACK_FRAME) &&
      buffersEqual(frames[2]!, GS_REFERENCE)
  );
}
{
  // Stale-prefix flushing: garbage + a partial frame get counted/dropped, a fresh frame then parses cleanly
  const accumulator = createFrameAccumulator();
  const { frames, discardedByteCount } = accumulator.push(latin1("junk^D07"));
  check("garbage before ^ is discarded", frames.length === 0 && discardedByteCount === 4);
  check("flush drops the stale partial frame", accumulator.flush() === 4 && accumulator.bufferedByteCount() === 0);
  const afterFlush = accumulator.push(BATS_LIVE);
  check(
    "fresh frame parses after flush",
    afterFlush.frames.length === 1 && buffersEqual(afterFlush.frames[0]!, BATS_LIVE)
  );
}
{
  // A CRC byte that happens to be \r (0x0d) must not split the frame — this is why extraction
  // cuts at the declared length instead of the first \r (~1 in 128 frames would break otherwise)
  let frameWithCrInCrc: Buffer | undefined;
  for (let candidate = 0; candidate < 10_000 && !frameWithCrInCrc; candidate++) {
    const payload = `CRTEST${candidate}`;
    const body = latin1(`^D${String(payload.length + 3).padStart(3, "0")}${payload}`);
    const crc = crc16XModem(body);
    if (crc >> 8 === 0x0d || (crc & 0xff) === 0x0d) {
      frameWithCrInCrc = concatenateBuffers([body, Buffer.from([crc >> 8, crc & 0xff, 0x0d])]);
    }
  }
  check("found a payload whose CRC contains 0x0d", frameWithCrInCrc !== undefined);
  if (frameWithCrInCrc) {
    const accumulator = createFrameAccumulator();
    const { frames } = accumulator.push(concatenateBuffers([frameWithCrInCrc, ACK_FRAME]));
    check(
      "declared-length extraction survives \\r inside the CRC",
      frames.length === 2 && buffersEqual(frames[0]!, frameWithCrInCrc) && buffersEqual(frames[1]!, ACK_FRAME)
    );
    check("frame with \\r in CRC still classifies as data", classifyFrame(frameWithCrInCrc).kind === "data");
  }
}
{
  // Wrong declared length (mpp-solar's HECS fixture typo) → terminator-scan fallback recovers it
  const accumulator = createFrameAccumulator();
  const { frames, problems } = accumulator.push(concatenateBuffers([HECS_REFERENCE_WRONG_DECLARED_LENGTH, ACK_FRAME]));
  check(
    "wrong declared length recovered via terminator scan",
    frames.length === 2 &&
      buffersEqual(frames[0]!, HECS_REFERENCE_WRONG_DECLARED_LENGTH) &&
      buffersEqual(frames[1]!, ACK_FRAME)
  );
  check(
    "length mismatch is reported as a problem",
    problems.some(problem => problem.includes("declared"))
  );
}

// ---------- field-name integrity: decode tables ↔ rawValuesSchema ↔ ws contract ----------
// A drift here silently breaks InfluxDB series and the staleness alerting, so it's a hard failure.
const schemaKeys = new Set(Object.keys(rawMQTTValuesSchema.shape));
const liveDecodeNames = new Set(
  [...PI17_QUERY_RESPONSE_FIELDS.GS, ...PI17_QUERY_RESPONSE_FIELDS.PS]
    .filter(spec => spec.reading.kind !== "exclude")
    .map(spec => influxFieldName(spec.name))
);
for (const name of liveDecodeNames) {
  check(`GS/PS decode name exists in rawValuesSchema: ${name}`, schemaKeys.has(name));
}
// Schema keys that never come from GS/PS decoding, each with a reason:
const schemaKeysNotFromDecoder = new Set([
  "currentBatteryPower", // legacy backend-published hall-sensor value (nothing consumes it from this store)
  "validity_check", // old mpp-solar CRC-error artifact — only produced by the retired daemon
  "error", // old mpp-solar error artifact
  "unknown_value_in_response_25", // surplus-token artifact; the native decoder names them the same way
]);
for (const key of schemaKeys) {
  check(
    `schema key decodes from GS/PS (or is a documented exception): ${key}`,
    liveDecodeNames.has(key) || schemaKeysNotFromDecoder.has(key)
  );
}
for (const key of mqttValueKeys) {
  check(`ws-contract mqttValueKey decodes from GS/PS: ${key}`, liveDecodeNames.has(key));
}
const settingsDecodeNames = new Set(
  [...PI17_QUERY_RESPONSE_FIELDS.GPMP, ...PI17_QUERY_RESPONSE_FIELDS.HECS, ...PI17_QUERY_RESPONSE_FIELDS.BATS]
    .filter(spec => spec.reading.kind !== "exclude")
    .map(spec => influxFieldName(spec.name))
);
for (const key of USB_VALUE_KEYS) {
  check(`UsbValues key decodes from GPMP/HECS/BATS: ${key}`, settingsDecodeNames.has(key));
}

// ---------- influx line protocol (must match live broker samples byte-for-byte) ----------
check("topic is mpp-solar", INVERTER_MEASUREMENT_TOPIC === "mpp-solar");
check(
  "line protocol: numeric field matches live sample",
  influxLineForField("solar_input_voltage_1", 321.6) === "mpp-solar,command=Inverter1 solar_input_voltage_1=321.6"
);
check(
  "line protocol: string field is quoted",
  influxLineForField("battery_power_direction", "Discharging") ===
    'mpp-solar,command=Inverter1 battery_power_direction="Discharging"'
);
check(
  "line protocol: integer-valued float stays bare (Influx float)",
  influxLineForField("solar_input_power_1", 263) === "mpp-solar,command=Inverter1 solar_input_power_1=263"
);

console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all pi17Protocol selftests passed"}`);
process.exit(fails.length ? 1 : 0);
