/**
 * PI17 wire framing — pure byte-level functions, no I/O.
 *
 * Commands (all live-verified on the real MPI 15K on 2026-07-18):
 *   query   ^P{len:03}{CMD}\r   e.g. ^P003GS  ^P005BATS
 *   setter  ^S{len:03}{CMD}\r   e.g. ^S015MCHGV0580,0580  ^S011MUCHGC0100  ^S005EDA1
 * where len = command length + 1. Commands carry NO CRC (the energy-history ED/EM/EY/EH family
 * uses a different QUERYEN form with an ASCII-sum checksum — unused here, see pi17FieldTables.ts).
 *
 * Responses end with \r; the two bytes before it are CRC16-XModem (poly 0x1021, init 0) over all
 * preceding bytes. ACK = ^1<crc>\r, NAK = ^0<crc>\r, data = ^D{lll}payload<crc>\r where lll is the
 * byte count after the 5-byte header (payload + 2 CRC bytes + \r) — verified against every live
 * capture, and what makes frame extraction immune to a CRC byte that happens to be 0x0d.
 */

const CARRIAGE_RETURN = 0x0d;
const CARET = 0x5e; // "^"
const ACK_NAK_FRAME_LENGTH = 5; // ^1 or ^0, 2 CRC bytes, \r
const DATA_FRAME_MIN_LENGTH = 8; // ^D{lll} header (5) + 2 CRC bytes + \r, with an empty payload
/**
 * Longest routine response is ~120 bytes and a declared length can never exceed 999 — anything
 * that grows past this without producing a frame is line garbage and gets resynced away.
 */
const MAX_BUFFERED_BYTES = 5 + 999;

export const ACK_FRAME = Buffer.from("^1\x0b\xc2\r", "latin1");
export const NAK_FRAME = Buffer.from("^0\x1b\xe3\r", "latin1");

// The pinned @types/node 20 predates TS 5.9's generic typed arrays, which makes Buffer
// structurally incompatible with lib Uint8Array parameters (their slice() return types differ) —
// so everything here is typed in terms of Buffer, with these two helpers replacing
// Buffer.equals/Buffer.concat whose declared parameters hit exactly that incompatibility.
export function buffersEqual(first: Buffer, second: Buffer): boolean {
  if (first.length !== second.length) return false;
  for (let byteIndex = 0; byteIndex < first.length; byteIndex++) {
    if (first[byteIndex] !== second[byteIndex]) return false;
  }
  return true;
}

export function concatenateBuffers(parts: readonly Buffer[]): Buffer {
  const combined = Buffer.allocUnsafe(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

export function crc16XModem(bytes: Buffer): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function buildQueryFrame(command: string): Buffer {
  return Buffer.from(`^P${String(command.length + 1).padStart(3, "0")}${command}\r`, "latin1");
}

export function buildSetterFrame(command: string): Buffer {
  return Buffer.from(`^S${String(command.length + 1).padStart(3, "0")}${command}\r`, "latin1");
}

export type ClassifiedFrame =
  | { kind: "ack" }
  | { kind: "nak" }
  | { kind: "data"; payloadText: string }
  | { kind: "invalid"; reason: string };

export function classifyFrame(frame: Buffer): ClassifiedFrame {
  if (buffersEqual(frame, ACK_FRAME)) return { kind: "ack" };
  if (buffersEqual(frame, NAK_FRAME)) return { kind: "nak" };
  if (
    frame.length >= DATA_FRAME_MIN_LENGTH &&
    frame[0] === CARET &&
    frame[1] === 0x44 /* D */ &&
    frame[frame.length - 1] === CARRIAGE_RETURN
  ) {
    const computedCrc = crc16XModem(frame.subarray(0, -3));
    const storedCrc = (frame[frame.length - 3]! << 8) | frame[frame.length - 2]!;
    if (computedCrc !== storedCrc) {
      return {
        kind: "invalid",
        reason: `data frame CRC mismatch (computed 0x${computedCrc.toString(16)}, stored 0x${storedCrc.toString(16)}) in ${previewOf(frame)}`,
      };
    }
    return { kind: "data", payloadText: frame.subarray(5, -3).toString("latin1") };
  }
  return { kind: "invalid", reason: `unrecognized ${frame.length}-byte frame ${previewOf(frame)}` };
}

export type FrameAccumulatorPushResult = {
  /** Complete frames, in arrival order (still need classifyFrame — extraction doesn't CRC-check) */
  frames: Buffer[];
  /** Bytes thrown away while resyncing (line noise, remnants of a timed-out response) */
  discardedByteCount: number;
  /** Human-readable notes about anything abnormal, for the caller to log */
  problems: string[];
};

/**
 * Reassembles the 2400-baud dribble into complete frames. ACK/NAK are fixed 5 bytes; data frames
 * are cut at their declared length (NOT at the first \r — a CRC byte is 0x0d in ~1 in 128 frames,
 * which would corrupt naive \r-splitting every few minutes at our poll rate). \r is only used as
 * a fallback resync point when a declared length turns out not to line up with a terminator.
 */
export function createFrameAccumulator() {
  let buffered = Buffer.alloc(0);
  return {
    push(chunk: Buffer): FrameAccumulatorPushResult {
      buffered = concatenateBuffers(buffered.length ? [buffered, chunk] : [chunk]);
      const result: FrameAccumulatorPushResult = { frames: [], discardedByteCount: 0, problems: [] };
      while (true) {
        const frameStart = buffered.indexOf(CARET);
        if (frameStart === -1) {
          // No frame can ever start without a ^ — everything buffered is noise
          result.discardedByteCount += buffered.length;
          buffered = Buffer.alloc(0);
          break;
        }
        if (frameStart > 0) {
          result.discardedByteCount += frameStart;
          buffered = buffered.subarray(frameStart);
        }
        if (buffered.length < 2) break; // wait for the frame-kind byte
        const frameKind = buffered[1];
        if (frameKind === 0x31 /* 1 */ || frameKind === 0x30 /* 0 */) {
          if (buffered.length < ACK_NAK_FRAME_LENGTH) break;
          result.frames.push(buffered.subarray(0, ACK_NAK_FRAME_LENGTH));
          buffered = buffered.subarray(ACK_NAK_FRAME_LENGTH);
          continue;
        }
        if (frameKind !== 0x44 /* D */) {
          result.problems.push(`unrecognized frame start 0x5e 0x${frameKind!.toString(16)} — resyncing`);
          result.discardedByteCount += 1;
          buffered = buffered.subarray(1);
          continue;
        }
        if (buffered.length < 5) break; // wait for the full ^D{lll} header
        const declaredLengthText = buffered.subarray(2, 5).toString("latin1");
        if (!/^\d{3}$/.test(declaredLengthText)) {
          result.problems.push(`^D with non-numeric length ${JSON.stringify(declaredLengthText)} — resyncing`);
          result.discardedByteCount += 1;
          buffered = buffered.subarray(1);
          continue;
        }
        const totalFrameLength = 5 + Number(declaredLengthText);
        if (buffered.length >= totalFrameLength && buffered[totalFrameLength - 1] === CARRIAGE_RETURN) {
          result.frames.push(buffered.subarray(0, totalFrameLength));
          buffered = buffered.subarray(totalFrameLength);
          continue;
        }
        if (buffered.length >= totalFrameLength) {
          // The declared length doesn't land on a \r. Never seen from the real firmware (every
          // live capture declares exactly payload+3), but mpp-solar's own HECS test fixture
          // carries this typo — fall back to the next \r and let the CRC check decide.
          const terminatorIndex = buffered.indexOf(CARRIAGE_RETURN, 5);
          if (terminatorIndex !== -1) {
            result.problems.push(
              `^D declared ${Number(declaredLengthText)} bytes but no \\r there — recovered a ${terminatorIndex + 1}-byte frame by terminator scan`
            );
            result.frames.push(buffered.subarray(0, terminatorIndex + 1));
            buffered = buffered.subarray(terminatorIndex + 1);
            continue;
          }
        }
        if (buffered.length > MAX_BUFFERED_BYTES) {
          result.problems.push(`buffered ${buffered.length} bytes without completing a frame — resyncing`);
          result.discardedByteCount += 1;
          buffered = buffered.subarray(1);
          continue;
        }
        break; // incomplete data frame — wait for more bytes
      }
      return result;
    },
    /** Drop everything buffered (before a fresh command, or after a response timeout). Returns the byte count dropped. */
    flush(): number {
      const droppedByteCount = buffered.length;
      buffered = Buffer.alloc(0);
      return droppedByteCount;
    },
    bufferedByteCount(): number {
      return buffered.length;
    },
  };
}

function previewOf(frame: Buffer): string {
  const shown = frame.subarray(0, 24);
  return `${JSON.stringify(shown.toString("latin1"))}${frame.length > shown.length ? "…" : ""} (hex ${shown.toString("hex")})`;
}
