/**
 * Which response frame belongs to which command — pure, no I/O.
 *
 * PI17 data frames do NOT echo the command they answer, so "the first valid frame belongs to the
 * command in flight" is only true while request and response stay perfectly in lockstep. They
 * didn't at the first production cutover (2026-10-25 14:01–14:05 UTC): writes stuck behind the
 * libuv threadpool reached the wire seconds late, retries doubled up, and a PS response that
 * arrived while GS was in flight decoded through the GS table — PS's "AC input active power S/T"
 * and "total" tokens became battery_voltage −30.9 V, battery_capacity −202 and battery_current
 * −65.7 A, which dropped a false "empty" SOC anchor and paged a battery-undervoltage P2.
 *
 * So every frame is checked against what the in-flight command can possibly answer: setters only
 * ACK/NAK, queries only data frames of that query's shape. The shapes below are disjoint for every
 * pair of commands (token counts where they differ; payload length for GS/HFS, PS/WS and the
 * single-token GPMP/MOD) — pi17ResponseSafety.selftest.ts asserts that pairwise, so a frame that
 * matches its in-flight command's shape cannot be another command's response.
 */
import type { ClassifiedFrame } from "./pi17Frames.ts";
import type { Pi17QueryCommandName } from "./pi17Protocol.types.ts";

export type InclusiveRange = { min: number; max: number };

export type ResponseShape = {
  /** Comma-separated tokens in the payload (empty tokens count — the firmware sends several) */
  tokenCount: InclusiveRange;
  /** Payload bytes between the ^D{lll} header and the CRC */
  payloadLength: InclusiveRange;
};

export const PI17_RESPONSE_SHAPES: Readonly<Record<Pi17QueryCommandName, ResponseShape>> = {
  // 25 tokens in every capture (live ^D112 frames on 2026-10-25, the ^D110 reference); the spec's
  // ^D114 has a 26th. The retired daemon's unknown_value_in_response_25/_26 were not real tokens
  // but mpp-solar splitting a CRC byte that happened to be "," (0x2C): 0.794 % of GS points vs
  // 2/256, 1.7e-5 vs 1/65536. Two spare tokens stay allowed anyway. Payloads are fixed-width,
  // zero-padded numbers: 107 B reference, 109 B live, 111 B for the spec's 26 tokens; with the three
  // reserved AC-output currents filled (4 digits each) plus a 27th token it stays ≤ 125 B, and no
  // field in Influx's whole history outgrew its width. So the cap sits at 127: HFS shares GS's
  // 25-token count and is told apart by its fixed 130-byte payload.
  GS: { tokenCount: { min: 25, max: 27 }, payloadLength: { min: 95, max: 127 } },
  // 22 tokens in every capture (live ^D107, reference ^D101); one surplus token tolerated.
  PS: { tokenCount: { min: 22, max: 23 }, payloadLength: { min: 85, max: 125 } },
  // The MPI 15K sends the first 18 of the table's 21 fields (73 B payload live); other PI17
  // machines send all 21.
  BATS: { tokenCount: { min: 16, max: 21 }, payloadLength: { min: 50, max: 110 } },
  // 8 option tokens + the reserved one ("00,0,0,0,0,0,0,0,0"); widened in case the reserved field
  // is longer on this firmware — still disjoint from everything else.
  HECS: { tokenCount: { min: 8, max: 11 }, payloadLength: { min: 15, max: 40 } },
  // Single tokens told apart by width: GPMP is a 5-digit wattage ("15000"), MOD a 2-digit code ("05").
  GPMP: { tokenCount: { min: 1, max: 1 }, payloadLength: { min: 4, max: 6 } },
  MOD: { tokenCount: { min: 1, max: 1 }, payloadLength: { min: 1, max: 3 } },
  // The status queries, as this inverter answered the WiFi datalogger (raw uploads, 2026-10-23..25):
  // CFS "14,00" (^D008), the only 2-token answer of all.
  CFS: { tokenCount: { min: 2, max: 2 }, payloadLength: { min: 3, max: 7 } },
  // WS: 23 single-digit flags (^D048, 45 B); the spec lists 24 (47 B), mpp-solar's fixture 22 plus
  // a trailing empty token. Shares token counts with PS but is under half its payload length.
  WS: { tokenCount: { min: 22, max: 24 }, payloadLength: { min: 40, max: 55 } },
  // HFS: 25 fixed-width tokens, 130 B (^D133) in the spec and live. Same token count as GS, which
  // is why GS's payload cap above stops below 128.
  HFS: { tokenCount: { min: 25, max: 25 }, payloadLength: { min: 128, max: 135 } },
};

/**
 * A slot of the fault-record flash that holds nothing may well be declined: the datalogger only
 * ever read slot 00, so nobody has seen what slots 01–08 answer. Accepting the NAK costs ~50 ms
 * instead of a 3 s timeout + retry per empty slot. The price, both ways:
 * - a setter NAK so late that it outlived the setter's retry and the quiet line after it would read
 *   as "no record" for an HFS slot — harmless for an informational read (the setter already failed
 *   loudly);
 * - an HFS NAK can now reach a setter. An HFS answered by a NAK always leaves the line needing quiet
 *   (serialExchange.ts), so a trailing duplicate is flushed; only an HFS answer later than both
 *   attempts (> ~6.3 s) and the 300 ms quiet line after them could still land on a setter — the
 *   same residual risk a late setter NAK already carries.
 */
const QUERIES_THE_INVERTER_MAY_DECLINE: ReadonlySet<Pi17QueryCommandName> = new Set(["HFS"]);

/** What the command currently in flight can legitimately be answered with. */
export type ExchangeExpectation = { kind: "query"; command: Pi17QueryCommandName } | { kind: "setter" };

/** Why `payloadText` cannot be a response to `command`, or undefined when it fits the command's shape. */
export function responseShapeMismatch(command: Pi17QueryCommandName, payloadText: string): string | undefined {
  const shape = PI17_RESPONSE_SHAPES[command];
  const tokenCount = payloadText.split(",").length;
  if (!isWithin(shape.tokenCount, tokenCount)) {
    return `${tokenCount} tokens, ${command} answers with ${describeRange(shape.tokenCount)}`;
  }
  if (!isWithin(shape.payloadLength, payloadText.length)) {
    return `${payloadText.length}-byte payload, ${command} answers with ${describeRange(shape.payloadLength)} bytes`;
  }
  return undefined;
}

/**
 * Why `frame` cannot be the answer to the exchange in flight, or undefined when it can. Invalid
 * frames are the framing layer's business and never reach this.
 */
export function frameMismatchForExpectation(
  expectation: ExchangeExpectation,
  frame: Exclude<ClassifiedFrame, { kind: "invalid" }>
): string | undefined {
  if (expectation.kind === "setter") {
    return frame.kind === "data" ? "data frame while a setter is in flight (a late query response)" : undefined;
  }
  if (frame.kind === "nak" && QUERIES_THE_INVERTER_MAY_DECLINE.has(expectation.command)) return undefined;
  if (frame.kind !== "data") {
    return `${frame.kind.toUpperCase()} while query ${expectation.command} is in flight (a late setter response)`;
  }
  const mismatch = responseShapeMismatch(expectation.command, frame.payloadText);
  return mismatch === undefined ? undefined : `not a ${expectation.command} response: ${mismatch}`;
}

function isWithin(range: InclusiveRange, value: number): boolean {
  return value >= range.min && value <= range.max;
}

function describeRange(range: InclusiveRange): string {
  return range.min === range.max ? `${range.min}` : `${range.min}–${range.max}`;
}
