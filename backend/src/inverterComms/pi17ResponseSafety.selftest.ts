/**
 * Pure self-test for the two guards added after the first production cutover was rolled back
 * (2026-10-25): frame attribution (pi17ResponseShapes.ts) and the plausibility gate
 * (plausibilityGate.ts). No hardware. Run from backend/ with:
 *   yarn node src/inverterComms/pi17ResponseSafety.selftest.ts
 *
 * The *_LIVE fixtures are real frames from the MPI 15K, recovered byte-for-byte from an strace of
 * the failing session on 2026-10-25 (their CRCs validate below, which proves the recovery exact).
 */
import process from "process";
import { ACK_FRAME, NAK_FRAME, classifyFrame, concatenateBuffers, createFrameAccumulator } from "./pi17Frames.ts";
import {
  CFS_FAULT_14_PAYLOAD,
  dataFrameAsTheInverterSendsIt,
  HFS_BOOT_RECORDS,
  HFS_DATALOGGER_PAYLOAD,
  MOD_FAULT_PAYLOAD,
  WS_DAY_PAYLOAD,
  WS_NIGHT_PAYLOAD,
} from "./pi17StatusFixtures.ts";
import { decodeQueryPayload } from "./pi17Decode.ts";
import { influxFieldName, PI17_QUERY_RESPONSE_FIELDS } from "./pi17FieldTables.ts";
import {
  frameMismatchForExpectation,
  PI17_RESPONSE_SHAPES,
  responseShapeMismatch,
  type ExchangeExpectation,
  type InclusiveRange,
} from "./pi17ResponseShapes.ts";
import { implausibleFieldsIn, PLAUSIBLE_NUMERIC_RANGES } from "./plausibilityGate.ts";
import type { DecodedFields, Pi17QueryCommandName } from "./pi17Protocol.types.ts";
import type { AcceptedFrame } from "./serialExchange.ts";
import { USB_VALUE_KEYS } from "./useInverterValues.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

function latin1(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

const GS_LIVE_1 = latin1(
  "^D11203482,03256,0021,0026,0532,073,-00098,2363,2352,2358,5004,0000,0000,0000,2361,2352,2358,5008,,,,036,053,000,0\x1fV\r"
);
const GS_LIVE_2 = latin1(
  "^D11203479,03251,0022,0025,0532,073,-00098,2358,2356,2358,4994,0000,0000,0000,2356,2354,2361,4991,,,,036,053,000,0W\x8c\r"
);
const GS_LIVE_3 = latin1(
  "^D11203482,03243,0021,0025,0532,073,-00090,2358,2354,2358,4994,0000,0000,0000,2361,2354,2358,5003,,,,036,053,000,0\xfe@\r"
);
const PS_LIVE_1 = latin1(
  "^D10700080,00085,,+00008,-00175,-00054,-00237,00223,00076,00189,00488,00259,00076,00212,00547,003,1,1,1,2,2,2\x16\x1d\r"
);
const PS_LIVE_2 = latin1(
  "^D10700079,00087,,+00017,-00168,-00053,-00238,00208,00075,00183,00466,00235,00075,00212,00522,003,1,1,1,2,2,2\x99\xd7\r"
);
// Older captures (2026-07-18 live / mpp-solar fork references), also used by pi17Protocol.selftest.ts
const BATS_LIVE = latin1("^D0763000,0580,0580,0000,060,0530,0400,0510,0460,0522,0,,,0,0530,000,0100,0375\xcc\x14\r");
const GS_REFERENCE = latin1(
  "^D1100000,0000,0000,0000,0394,000,+00000,2389,2427,2459,5002,0000,0000,0000,2378,2434,2455,5001,,,,029,029,000,0\xf8n\r"
);
const PS_REFERENCE = latin1(
  "^D10100263,00381,,-00855,-03141,-03156,-07152,0000,0000,0000,00000,0193,0147,0195,00535,003,1,1,1,2,2,12\x1c\r"
);
const GPMP_REFERENCE = latin1("^D00815000\xe1\xa1\r");
const HECS_REFERENCE = latin1("^D01900,0,0,0,0,0,0,0,0\x35\xfc\r");
const MOD_REFERENCE = latin1("^D00505\xd9\x9f\r");
// The status answers this inverter gave the WiFi datalogger (CRCs rebuilt, see pi17StatusFixtures.ts);
// mpp-solar's WS fixture is a complete frame of its own
const MOD_FAULT_DATALOGGER = dataFrameAsTheInverterSendsIt(MOD_FAULT_PAYLOAD);
const CFS_DATALOGGER = dataFrameAsTheInverterSendsIt(CFS_FAULT_14_PAYLOAD);
const WS_NIGHT_DATALOGGER = dataFrameAsTheInverterSendsIt(WS_NIGHT_PAYLOAD);
const WS_DAY_DATALOGGER = dataFrameAsTheInverterSendsIt(WS_DAY_PAYLOAD);
const WS_MPPSOLAR_REFERENCE = latin1("^D0471,1,0,0,1,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,\x14\x9c\r");
// All nine slots as the controller read them on 2026-10-26: every record has the same shape
const HFS_BOOT_RECORD_FRAMES = HFS_BOOT_RECORDS.map(dataFrameAsTheInverterSendsIt);

const FIXTURES_BY_COMMAND: Readonly<Record<Pi17QueryCommandName, readonly Buffer[]>> = {
  GS: [GS_LIVE_1, GS_LIVE_2, GS_LIVE_3, GS_REFERENCE],
  PS: [PS_LIVE_1, PS_LIVE_2, PS_REFERENCE],
  BATS: [BATS_LIVE],
  HECS: [HECS_REFERENCE],
  GPMP: [GPMP_REFERENCE],
  MOD: [MOD_REFERENCE, MOD_FAULT_DATALOGGER],
  CFS: [CFS_DATALOGGER],
  WS: [WS_NIGHT_DATALOGGER, WS_DAY_DATALOGGER, WS_MPPSOLAR_REFERENCE],
  HFS: HFS_BOOT_RECORD_FRAMES,
};
const ALL_COMMANDS: readonly Pi17QueryCommandName[] = ["GS", "PS", "BATS", "HECS", "GPMP", "MOD", "CFS", "WS", "HFS"];

function payloadOf(fixture: Buffer): string {
  const classified = classifyFrame(fixture);
  if (classified.kind !== "data") throw new Error(`fixture did not classify as data: ${fixture.toString("latin1")}`);
  return classified.payloadText;
}

function acceptedFrame(fixture: Buffer): AcceptedFrame {
  const classified = classifyFrame(fixture);
  if (classified.kind === "invalid") throw new Error(`fixture is invalid: ${classified.reason}`);
  return classified;
}

check(
  "the command list covers every response shape",
  Object.keys(PI17_RESPONSE_SHAPES).length === ALL_COMMANDS.length &&
    ALL_COMMANDS.every(command => command in PI17_RESPONSE_SHAPES)
);

// ---------- the recovered live frames are byte-exact ----------
for (const [name, fixture] of [
  ["GS_LIVE_1", GS_LIVE_1],
  ["GS_LIVE_2", GS_LIVE_2],
  ["GS_LIVE_3", GS_LIVE_3],
  ["PS_LIVE_1", PS_LIVE_1],
  ["PS_LIVE_2", PS_LIVE_2],
] as const) {
  check(`live 2026-10-25 fixture CRC validates: ${name}`, classifyFrame(fixture).kind === "data");
}
check("mpp-solar's WS reference frame CRC validates", classifyFrame(WS_MPPSOLAR_REFERENCE).kind === "data");

// ---------- shapes: every fixture fits its own command and no other ----------
for (const command of ALL_COMMANDS) {
  for (const [fixtureIndex, fixture] of FIXTURES_BY_COMMAND[command].entries()) {
    const payload = payloadOf(fixture);
    check(
      `${command} fixture #${fixtureIndex} fits the ${command} shape`,
      responseShapeMismatch(command, payload) === undefined,
      responseShapeMismatch(command, payload) ?? ""
    );
    for (const otherCommand of ALL_COMMANDS) {
      if (otherCommand === command) continue;
      check(
        `${command} fixture #${fixtureIndex} is rejected as a ${otherCommand} response`,
        responseShapeMismatch(otherCommand, payload) !== undefined
      );
    }
  }
}

// Structural guarantee behind the above: for every pair of commands, either the token-count or
// the payload-length ranges are disjoint, so no frame can ever fit two commands' shapes.
function rangesOverlap(first: InclusiveRange, second: InclusiveRange): boolean {
  return first.min <= second.max && second.min <= first.max;
}
for (const [firstIndex, first] of ALL_COMMANDS.entries()) {
  for (const second of ALL_COMMANDS.slice(firstIndex + 1)) {
    const firstShape = PI17_RESPONSE_SHAPES[first];
    const secondShape = PI17_RESPONSE_SHAPES[second];
    check(
      `shapes of ${first} and ${second} are disjoint`,
      !rangesOverlap(firstShape.tokenCount, secondShape.tokenCount) ||
        !rangesOverlap(firstShape.payloadLength, secondShape.payloadLength)
    );
  }
}
// Each shape must cover the decode table it serves (or the documented MPI subset for BATS)
for (const command of ALL_COMMANDS) {
  const tableFieldCount = PI17_QUERY_RESPONSE_FIELDS[command].length;
  check(
    `${command} shape admits the full ${tableFieldCount}-field table`,
    tableFieldCount >= PI17_RESPONSE_SHAPES[command].tokenCount.min &&
      tableFieldCount <= PI17_RESPONSE_SHAPES[command].tokenCount.max
  );
}

// ---------- frame ↔ expectation matching ----------
const expectSetter: ExchangeExpectation = { kind: "setter" };
const expectGs: ExchangeExpectation = { kind: "query", command: "GS" };
const expectPs: ExchangeExpectation = { kind: "query", command: "PS" };
check("setter accepts ACK", frameMismatchForExpectation(expectSetter, acceptedFrame(ACK_FRAME)) === undefined);
check("setter accepts NAK", frameMismatchForExpectation(expectSetter, acceptedFrame(NAK_FRAME)) === undefined);
check(
  "setter rejects a (late) data frame instead of reading it as 'not applied'",
  frameMismatchForExpectation(expectSetter, acceptedFrame(PS_LIVE_1)) !== undefined
);
check("GS query rejects a late ACK", frameMismatchForExpectation(expectGs, acceptedFrame(ACK_FRAME)) !== undefined);
check("GS query rejects a late NAK", frameMismatchForExpectation(expectGs, acceptedFrame(NAK_FRAME)) !== undefined);
check(
  "GS query accepts a live GS frame",
  frameMismatchForExpectation(expectGs, acceptedFrame(GS_LIVE_1)) === undefined
);
check(
  "PS query accepts a live PS frame",
  frameMismatchForExpectation(expectPs, acceptedFrame(PS_LIVE_1)) === undefined
);
// An empty fault-record slot may be declined; nothing else a query can be answered with changes
const expectHfs: ExchangeExpectation = { kind: "query", command: "HFS" };
check(
  "HFS query accepts a NAK (an empty slot)",
  frameMismatchForExpectation(expectHfs, acceptedFrame(NAK_FRAME)) === undefined
);
check(
  "HFS query still rejects a late ACK",
  frameMismatchForExpectation(expectHfs, acceptedFrame(ACK_FRAME)) !== undefined
);
check(
  "HFS query rejects a GS frame (same 25 tokens, but GS stays below HFS's 128-byte floor)",
  frameMismatchForExpectation(expectHfs, acceptedFrame(GS_LIVE_1)) !== undefined
);
for (const command of ALL_COMMANDS.filter(command => command !== "HFS")) {
  check(
    `${command} query still rejects a NAK`,
    frameMismatchForExpectation({ kind: "query", command }, acceptedFrame(NAK_FRAME)) !== undefined
  );
}

// ---------- regression: the observed failure sequence (2026-10-25 14:03:56 UTC) ----------
// A delayed GS retry and the next PS hit the wire 1 ms apart, so a PS frame arrived while GS was
// in flight (and vice versa). Replay the bytes through the accumulator + matcher exactly as the
// exchange layer does: the wrong-command frame must be rejected, the right one accepted.
function framesAcceptedWhileInFlight(expectation: ExchangeExpectation, wireBytes: Buffer, chunkSize: number) {
  const accumulator = createFrameAccumulator();
  const accepted: AcceptedFrame[] = [];
  const rejectedReasons: string[] = [];
  for (let offset = 0; offset < wireBytes.length; offset += chunkSize) {
    for (const frame of accumulator.push(wireBytes.subarray(offset, offset + chunkSize)).frames) {
      const classified = classifyFrame(frame);
      if (classified.kind === "invalid") continue;
      const mismatch = frameMismatchForExpectation(expectation, classified);
      if (mismatch === undefined) accepted.push(classified);
      else rejectedReasons.push(mismatch);
    }
  }
  return { accepted, rejectedReasons };
}
for (const chunkSize of [4, 64]) {
  const gsInFlight = framesAcceptedWhileInFlight(expectGs, concatenateBuffers([PS_LIVE_1, GS_LIVE_2]), chunkSize);
  check(
    `PS frame arriving while GS is in flight is rejected, the GS frame accepted (${chunkSize}-byte chunks)`,
    gsInFlight.rejectedReasons.length === 1 &&
      gsInFlight.accepted.length === 1 &&
      gsInFlight.accepted[0]!.kind === "data" &&
      gsInFlight.accepted[0]!.payloadText === payloadOf(GS_LIVE_2),
    gsInFlight.rejectedReasons.join("; ")
  );
  const psInFlight = framesAcceptedWhileInFlight(expectPs, concatenateBuffers([GS_LIVE_1, PS_LIVE_2]), chunkSize);
  check(
    `GS frame arriving while PS is in flight is rejected, the PS frame accepted (${chunkSize}-byte chunks)`,
    psInFlight.rejectedReasons.length === 1 &&
      psInFlight.accepted.length === 1 &&
      psInFlight.accepted[0]!.kind === "data" &&
      psInFlight.accepted[0]!.payloadText === payloadOf(PS_LIVE_2)
  );
  const setterInFlight = framesAcceptedWhileInFlight(
    expectSetter,
    concatenateBuffers([PS_LIVE_1, ACK_FRAME]),
    chunkSize
  );
  check(
    `late PS frame before a setter's ACK: data rejected, ACK accepted (${chunkSize}-byte chunks)`,
    setterInFlight.rejectedReasons.length === 1 &&
      setterInFlight.accepted.length === 1 &&
      setterInFlight.accepted[0]!.kind === "ack"
  );
}
// What the missing guard produced: the PS payload decoded through the GS table. Both defences
// must catch it independently — the shape (22 tokens ≠ 25) and, behind it, the gate.
{
  const psDecodedAsGs = decodeQueryPayload("GS", payloadOf(PS_LIVE_1)).fields;
  check(
    "PS-as-GS misdecode yields the incident's kind of battery voltage",
    psDecodedAsGs.battery_voltage === -17.5,
    `got ${psDecodedAsGs.battery_voltage}`
  );
  check("PS-as-GS misdecode is rejected by shape", responseShapeMismatch("GS", payloadOf(PS_LIVE_1)) !== undefined);
  check("PS-as-GS misdecode is also dropped by the gate", implausibleFieldsIn(psDecodedAsGs).length > 0);
  const gsDecodedAsPs = decodeQueryPayload("PS", payloadOf(GS_LIVE_1)).fields;
  check(
    "GS-as-PS misdecode produced the incident's surplus fields",
    "unknown_value_in_response_22" in gsDecodedAsPs && "unknown_value_in_response_24" in gsDecodedAsPs
  );
  check("GS-as-PS misdecode is rejected by shape", responseShapeMismatch("PS", payloadOf(GS_LIVE_1)) !== undefined);
}

// ---------- plausibility gate ----------
for (const command of ALL_COMMANDS) {
  for (const [fixtureIndex, fixture] of FIXTURES_BY_COMMAND[command].entries()) {
    const { fields } = decodeQueryPayload(command, payloadOf(fixture));
    const problems = implausibleFieldsIn(fields);
    // The 2026-07 GS reference reads 39.4 V — a bench pack, below this 16S LiFePO4's floor
    const expectImplausible = fixture === GS_REFERENCE;
    check(
      `gate ${expectImplausible ? "drops" : "passes"} ${command} fixture #${fixtureIndex}`,
      expectImplausible ? problems.length > 0 : problems.length === 0,
      problems.join("; ")
    );
  }
}
{
  // The exact round published at 2026-10-25T14:04:29.777Z (PS decoded as GS) — it re-anchored SOC to empty
  const incidentRound: DecodedFields = {
    ...decodeQueryPayload("GS", payloadOf(GS_LIVE_1)).fields,
    battery_voltage: -30.9,
    battery_capacity: -202,
    battery_current: -65.7,
  };
  const problems = implausibleFieldsIn(incidentRound);
  check(
    "gate drops the 2026-10-25 incident round (−30.9 V / −202 % / −65.7 A)",
    problems.length === 2 &&
      problems.some(problem => problem.startsWith("battery_voltage")) &&
      problems.some(problem => problem.startsWith("battery_capacity")),
    problems.join("; ")
  );
}
function gateVerdictFor(overrides: DecodedFields): string[] {
  return implausibleFieldsIn({ ...decodeQueryPayload("GS", payloadOf(GS_LIVE_1)).fields, ...overrides });
}
check("battery voltage 39.9 V dropped", gateVerdictFor({ battery_voltage: 39.9 }).length === 1);
check("battery voltage 62.1 V dropped", gateVerdictFor({ battery_voltage: 62.1 }).length === 1);
check("battery voltage 58.0 V passes", gateVerdictFor({ battery_voltage: 58 }).length === 0);
check("battery capacity 101 % dropped", gateVerdictFor({ battery_capacity: 101 }).length === 1);
check("battery current −401 A dropped", gateVerdictFor({ battery_current: -401 }).length === 1);
check("battery current −300 A passes", gateVerdictFor({ battery_current: -300 }).length === 0);
check("PV voltage 1001 V dropped", gateVerdictFor({ solar_input_voltage_1: 1001 }).length === 1);
check("grid voltage 301 V dropped", gateVerdictFor({ ac_input_voltage_r: 301 }).length === 1);
check("grid frequency 44 Hz dropped", gateVerdictFor({ ac_input_frequency: 44 }).length === 1);
check("grid frequency 56 Hz dropped", gateVerdictFor({ ac_input_frequency: 56 }).length === 1);
{
  // A real grid outage, not a synthetic one: the GS round of 2025-04-13T03:00:00.55Z (outage
  // 2025-04-12 ~15:00 → 2025-04-13 ~09:00 UTC), rebuilt token by token from InfluxDB — that era's
  // daemon stored the raw wire integers, so each value IS its token. Mains 0 V / 0.00 Hz on every
  // phase, the inverter islanding at 230.0 V / 50.00 Hz on 52.4 V, PV dark. (Influx history since
  // 2020 holds no grid frequency strictly between 0 and 45 Hz, so the gate's bands match reality.)
  const outagePayload =
    "00000,00000,0000,0000,0524,067,+00000,0000,0000,0000,0000,0000,0000,0000,2300,2300,2303,5000,,,,037,055,000,0";
  check("2025-04-13 outage GS round fits the GS shape", responseShapeMismatch("GS", outagePayload) === undefined);
  const { fields, problems } = decodeQueryPayload("GS", outagePayload);
  check(
    "2025-04-13 outage GS round decodes to the stored values",
    problems.length === 0 &&
      fields.ac_input_voltage_r === 0 &&
      fields.ac_input_frequency === 0 &&
      fields.ac_output_voltage_t === 230.3 &&
      fields.ac_output_frequency === 50 &&
      fields.battery_voltage === 52.4 &&
      fields.battery_capacity === 67
  );
  check(
    "grid outage (real 2025-04-13 capture: 0 V / 0 Hz) passes the gate — telemetry must survive exactly then",
    implausibleFieldsIn(fields).length === 0,
    implausibleFieldsIn(fields).join("; ")
  );
}
check(
  "invalid direction option dropped",
  implausibleFieldsIn({ battery_power_direction: "Invalid option: 7" }).length === 1
);
check(
  "setting_change_bit's real-world 'Invalid option: 4' still passes",
  implausibleFieldsIn({ setting_change_bit: "Invalid option: 4" }).length === 0
);
check("surplus unknown tokens pass", implausibleFieldsIn({ unknown_value_in_response_25: "0" }).length === 0);
check(
  "settings readbacks gated: GPMP 15001 W dropped, BATS CV 70 V dropped",
  implausibleFieldsIn({ maximum_feeding_grid_power: 15_001 }).length === 1 &&
    implausibleFieldsIn({ "battery_constant_charge_voltage(c.v.)": 70 }).length === 1
);
// Status answers: a wrong code would page "new fault" or name the wrong fault in the P1
check(
  "status gated: CFS code 100 / slot 9 dropped, an HFS slot 9 dropped",
  implausibleFieldsIn(decodeQueryPayload("CFS", "100,00").fields).length === 1 &&
    implausibleFieldsIn(decodeQueryPayload("CFS", "14,09").fields).length === 1 &&
    implausibleFieldsIn({ ...decodeQueryPayload("HFS", HFS_DATALOGGER_PAYLOAD).fields, fault_record_id: 9 }).length ===
      1
);
check(
  "status gated: an unknown working mode and a WS flag that is neither 0 nor 1 are dropped",
  implausibleFieldsIn(decodeQueryPayload("MOD", "07").fields).length === 1 &&
    implausibleFieldsIn(decodeQueryPayload("WS", WS_DAY_PAYLOAD.replace(/^0/, "2")).fields).length === 1
);
{
  const faultMode = decodeQueryPayload("MOD", MOD_FAULT_PAYLOAD);
  const latestFault = decodeQueryPayload("CFS", CFS_FAULT_14_PAYLOAD);
  const nightWarnings = decodeQueryPayload("WS", WS_NIGHT_PAYLOAD);
  check(
    "the datalogger's MOD/CFS/WS answers decode as the vendor cloud showed them (Fault mode, fault 14 in slot 0)",
    faultMode.fields.working_mode === "Fault mode" &&
      latestFault.fields.latest_fault_code === 14 &&
      latestFault.fields.latest_fault_record_id === 0 &&
      nightWarnings.fields.solar_input_1_loss === "active" &&
      nightWarnings.fields.equalization_state === "active" &&
      nightWarnings.fields.battery_disconnected === "inactive" &&
      !("rapid_shutdown_active" in nightWarnings.fields) &&
      [faultMode, latestFault, nightWarnings].every(decoded => decoded.problems.length === 0)
  );
}

// Coverage: every numeric GS/PS field, and every numeric settings readback a control loop reads,
// must have a range — a new table entry can't silently bypass the gate.
const numericLiveFields = [
  ...PI17_QUERY_RESPONSE_FIELDS.GS,
  ...PI17_QUERY_RESPONSE_FIELDS.PS,
  ...PI17_QUERY_RESPONSE_FIELDS.GPMP,
]
  .filter(spec => spec.reading.kind === "int")
  .map(spec => influxFieldName(spec.name));
for (const name of numericLiveFields) {
  check(`gate has a range for ${name}`, name in PLAUSIBLE_NUMERIC_RANGES);
}
const numericSettingsFieldNames = new Set(
  [...PI17_QUERY_RESPONSE_FIELDS.BATS, ...PI17_QUERY_RESPONSE_FIELDS.GPMP]
    .filter(spec => spec.reading.kind === "int")
    .map(spec => influxFieldName(spec.name))
);
for (const key of [...USB_VALUE_KEYS, "max._ac_charging_current"]) {
  if (!numericSettingsFieldNames.has(key)) continue; // option-valued readbacks are covered by the option check
  check(`gate has a range for consumed settings readback ${key}`, key in PLAUSIBLE_NUMERIC_RANGES);
}
// The status fields an alert reads; a fault record's snapshot values are informational and
// deliberately ungated (a record from a battery-disconnect fault may well read 10.8 V)
const alertReadStatusFields = [
  ...PI17_QUERY_RESPONSE_FIELDS.CFS.filter(spec => spec.reading.kind === "int").map(spec => influxFieldName(spec.name)),
  "fault_record_id",
  "fault_record_fault_code",
];
for (const name of alertReadStatusFields) {
  check(`gate has a range for status field ${name}`, name in PLAUSIBLE_NUMERIC_RANGES);
}
// The gate looks ranges and option checks up by field name alone, whatever the command: two
// commands decoding into the same key would gate one by the other's rules (WS's "Battery under
// voltage" flag would have taken BATS's key, HFS's snapshot GS's ranges).
{
  const decodedKeys = Object.values(PI17_QUERY_RESPONSE_FIELDS).flatMap(specs =>
    specs.filter(spec => spec.reading.kind !== "exclude").map(spec => influxFieldName(spec.name))
  );
  const duplicateKeys = decodedKeys.filter((key, index) => decodedKeys.indexOf(key) !== index);
  check("decoded field names are unique across all commands", duplicateKeys.length === 0, duplicateKeys.join(", "));
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all pi17ResponseSafety selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
