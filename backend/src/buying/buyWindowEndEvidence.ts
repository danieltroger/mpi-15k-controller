/**
 * What the buy-window end step-down may conclude from the hall, a BATS/HECS readback and #62's per-field
 * write chains (fieldWriteChains.ts), pure. The state machine acting on it: buyWindowEndStepDown.ts.
 *
 * Writes commit in send order, seconds after their ACK. The chains the session hands over hold each
 * field's writes that no readback has proven landed yet, judged with the satisfied drop's trust window
 * (DROP_TRUST_COMMIT_WINDOW_MS, 90 s), not the confirm's 30 s: a false "landed" here releases EDB0 ahead
 * of a full-current commit, the F14 setup, while a withheld proof only holds AC charging at the cap until
 * the alternate cap, a fresh readback or the timeout settles it.
 */
import type { FieldWrite } from "../inverterComms/fieldWriteChains.ts";
import type { AcChargingLimitReadback, BuyWindowEndInputs, LimitEvidence } from "./buyWindowEndStepDown.types.ts";

/**
 * The AC charging limit the inverter holds whenever it isn't buying (MUCHGC0100), in case it glitches
 * and charges from the grid although AC charging is disabled — and the first step of every window end.
 */
export const IDLE_AC_CHARGING_LIMIT_AMPS = 10;
/**
 * How far above the idle limit (plus whatever PV can add) the hall current may sit and still count as
 * "the cap is in effect". Measured at small AC charging limits (Influx, 2025-11 → 2026-04, the hall
 * sensor 2 at 4 Hz): hall − (limit + PV watts / battery volts) has a night median of +0.5 A (p95 +2.7 A)
 * and a daytime p95 of +8.4 A, with excursions to ~+15 A while PV ramps (the GS PV reading lags the
 * hall). With 20 A the condition held for 3 s within ≤ 8.8 s from every start point of every such
 * stretch; 0 A left 3 657 start points never satisfied. 30 A at night is still an ~8× smaller step
 * than the 240–284 A of the three F14 window ends.
 */
export const HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS = 20;
/**
 * The hall current must stay within the allowance this long. Across 130 committed in-window MUCHGC
 * step-downs (AC charging staying on) the current fell in one go — 10–90 % in a median 0.5 s, p90
 * 0.75 s — and was within max(5 A, 5 %) of its new level after a median 0.5 s, p90 1.25 s, with brief
 * ringing (e.g. 287 → 6 → 39 → 22 A over ~1.5 s with 1.6 kW PV, 2026-04-03).
 */
export const SETTLED_FOR_MS = 3_000;
/**
 * The cap one step lower, as MUCHGC0090, for a readback that can't prove the cap (A→B→A: "10 A" after
 * 10 → 261 → 10) and for the extension. Writes commit in send order, so a readback showing a value no
 * earlier write had proves every one of them landed — no commit window assumed. A stale 10 A readback
 * can't satisfy it either, so the session sends it at once instead of dropping it as already applied,
 * and the identical-setter gate of MUCHGC0100 doesn't hold it. The inverter then idles at 9 A instead
 * of 10 A until the next window, the same guard.
 */
export const ALTERNATE_CAP_AMPS = 9;

/**
 * The cap counts as shown only when the readback is at or below it and the limit's write chain holds no
 * unproven write above it: one may still commit after the readback (a slow commit, or A→B→A where
 * "10 A" can mean "nothing landed yet").
 */
export function limitEvidenceOf(
  readback: AcChargingLimitReadback | undefined,
  unprovenLimitWrites: readonly FieldWrite[]
): LimitEvidence {
  if (!readback) return "none";
  if (readback.amps > IDLE_AC_CHARGING_LIMIT_AMPS) return "shows_higher_limit";
  if (higherLimitMayLand(unprovenLimitWrites)) return "higher_limit_unproven";
  return "shows_cap";
}

/**
 * Battery charging can only come from the AC charger and PV, so with the cap in effect the hall can't
 * exceed cap + PV/V (PV/V overstates PV's share: MPPT losses, and PV also feeds the house). Grid import
 * minus house load is deliberately not used: PV feeding the house directly makes it meaningless.
 */
export function allowedHallAmps(inputs: Pick<BuyWindowEndInputs, "solarWatts" | "batteryVoltage">): number {
  const solarAmps =
    inputs.solarWatts && inputs.batteryVoltage ? Math.max(0, inputs.solarWatts) / inputs.batteryVoltage : 0;
  return IDLE_AC_CHARGING_LIMIT_AMPS + HALL_ALLOWANCE_ABOVE_IDLE_LIMIT_AMPS + solarAmps;
}

/**
 * The unproven writes above the idle cap that `readback` can't rule out although it was decoded after all
 * of them went out: a later unproven write would leave the very value it shows (A→B→A). Only the alternate
 * cap can tell those apart, and not when the readback already shows its value.
 */
export function ambiguousHigherLimitsAmps(
  readback: AcChargingLimitReadback,
  unprovenLimitWrites: readonly FieldWrite[]
): number[] {
  if (readback.amps > IDLE_AC_CHARGING_LIMIT_AMPS || readback.amps === ALTERNATE_CAP_AMPS) return [];
  if (unprovenLimitWrites.some(write => write.sentAtMs >= readback.observedAtMs)) return [];
  const lastWriteOfReadValue = unprovenLimitWrites.findLastIndex(write => write.value === readback.amps);
  return unprovenLimitWrites
    .slice(0, Math.max(0, lastWriteOfReadValue))
    .filter(isAboveIdleCap)
    .map(write => Number(write.value));
}

/** A write above the idle cap that no readback has proven landed may still commit */
export function higherLimitMayLand(unprovenLimitWrites: readonly FieldWrite[]): boolean {
  return unprovenLimitWrites.some(isAboveIdleCap);
}

/**
 * The AC charging flag's last write no readback has proven landed switches it on — where the flag ends
 * up, as writes land in send order (an EDB0 after it, sent on a proven cap, ends it again)
 */
export function enableMayLand(unprovenAcChargingWrites: readonly FieldWrite[]): boolean {
  const lastWrite = unprovenAcChargingWrites[unprovenAcChargingWrites.length - 1];
  return lastWrite !== undefined && lastWrite.value !== "disabled";
}

function isAboveIdleCap(write: FieldWrite): boolean {
  // MUCHGC values are always amps; anything else can't vouch for a cap either
  return typeof write.value !== "number" || write.value > IDLE_AC_CHARGING_LIMIT_AMPS;
}
