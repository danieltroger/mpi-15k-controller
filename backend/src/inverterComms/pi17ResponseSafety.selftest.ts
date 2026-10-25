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
import {
  ACK_FRAME,
  NAK_FRAME,
  classifyFrame,
  concatenateBuffers,
  crc16XModem,
  crcAsTheInverterSendsIt,
  createFrameAccumulator,
} from "./pi17Frames.ts";
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

const FIXTURES_BY_COMMAND: Readonly<Record<Pi17QueryCommandName, readonly Buffer[]>> = {
  GS: [GS_LIVE_1, GS_LIVE_2, GS_LIVE_3, GS_REFERENCE],
  PS: [PS_LIVE_1, PS_LIVE_2, PS_REFERENCE],
  BATS: [BATS_LIVE],
  HECS: [HECS_REFERENCE],
  GPMP: [GPMP_REFERENCE],
  MOD: [MOD_REFERENCE],
};
const ALL_COMMANDS: readonly Pi17QueryCommandName[] = ["GS", "PS", "BATS", "HECS", "GPMP", "MOD"];

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

// ---------- the firmware's CRC byte bump (found at the second cutover attempt, 2026-10-25) ----------
// The inverter bumps a CRC byte that would be 0x28/0x0D/0x0A (mpp-solar's crcPI: also 0x00) by one.
check("bump: live pair computed 0x5328 → sent 0x5329", crcAsTheInverterSendsIt(0x5328) === 0x5329);
check("bump: live pair computed 0x0DEC → sent 0x0EEC", crcAsTheInverterSendsIt(0x0dec) === 0x0eec);
check("bump: both bytes", crcAsTheInverterSendsIt(0x0a28) === 0x0b29 && crcAsTheInverterSendsIt(0x0000) === 0x0101);
check(
  "bump: ordinary CRCs untouched",
  crcAsTheInverterSendsIt(0x1234) === 0x1234 && crcAsTheInverterSendsIt(0x0bc2) === 0x0bc2
);
function dataFrameWithCrc(payload: string, crcOf: (body: Buffer) => number): Buffer {
  const body = latin1(`^D${String(payload.length + 3).padStart(3, "0")}${payload}`);
  const crc = crcOf(body);
  return concatenateBuffers([body, Buffer.from([crc >> 8, crc & 0xff, 0x0d])]);
}
/** A live-shaped GS payload whose plain XModem CRC has `crcByte` in the high or low position */
function gsPayloadWhosePlainCrcHas(crcByte: number, position: "high" | "low"): string | undefined {
  const tokens = payloadOf(GS_LIVE_1).split(",");
  for (let componentTemperature = 0; componentTemperature <= 150; componentTemperature++) {
    for (let externalTemperature = 0; externalTemperature <= 150; externalTemperature++) {
      tokens[22] = String(componentTemperature).padStart(3, "0");
      tokens[23] = String(externalTemperature).padStart(3, "0");
      const payload = tokens.join(",");
      const crc = crc16XModem(latin1(`^D${String(payload.length + 3).padStart(3, "0")}${payload}`));
      if ((position === "high" ? crc >> 8 : crc & 0xff) === crcByte) return payload;
    }
  }
  return undefined;
}
for (const crcByte of [0x00, 0x0a, 0x0d, 0x28]) {
  for (const position of ["high", "low"] as const) {
    const label = `0x${crcByte.toString(16).padStart(2, "0")} as the ${position} CRC byte`;
    const payload = gsPayloadWhosePlainCrcHas(crcByte, position);
    check(`bump: found a GS payload with ${label}`, payload !== undefined);
    if (payload === undefined) continue;
    const asSent = dataFrameWithCrc(payload, body => crcAsTheInverterSendsIt(crc16XModem(body)));
    check(
      `bump: frame with ${label} bumped (as the firmware sends it) is accepted`,
      classifyFrame(asSent).kind === "data"
    );
    const plain = dataFrameWithCrc(payload, crc16XModem);
    check(`bump: frame with ${label} unbumped is accepted too`, classifyFrame(plain).kind === "data");
    const corrupted = concatenateBuffers([asSent]);
    corrupted[12] ^= 0x01;
    check(`bump: a corrupted payload with ${label} is still rejected`, classifyFrame(corrupted).kind === "invalid");
    const { frames } = createFrameAccumulator().push(concatenateBuffers([asSent, ACK_FRAME]));
    check(
      `bump: frame with ${label} survives reassembly`,
      frames.length === 2 && classifyFrame(frames[0]!).kind === "data" && classifyFrame(frames[1]!).kind === "ack"
    );
  }
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
check(
  "grid outage (0 V, 0 Hz on every phase) passes — telemetry must survive exactly then",
  gateVerdictFor({ ac_input_voltage_r: 0, ac_input_voltage_s: 0, ac_input_voltage_t: 0, ac_input_frequency: 0 })
    .length === 0
);
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

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all pi17ResponseSafety selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
