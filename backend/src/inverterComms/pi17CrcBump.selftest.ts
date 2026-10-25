/**
 * Pure self-test for the firmware's CRC byte bump (found at the second production cutover attempt,
 * 2026-10-25). No hardware. Run from backend/ with:
 *   yarn node src/inverterComms/pi17CrcBump.selftest.ts
 *
 * The firmware sends a CRC byte that would be 0x0A / 0x0D / 0x28 as that byte + 1, each byte on its
 * own (0x00 is NOT bumped — see storedCrcMatches in pi17Frames.ts for the 2.37 % evidence). The
 * first fix only accepted "both bytes plain" or "every special byte bumped incl. 0x00", which still
 * rejected 6 of 65 536 CRC values (000a 000d 0028 0a00 0d00 2800) — ~13 frames/day, each a likely
 * false "Inverter query failed" P2 because the retry repeats the payload.
 */
import process from "process";
import {
  ACK_FRAME,
  classifyFrame,
  concatenateBuffers,
  crc16XModem,
  crcAsTheInverterSendsIt,
  createFrameAccumulator,
  storedCrcMatches,
} from "./pi17Frames.ts";

const fails: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!cond) fails.push(name);
}

function latin1(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

/** Independent of the implementation under test: the Voltronic reference rule, three byte values */
const REFERENCE_BUMPED_BYTES = new Set([0x0a, 0x0d, 0x28]);
function referenceFirmwareRendering(computedCrc: number): number {
  return (referenceBumpedByte(computedCrc >> 8) << 8) | referenceBumpedByte(computedCrc & 0xff);
}
function referenceBumpedByte(crcByte: number): number {
  return REFERENCE_BUMPED_BYTES.has(crcByte) ? crcByte + 1 : crcByte;
}
const hex4 = (value: number) => `0x${value.toString(16).padStart(4, "0")}`;

// A live GS answer (2026-10-25); its temperature tokens 21-23 are varied below to hit chosen CRCs
const GS_LIVE_PAYLOAD =
  "03482,03256,0021,0026,0532,073,-00098,2363,2352,2358,5004,0000,0000,0000,2361,2352,2358,5008,,,,036,053,000,0";

// ---------- the live evidence ----------
check("live pair: computed 0x5328 is sent as 0x5329", storedCrcMatches(0x5328, 0x5329));
check("live pair: computed 0x0DEC is sent as 0x0EEC", storedCrcMatches(0x0dec, 0x0eec));
check(
  "crcAsTheInverterSendsIt reproduces both live pairs",
  crcAsTheInverterSendsIt(0x5328) === 0x5329 && crcAsTheInverterSendsIt(0x0dec) === 0x0eec
);

// ---------- the six mixed cases the first fix rejected ----------
for (const [computed, sent] of [
  [0x000a, 0x000b],
  [0x000d, 0x000e],
  [0x0028, 0x0029],
  [0x0a00, 0x0b00],
  [0x0d00, 0x0e00],
  [0x2800, 0x2900],
] as const) {
  check(`mixed case: computed ${hex4(computed)} sent as ${hex4(sent)} is accepted`, storedCrcMatches(computed, sent));
  check(`mixed case: ${hex4(computed)} renders as ${hex4(sent)}`, crcAsTheInverterSendsIt(computed) === sent);
}

// ---------- 0x00 is not bumped ----------
check("0x00 renders plain", crcAsTheInverterSendsIt(0x0000) === 0x0000 && crcAsTheInverterSendsIt(0x1200) === 0x1200);
check("0x00 bumped to 0x01 is NOT accepted (high)", !storedCrcMatches(0x0012, 0x0112));
check("0x00 bumped to 0x01 is NOT accepted (low)", !storedCrcMatches(0x1200, 0x1201));

// ---------- exhaustive sweep over every possible computed CRC ----------
// For each value, among the 16 stored candidates within -1..+2 of each byte exactly the plain value
// and the per-byte bumps of special bytes are accepted — the rule only ever loosens special bytes.
{
  const sweepFailures: string[] = [];
  for (let computed = 0; computed <= 0xffff; computed++) {
    const highByte = computed >> 8;
    const lowByte = computed & 0xff;
    const accepted: number[] = [];
    for (const highDelta of [-1, 0, 1, 2]) {
      for (const lowDelta of [-1, 0, 1, 2]) {
        const stored = (((highByte + highDelta) & 0xff) << 8) | ((lowByte + lowDelta) & 0xff);
        if (storedCrcMatches(computed, stored)) accepted.push(stored);
      }
    }
    const expectedAcceptedCount =
      (REFERENCE_BUMPED_BYTES.has(highByte) ? 2 : 1) * (REFERENCE_BUMPED_BYTES.has(lowByte) ? 2 : 1);
    const firmwareRendering = referenceFirmwareRendering(computed);
    if (
      accepted.length !== expectedAcceptedCount ||
      !accepted.includes(computed) ||
      !accepted.includes(firmwareRendering) ||
      crcAsTheInverterSendsIt(computed) !== firmwareRendering
    ) {
      sweepFailures.push(hex4(computed));
    }
  }
  check(
    "exhaustive: all 65 536 CRCs accept exactly plain + per-byte bumps, and render like the reference firmware",
    sweepFailures.length === 0,
    sweepFailures.slice(0, 10).join(" ")
  );
}

// ---------- end to end: real-shaped frames through classifyFrame and the accumulator ----------
function crc16XModemContinued(initialCrc: number, bytes: Buffer): number {
  let crc = initialCrc;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
/** A live-shaped GS frame body (^D… up to the CRC) whose computed CRC satisfies `wanted`, or undefined */
function gsBodyWhoseCrc(wanted: (computedCrc: number) => boolean): Buffer | undefined {
  const tokens = GS_LIVE_PAYLOAD.split(",");
  const header = `^D${String(GS_LIVE_PAYLOAD.length + 3).padStart(3, "0")}`;
  const fixedPrefix = latin1(`${header}${tokens.slice(0, 21).join(",")},`);
  const prefixCrc = crc16XModem(fixedPrefix);
  for (let innerTemperature = 0; innerTemperature <= 150; innerTemperature++) {
    for (let componentTemperature = 0; componentTemperature <= 150; componentTemperature++) {
      for (let externalTemperature = 0; externalTemperature <= 150; externalTemperature++) {
        const suffix = latin1(
          [innerTemperature, componentTemperature, externalTemperature]
            .map(temperature => String(temperature).padStart(3, "0"))
            .join(",") + `,${tokens[24]}`
        );
        if (wanted(crc16XModemContinued(prefixCrc, suffix))) return concatenateBuffers([fixedPrefix, suffix]);
      }
    }
  }
  return undefined;
}
function framed(body: Buffer, crc: number): Buffer {
  return concatenateBuffers([body, Buffer.from([crc >> 8, crc & 0xff, 0x0d])]);
}
const endToEndTargets: { label: string; wanted: (crc: number) => boolean }[] = [
  ...[0x000a, 0x000d, 0x0028, 0x0a00, 0x0d00, 0x2800].map(target => ({
    label: `mixed CRC ${hex4(target)}`,
    wanted: (crc: number) => crc === target,
  })),
  ...[0x0a, 0x0d, 0x28].flatMap(special => [
    { label: `0x${special.toString(16)} as the high byte`, wanted: (crc: number) => crc >> 8 === special },
    { label: `0x${special.toString(16)} as the low byte`, wanted: (crc: number) => (crc & 0xff) === special },
  ]),
];
for (const { label, wanted } of endToEndTargets) {
  const body = gsBodyWhoseCrc(wanted);
  check(`frames: found a live-shaped GS payload with ${label}`, body !== undefined);
  if (!body) continue;
  const computed = crc16XModem(body);
  const asSent = framed(body, referenceFirmwareRendering(computed));
  check(`frames: ${label}, sent as the firmware does, classifies as data`, classifyFrame(asSent).kind === "data");
  check(`frames: ${label}, unbumped, classifies as data too`, classifyFrame(framed(body, computed)).kind === "data");
  const corrupted = concatenateBuffers([asSent]);
  corrupted[12] ^= 0x01;
  check(`frames: ${label} with a corrupted payload is still invalid`, classifyFrame(corrupted).kind === "invalid");
  const { frames } = createFrameAccumulator().push(concatenateBuffers([asSent, ACK_FRAME]));
  check(
    `frames: ${label} survives reassembly`,
    frames.length === 2 && classifyFrame(frames[0]!).kind === "data" && classifyFrame(frames[1]!).kind === "ack"
  );
}

console.log(`\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all pi17CrcBump selftests passed"}`);
process.exit(fails.length ? 1 : 0);
