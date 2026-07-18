import type { Config } from "../config/config.types.ts";

// Physical quantities the planner, the buying self-consumption model and the float-charge workaround
// need in Wh / W. Before the Ah cutover these came from the Wh fitter's persisted capacity/parasitic
// state under soc_calculations; that whole system is gone, so they are now derived from the Ah ledger's
// online-tracked parameters. One definition each so the derivation can't drift between callers.

/**
 * Usable pack energy in watt-hours: the Ah ledger's online-tracked usable capacity (full→empty, in Ah)
 * times the discharge-branch mean terminal voltage. Replaces the deleted Wh-fitter capacity figure.
 */
export function packCapacityWh(config: Config): number {
  const { capacity_ah, v_discharge } = config.soc_calculations.ah_ledger;
  return capacity_ah * v_discharge;
}

/**
 * Inverter idle/standby draw in watts: the Ah ledger's online-tracked `drain_a` (the constant amp offset
 * removed from the coulomb count each hour — hall zero-bias + parasitic) expressed as power at the
 * discharge-branch mean voltage. Replaces the deleted Wh-fitter parasitic figure. NOTE this is
 * numerically smaller than the old Wh-fitted figure (drain is a battery-side amp offset, not the AC-side
 * self-consumption the fitter absorbed) — see the cutover open question.
 */
export function inverterIdleWatts(config: Config): number {
  const { drain_a, v_discharge } = config.soc_calculations.ah_ledger;
  return drain_a * v_discharge;
}
