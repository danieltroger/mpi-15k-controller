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
/**
 * All nine fault-record slots as the controller read them at its 2026-10-26 06:48 UTC boot (HFS00
 * first). Every record names slot 00 in its own id field. By their snapshots: F14 ×3 (slot 0 the
 * 2026-10-21 latch at 54.4 V, 4 the 2025-10-30 one at 52.9 V, 7 by elimination the 2025-01-08
 * one), F12 ×4 (1–3 trips of the 2024-05 empty-pack episode at 41.0–41.2 V, 8 a record reading
 * 10.8 V), F23 (5, the 2025-04-13 outage overload: grid 0 V, 114 % load) and F57 (6, the
 * 2025-06-30 over-temperature: component 99 °C).
 */
export const HFS_BOOT_RECORDS: readonly string[] = [
  "00,14,759900010005,66,01070,00000,00014,02371,2354,2350,5000,0544,7599,+0365,2354,2352,5003,0094,00069,00189,00002,042,059,000,000",
  "00,12,759900560005,04,05850,00012,00080,02313,2296,2298,4996,0410,7599,+0309,2294,2300,4996,0115,00045,00138,00001,029,046,000,000",
  "00,12,759900070005,15,05913,00009,00088,02318,2358,2386,4998,0411,7599,+0328,2356,0000,5001,1321,00237,00166,00013,029,046,000,000",
  "00,12,759900160005,41,05940,00011,00085,02378,2326,2367,4994,0412,7599,+0380,2326,2367,4992,0309,00255,00236,00005,029,046,000,000",
  "00,14,759900550005,47,01105,00000,00009,02236,2197,2172,4993,0529,7599,+0236,2193,2174,4993,0139,00250,00203,00003,039,056,000,000",
  "00,23,759900310003,37,06947,00000,00053,00000,0000,0000,0000,0523,7599,+0303,2300,2300,5000,5706,05694,05745,00114,048,071,000,000",
  "00,57,759900560005,84,06296,00000,00000,02464,2468,2466,5002,0518,7599,+0466,2462,2462,4996,0221,00247,00221,00004,080,099,000,000",
  "00,14,759900410005,39,01124,00000,00017,02376,2245,2380,5000,0513,7599,+0378,2251,2365,5013,0095,00375,00189,00004,036,058,000,000",
  "00,12,759900540005,62,06392,00000,00094,02294,2363,2277,4998,0108,7599,+0296,2361,2279,4996,1612,00611,01046,00021,035,051,000,000",
];

/**
 * What the WiFi datalogger's upload labelled HFS00: a fault 12 record from the 2024-05 empty-pack
 * episode (battery 41.0 V). The controller read this exact record from slot 01 on 2026-10-26.
 */
export const HFS_DATALOGGER_PAYLOAD = HFS_BOOT_RECORDS[1]!;
