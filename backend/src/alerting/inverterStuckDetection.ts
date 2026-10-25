import type { RawMQTTValues } from "../mqttValues/rawValuesSchema.ts";
import type { ConditionObservation } from "./sustainedCondition.ts";

/**
 * Pure detection of the "inverter got stuck" failure. On 2026-10-21 04:15 UTC, at the end of a
 * 15 kW grid charge, the inverter's DC side (battery converter, MPPTs, inverter bridge) latched
 * idle for 59 h until a power-cycle. Telemetry kept flowing and looked plausible, which is why
 * nothing noticed. Each signature below evaluates one plain snapshot so the selftest and the
 * Influx backtest drive exactly the code the controller runs. Thresholds come from the incident
 * report's backtests (hall era 2025-10 → 2026-10, PV history 2024-04 → 2026-10).
 */
export function evaluateInverterStuckRules(
  snapshot: InverterStuckSnapshot
): Record<InverterStuckRuleId, RuleEvaluation> {
  return {
    dc_side_idle: evaluateDcSideIdle(snapshot),
    pv_stalled_in_daylight: evaluatePvStalledInDaylight(snapshot),
    buy_window_not_charging: evaluateBuyWindowNotCharging(snapshot),
  };
}

export const inverterStuckRuleIds = ["dc_side_idle", "pv_stalled_in_daylight", "buy_window_not_charging"] as const;
export type InverterStuckRuleId = (typeof inverterStuckRuleIds)[number];

const inverterStuckFields = [
  "battery_current",
  "battery_voltage",
  "battery_power_direction",
  "dc/ac_power_direction",
  "ac_input_total_active_power",
  "solar_input_voltage_1",
  "solar_input_voltage_2",
  "solar_input_power_1",
  "solar_input_power_2",
  "solar_input_1_work_status",
  "solar_input_2_work_status",
] as const satisfies readonly (keyof RawMQTTValues)[];
type InverterStuckField = (typeof inverterStuckFields)[number];
type InverterStuckValues = Pick<RawMQTTValues, InverterStuckField>;

export type TimedReading<Value> = { value: Value; time: number };

export type InverterStuckSnapshot = {
  nowMs: number;
  /** Same shape as the mqttValues store entries: value + the time it last arrived */
  inverter: Partial<{ [Field in InverterStuckField]: TimedReading<RawMQTTValues[Field]> }>;
  /** 1-min trailing mean of the signed hall sensor 2 power (W, positive = charging); time = newest sample */
  smoothedHallWatts: TimedReading<number> | undefined;
  averageSOC: number | undefined;
  sunElevationDegrees: number;
  /** Battery-side amps the buy schedule asks for right now (0/undefined outside buy windows) */
  commandedChargingAmps: number | undefined;
  /** HECS readback: the inverter has confirmed AC charging is enabled (EDB1 landed) */
  acChargingEnabledOnInverter: boolean;
};

export type RuleEvaluation = { observation: ConditionObservation; detail: string };

/** The inverter publishes every field ~50×/min; two minutes of silence means we can't judge. */
export const INVERTER_READING_MAX_AGE_MS = 2 * 60_000;
/** The hall ADC samples at ~4 Hz */
export const HALL_READING_MAX_AGE_MS = 30_000;

// ——— Rule B: DC side idle ———
/**
 * Compared against |mean(P)|, not mean(|P|): an oscillation could average out, but the inverter
 * must also report exactly 0 A Idle/Idle, which it doesn't while power sloshes. Normal operation's
 * 1st percentile is 263 W (the inverter's own draw always flows through the battery); the latch
 * read 10–115 W, the top end being ~2 A DC loads. A summer hall-zero drift can't be ruled out
 * without a summer latch, but full-battery holds shift only ~100 W between winter and June.
 */
export const DC_IDLE_MAX_HALL_WATTS = 150;
/**
 * Hall-only evidence of recovery sits well above the idle band: during the incident ~2 A DC loads
 * (fans?) came and went for ~42 min at a time, and a 1-min mean of those must not "resolve" it.
 */
export const DC_RECOVERED_MIN_HALL_WATTS = 300;
export const DC_IDLE_MIN_GRID_IMPORT_WATTS = 100;
/** The low-voltage cut-off (warning 16, ≤ 49.5 V) idles the battery legitimately, ~30 h a year. */
export const DC_IDLE_MIN_BATTERY_VOLTS = 50.5;
/**
 * A full pack can't be gated out wholesale: the ledger SOC hardly falls during a latch (only
 * drain_a moves it), so a latch from full would stay invisible at night for days. What separates
 * a float hold from a latch is the inverter's report: in a year of hall data every float hold read
 * 0 A "Charging", and 0 A Idle/Idle never occurred above 50 % SOC outside the incident. As a second
 * guard in case that report ever misleads, a full pack also needs a near-zero hall: float holds
 * read ≥ 56 W (the longest run under 60 W lasted 3 min; under 80 W, 34 min), the latch −27 W median.
 */
export const HIGH_SOC_PERCENT = 90;
export const HIGH_SOC_IDLE_MAX_HALL_WATTS = 60;

// ——— Rule A: PV stalled in daylight ———
/** The 59.25 N winter maximum is only ~7°; dawn/dusk look-alikes all sit below 3° (report §4.3). */
export const PV_STALL_MIN_SUN_ELEVATION_DEGREES = 3;
/** The MPPT start-up voltage is 320 V; above 300 V the strings have light enough to work. */
export const PV_STALL_MIN_STRING_VOLTS = 300;
/** Snowy/dull days with high string voltage all produced > 20 W; a stall reads exactly 0. */
export const PV_STALL_MAX_TOTAL_WATTS = 20;

// ——— Rule C: buy window not charging ———
/**
 * Small commands (fuse headroom eaten by house load can round the buy current down to 1 A) are
 * within the noise of self-consumption, so the check only arms for a real charge.
 */
export const BUY_CHECK_MIN_COMMANDED_WATTS = 2000;
/**
 * A charge that isn't flowing leaves the pack at its resting voltage (≤ ~54.5 V; 53.3 V in the
 * dead 05:00 window), whereas a full pack held at its charge voltage sits right there. With a
 * 57 V gate the backtest fired on 53 winter-2025/26 windows that found the pack full and held at
 * 56.3–56.6 V; the taper near today's 58 V (2026-09-21: ~45 A at 57.9 V) is the same picture.
 */
export const BUY_CHECK_MAX_BATTERY_VOLTS = 55.5;
/** Every healthy buy window reached 255–286 A of a ~281 A command within a minute */
export const BUY_CHECK_MIN_DELIVERED_FRACTION = 0.3;

/**
 * Rule B, the main one (works day and night): the battery carries nothing, not even the
 * inverter's own draw, the inverter agrees it's idle, and the house runs on the grid — while the
 * battery isn't empty (low-voltage cut-off) and, when full, the hall is near zero rather than
 * showing a float hold's self-draw.
 */
export function evaluateDcSideIdle(snapshot: InverterStuckSnapshot): RuleEvaluation {
  const values = freshInverterValues(snapshot, [
    "battery_current",
    "battery_voltage",
    "battery_power_direction",
    "dc/ac_power_direction",
    "ac_input_total_active_power",
  ]);
  if (!values) return indeterminate("inverter values missing or stale");
  const hallWatts = freshHallWatts(snapshot);
  if (hallWatts === undefined) return indeterminate("hall sensor reading missing or stale");

  const summary =
    `hall ${Math.round(hallWatts)} W, inverter ${values.battery_current} A ` +
    `${values.battery_power_direction}/${values["dc/ac_power_direction"]}, grid ${formatSignedWatts(values.ac_input_total_active_power)}, ` +
    `${values.battery_voltage} V, SOC ${formatSoc(snapshot.averageSOC)}`;
  if (batteryFlowEvidence(values, hallWatts)) return { observation: "healthy", detail: summary };
  if (Math.abs(hallWatts) >= DC_IDLE_MAX_HALL_WATTS) {
    return indeterminate(`${summary} (hall between the idle and recovered bands)`);
  }
  if (values.ac_input_total_active_power <= DC_IDLE_MIN_GRID_IMPORT_WATTS) {
    return indeterminate(`${summary} (house not importing from the grid)`);
  }
  if (values.battery_voltage <= DC_IDLE_MIN_BATTERY_VOLTS) return indeterminate(`${summary} (low-voltage cut-off)`);
  if (snapshot.averageSOC === undefined) return indeterminate(`${summary} (SOC unknown)`);
  if (fullPackHallTooHigh(snapshot.averageSOC, hallWatts)) {
    return indeterminate(`${summary} (full pack, hall not near zero: could be a float hold)`);
  }
  return { observation: "failing", detail: summary };
}

/**
 * Rule A: the strings have voltage in daylight but both MPPTs sit idle at 0 W. Only catches a
 * night-time onset once the sun is up, hence Rule B; but it's the one signal that also covers an
 * MPPT-only latch, or a stall with an empty battery (2024-05-08/09).
 */
export function evaluatePvStalledInDaylight(snapshot: InverterStuckSnapshot): RuleEvaluation {
  const values = freshInverterValues(snapshot, [
    "solar_input_voltage_1",
    "solar_input_voltage_2",
    "solar_input_power_1",
    "solar_input_power_2",
    "solar_input_1_work_status",
    "solar_input_2_work_status",
  ]);
  if (!values) return indeterminate("PV values missing or stale");
  const totalWatts = values.solar_input_power_1 + values.solar_input_power_2;
  const highestStringVolts = Math.max(values.solar_input_voltage_1, values.solar_input_voltage_2);
  const summary =
    `PV ${Math.round(highestStringVolts)} V / ${Math.round(totalWatts)} W, ` +
    `MPPTs ${values.solar_input_1_work_status}/${values.solar_input_2_work_status}, sun ${snapshot.sunElevationDegrees.toFixed(1)}°`;
  // Any production proves the MPPTs alive whatever the sun angle, so it's checked before the daylight gates
  if (
    totalWatts > PV_STALL_MAX_TOTAL_WATTS ||
    values.solar_input_1_work_status === "Working" ||
    values.solar_input_2_work_status === "Working"
  ) {
    return { observation: "healthy", detail: summary };
  }
  if (snapshot.sunElevationDegrees <= PV_STALL_MIN_SUN_ELEVATION_DEGREES) {
    return indeterminate(`${summary} (sun too low)`);
  }
  if (highestStringVolts <= PV_STALL_MIN_STRING_VOLTS) {
    return indeterminate(`${summary} (strings below start-up voltage)`);
  }
  return { observation: "failing", detail: summary };
}

/**
 * Rule C: the inverter confirmed a real grid charge, yet it reports its battery side idle and the
 * hall agrees nothing arrives (on 2026-10-21 the 05:00 window commanded 281 A, got EDB1 confirmed,
 * and charged 0 A). A window the inverter answers by discharging or by charging too slowly is a
 * command-path problem, not this latch, and the power-cycle advice would be wrong for it: the
 * backtest's winter-2025/26 windows that discharged at −6 A are exactly that. Outside a checkable
 * window it can only report battery flow, which is what clears a latched alert afterwards.
 */
export function evaluateBuyWindowNotCharging(snapshot: InverterStuckSnapshot): RuleEvaluation {
  const values = freshInverterValues(snapshot, [
    "battery_current",
    "battery_voltage",
    "battery_power_direction",
    "dc/ac_power_direction",
  ]);
  if (!values) return indeterminate("inverter values missing or stale");
  const hallWatts = freshHallWatts(snapshot);
  if (hallWatts === undefined) return indeterminate("hall sensor reading missing or stale");

  const commandedAmps = snapshot.commandedChargingAmps ?? 0;
  const commandedWatts = commandedAmps * values.battery_voltage;
  const notCheckableBecause = buyCheckExclusion(snapshot, commandedWatts, values.battery_voltage, hallWatts);
  if (notCheckableBecause) {
    return batteryFlowEvidence(values, hallWatts)
      ? { observation: "healthy", detail: `battery flowing at ${Math.round(hallWatts)} W (${notCheckableBecause})` }
      : indeterminate(notCheckableBecause);
  }
  const summary =
    `commanded ${Math.round(commandedAmps)} A (~${(commandedWatts / 1000).toFixed(1)} kW), ` +
    `battery takes ${Math.round(hallWatts)} W at ${values.battery_voltage} V ` +
    `(inverter ${values.battery_current} A ${values.battery_power_direction}, SOC ${formatSoc(snapshot.averageSOC)})`;
  const chargeArriving = hallWatts >= commandedWatts * BUY_CHECK_MIN_DELIVERED_FRACTION;
  return {
    observation: chargeArriving || inverterReportsBatteryFlow(values) ? "healthy" : "failing",
    detail: summary,
  };
}

/** Why a buy window can't be judged right now, or undefined when it can */
function buyCheckExclusion(
  snapshot: InverterStuckSnapshot,
  commandedWatts: number,
  batteryVolts: number,
  hallWatts: number
): string | undefined {
  if (commandedWatts < BUY_CHECK_MIN_COMMANDED_WATTS) return `no buy window above ${BUY_CHECK_MIN_COMMANDED_WATTS} W`;
  if (!snapshot.acChargingEnabledOnInverter) return "AC charging not confirmed on the inverter yet";
  if (batteryVolts >= BUY_CHECK_MAX_BATTERY_VOLTS) return `battery at ${batteryVolts} V is held near CV`;
  if (batteryVolts <= DC_IDLE_MIN_BATTERY_VOLTS) return `battery at ${batteryVolts} V is in the low-voltage cut-off`;
  if (snapshot.averageSOC === undefined) return "SOC unknown";
  if (fullPackHallTooHigh(snapshot.averageSOC, hallWatts)) {
    return `SOC ${Math.round(snapshot.averageSOC)}% with the hall at ${Math.round(hallWatts)} W could be a full pack's hold`;
  }
  return undefined;
}

function fullPackHallTooHigh(averageSOC: number, hallWatts: number): boolean {
  return averageSOC >= HIGH_SOC_PERCENT && Math.abs(hallWatts) >= HIGH_SOC_IDLE_MAX_HALL_WATTS;
}

/**
 * Rules B and C can't run without the hall (current_measuring disabled, or the ADC loop errored and
 * is restarting); the wiring warns when that persists while the inverter itself is still talking.
 */
export function hallBlindWhileInverterTalks(snapshot: InverterStuckSnapshot): boolean {
  const batteryVoltage = snapshot.inverter.battery_voltage;
  const inverterTalking = !!batteryVoltage && snapshot.nowMs - batteryVoltage.time <= INVERTER_READING_MAX_AGE_MS;
  return inverterTalking && freshHallWatts(snapshot) === undefined;
}

/** Positive proof the battery converter is alive: the inverter's own report, or flow the hall clearly sees. */
function batteryFlowEvidence(values: InverterBatteryReport, hallWatts: number): boolean {
  return inverterReportsBatteryFlow(values) || Math.abs(hallWatts) >= DC_RECOVERED_MIN_HALL_WATTS;
}

/** Through all 59 h of the latch the inverter read exactly 0 A, Idle/Idle; anything else means its DC side moves. */
function inverterReportsBatteryFlow(values: InverterBatteryReport): boolean {
  return (
    values.battery_current !== 0 ||
    values.battery_power_direction !== "Idle" ||
    values["dc/ac_power_direction"] !== "Idle"
  );
}

type InverterBatteryReport = Pick<
  InverterStuckValues,
  "battery_current" | "battery_power_direction" | "dc/ac_power_direction"
>;

function freshInverterValues<Field extends InverterStuckField>(
  snapshot: InverterStuckSnapshot,
  fields: readonly Field[]
): Pick<InverterStuckValues, Field> | undefined {
  const values: Partial<Pick<InverterStuckValues, Field>> = {};
  for (const field of fields) {
    const reading = snapshot.inverter[field];
    if (!reading || snapshot.nowMs - reading.time > INVERTER_READING_MAX_AGE_MS) return undefined;
    values[field] = reading.value;
  }
  return values as Pick<InverterStuckValues, Field>;
}

function freshHallWatts(snapshot: InverterStuckSnapshot): number | undefined {
  const hall = snapshot.smoothedHallWatts;
  if (!hall || snapshot.nowMs - hall.time > HALL_READING_MAX_AGE_MS) return undefined;
  return hall.value;
}

function indeterminate(detail: string): RuleEvaluation {
  return { observation: "indeterminate", detail };
}

function formatSoc(averageSOC: number | undefined): string {
  return averageSOC === undefined ? "?" : `${Math.round(averageSOC)}%`;
}

function formatSignedWatts(watts: number): string {
  return `${watts > 0 ? "+" : ""}${Math.round(watts)} W`;
}
