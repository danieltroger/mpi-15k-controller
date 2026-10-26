/**
 * Real status answers of this MPI 15K (MOD / CFS / WS / HFS) for the selftests: the payloads the
 * WiFi datalogger uploaded to the vendor cloud on 2026-10-23..25 (fault_forensics.md §3.2), during
 * and after the fault 14 latch. The cloud kept the payloads but not the CRC bytes, so frames are
 * rebuilt around them the way the firmware frames its answers (bumped CRC bytes included).
 */
import { concatenateBuffers, crc16XModem, crcAsTheInverterSendsIt } from "./pi17Frames.ts";

export function dataFrameAsTheInverterSendsIt(payload: string): Buffer {
  const body = Buffer.from(`^D${String(payload.length + 3).padStart(3, "0")}${payload}`, "latin1");
  const crc = crcAsTheInverterSendsIt(crc16XModem(body));
  return concatenateBuffers([body, Buffer.from([crc >> 8, crc & 0xff, 0x0d])]);
}

/** Every upload from 2026-10-21 04:17 to 2026-10-23 15:26 UTC */
export const MOD_FAULT_PAYLOAD = "04";
/** From 15:31 UTC on 2026-10-23, after the AC-side interruption */
export const MOD_HYBRID_PAYLOAD = "05";
/** Fault 14 in flash slot 00 — unchanged before and after the recovery (CFS is sticky) */
export const CFS_FAULT_14_PAYLOAD = "14,00";
/** At night: A/B (solar input 1/2 loss) and the 23rd flag (equalization state) */
export const WS_NIGHT_PAYLOAD = "1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1";
/** In daylight, also all through the latch: WS never showed this fault */
export const WS_DAY_PAYLOAD = "0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0";
/** Slot 00 holds a fault 12 record (likely 2024-05-09); its time and snapshot look misaligned */
export const HFS00_PAYLOAD =
  "00,12,759900560005,04,05850,00012,00080,02313,2296,2298,4996,0410,7599,+0309,2294,2300,4996,0115,00045,00138,00001,029,046,000,000";
