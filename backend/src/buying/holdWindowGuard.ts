/**
 * The hold guard: pure state machine that keeps a hold window (a buy window at hold power,
 * scheduledBuyDecision.ts) from overloading the grid breakers or charging a freezing battery. No I/O, no
 * timers, no solid-js — the reactive wiring is useHoldWindowGuard.ts.
 *
 * Why: during a hold the whole house load runs through the grid breakers (16/20 A C-curve per phase),
 * the EV charger's 16 A per phase included, and the buy fuse logic can't help — it only lowers the
 * charge current, which a hold already has at its 1 A floor. So while a hold is wanted, the guard drops
 * out of it (the hold's power goes to 0: AC charging switches off through the window-end step-down, and
 * the battery serves the house) once a phase's projected grid current has been at or above
 * max_grid_input_amperage minus hold_grid_margin_amps for OVERLOAD_CONFIRM_MS (dips below it shorter than
 * that don't end the overload), or the coldest battery probe
 * is at or below the hold's minimum temperature (a hold trickles ~200 W into the battery, and the "Charging
 * a freezing battery" P1 fires above 200 W). It fails closed: grid readings older than READING_MAX_AGE_MS,
 * or a phase without grid voltage, drop out too. It lets the hold resume only once every phase has stayed
 * comfortably below the drop-out level, and the battery warm, for hold_reentry_minutes — after a controller
 * start too (holdGuardStartState), so a restart can't skip that wait or, in a crash loop, switch AC
 * charging on and off with every start.
 *
 * The drop-out and the re-entry go through the same path as a window's end and start: the write throttle
 * lets mode changes out at once (setterChangeThrottle.ts), and the step-down's cap only rises to 10 A from
 * a hold's 1–6 A before EDB0, so nothing new reaches the inverter.
 */

/** The battery must be this much warmer than the hold minimum to resume (the freezing P1 clears at +1 °C too) */
export const REENTRY_HYSTERESIS_CELSIUS = 1;
/**
 * How long an overload must last before the hold drops out: a single inrush reading (a compressor or kettle
 * start) would otherwise cost a whole hold_reentry_minutes. The guard evaluates at least every 2 s (useNow),
 * so this is at least two readings; a C-curve breaker takes minutes at the 1.1–1.5× such a load reaches. The
 * debounce is symmetric: once a reading is over the level, the overload only ends after every reading has
 * stayed below it this long too. A reset on any single lower reading let a phase averaging 20.4 A with one
 * 19.8 A dip every ~5 s, or a kettle alternating with the EV alone, hold forever: with 1–2 A of per-phase
 * jitter the real drop-out level sat ~1 A above the configured one. Erring this way drops a hold sooner.
 */
export const OVERLOAD_CONFIRM_MS = 5_000;
/**
 * A grid reading older than this counts as missing, and missing readings drop the hold: blind, the guard
 * can't protect the breakers. The inverter's values store keeps every field's last value forever, so the
 * age is all that tells a stalled poll from a quiet house (the fields arrive ~50 times a minute).
 */
export const READING_MAX_AGE_MS = 60_000;
/** The freezing P1's threshold plus this is the lowest hold minimum the guard accepts */
export const MIN_MARGIN_ABOVE_FREEZING_P1_CELSIUS = 1;
/**
 * A phase below this has no grid: holding does nothing then, and a broken voltage reading looks the same,
 * so the guard drops out rather than count the phase as 0 A (quietly: the owner switches the grid off some
 * nights)
 */
export const GRID_PRESENT_MIN_VOLTS = 100;

export type Phase = "r" | "s" | "t";
export type PhaseAmps = Record<Phase, number>;
/** A reading as the mqtt values store holds it: the value and when it arrived (wall clock ms) */
export type TimedReading = { value: number; time: number };

/** What projectedHoldGridAmps can tell about the grid side of a hold */
export type GridProjection =
  | { status: "ok"; ampsPerPhase: PhaseAmps }
  | { status: "missing"; detail: string }
  | { status: "no_grid"; detail: string };

export type HoldGuardSettings = {
  /** scheduled_power_buying.max_grid_input_amperage */
  maxGridInputAmps: number;
  /** automatic_trading.hold_grid_margin_amps (bounded) */
  gridMarginAmps: number;
  /** automatic_trading.hold_reentry_minutes (bounded) */
  reentryMinutes: number;
  /**
   * automatic_trading.hold_reentry_hysteresis_amps (bounded): "comfortably below" is this far under the drop-out
   * level, so a load hovering at it can't flap the hold (plannerKnobBounds.ts says what it trades off)
   */
  reentryHysteresisAmps: number;
  /** hold_min_battery_temp_celsius, never below the freezing P1's threshold + 1 °C (holdGuardMinBatteryCelsius) */
  minBatteryCelsius: number;
};

export type HoldGuardReadings = {
  /** The hold's projected per-phase grid current (projectedHoldGridAmps), or why there is none */
  grid: GridProjection;
  /** The coldest battery probe's latest reading; undefined = no probe has one (the freezing P1 can't fire then either) */
  coldestBatteryCelsius: number | undefined;
};

/** Why the hold is out: a breaker, the battery, blind readings, no grid, or a controller start */
export type HoldDropOutCause = "overload" | "cold_battery" | "readings_missing" | "no_grid" | "controller_start";

/**
 * An overload being confirmed (OVERLOAD_CONFIRM_MS): since when a reading went over the drop-out level, and
 * since when every reading has been back below it (undefined while the latest one is over)
 */
export type OverloadRun = { sinceMs: number; belowSinceMs: number | undefined };

export type HoldGuardState =
  | {
      phase: "allowed";
      /** The overload being confirmed, undefined when none is */
      overload: OverloadRun | undefined;
    }
  | {
      phase: "dropped_out";
      droppedOutAtMs: number;
      cause: HoldDropOutCause;
      reason: string;
      /** Start of the current unbroken run of comfortable readings */
      comfortableSinceMs: number | undefined;
    };

export type HoldGuardTransition =
  | { kind: "dropped_out"; cause: HoldDropOutCause; reason: string }
  | { kind: "resumed"; cause: HoldDropOutCause; droppedOutForMs: number; holdWanted: boolean; detail: string };

/**
 * One evaluation. Drops out only while a hold is wanted (outside one there is nothing to protect, and a
 * kettle between two windows mustn't log a drop-out), and resumes whenever the readings have been
 * comfortable long enough, wanted or not, so the next window starts held. `state` is `previous` itself
 * when nothing changed, so a memo holding it doesn't notify.
 */
export function stepHoldWindowGuard(
  previous: HoldGuardState,
  inputs: { nowMs: number; holdWanted: boolean; readings: HoldGuardReadings },
  settings: HoldGuardSettings
): { state: HoldGuardState; transition: HoldGuardTransition | undefined } {
  const { nowMs, holdWanted, readings } = inputs;
  if (previous.phase === "allowed") {
    if (!holdWanted) return unchangedOr(previous, { phase: "allowed", overload: undefined });
    const dropOut = dropOutCause(previous, nowMs, readings, settings);
    if (dropOut.cause === undefined) {
      return unchangedOr(previous, { phase: "allowed", overload: dropOut.overload });
    }
    return {
      state: {
        phase: "dropped_out",
        droppedOutAtMs: nowMs,
        cause: dropOut.cause,
        reason: dropOut.reason,
        comfortableSinceMs: undefined,
      },
      transition: { kind: "dropped_out", cause: dropOut.cause, reason: dropOut.reason },
    };
  }
  if (!comfortableReadings(readings, settings))
    return unchangedOr(previous, { ...previous, comfortableSinceMs: undefined });
  const comfortableSinceMs = previous.comfortableSinceMs ?? nowMs;
  if (nowMs - comfortableSinceMs < settings.reentryMinutes * 60_000) {
    return unchangedOr(previous, { ...previous, comfortableSinceMs });
  }
  return {
    state: { phase: "allowed", overload: undefined },
    transition: {
      kind: "resumed",
      cause: previous.cause,
      droppedOutForMs: nowMs - previous.droppedOutAtMs,
      holdWanted,
      detail: `${describeGrid(readings.grid)}, ${describeBattery(readings.coldestBatteryCelsius)} for ${settings.reentryMinutes} min`,
    },
  };
}

/**
 * Where the guard starts: out, until hold_reentry_minutes of comfortable readings after the start. A hold
 * then never starts blind, a restart mid-hold can't skip the wait after a drop-out, and a crash loop can't
 * switch AC charging on and off at every start (2026-10-21 restarted ~47 times).
 */
export function holdGuardStartState(nowMs: number): HoldGuardState {
  return {
    phase: "dropped_out",
    droppedOutAtMs: nowMs,
    cause: "controller_start",
    reason: "the controller just started",
    comfortableSinceMs: undefined,
  };
}

/**
 * The per-phase grid current a hold draws: the house's per-phase load (AC output, the larger of active and
 * apparent power, so a reactive load errs high too) plus a third each of the inverter's idle draw, its extra
 * draw while holding and the trickle, which the three-phase charger draws evenly. The same readings the buy
 * fuse logic sizes its charge current from (calculateChargingAmperage.ts), without crediting PV to the
 * house: holds are planned in the dark, and the projection should err high. It describes the hold whether
 * or not it runs right now, so it also says when a dropped hold may resume. A phase whose active power or
 * voltage is older than READING_MAX_AGE_MS is missing; an apparent power that old is left out.
 */
export function projectedHoldGridAmps(inputs: {
  nowMs: number;
  activeWatts: Partial<Record<Phase, TimedReading>>;
  apparentWatts: Partial<Record<Phase, TimedReading>>;
  gridVolts: Partial<Record<Phase, TimedReading>>;
  /** Inverter idle draw + hold_overhead_watts + the hold's charge power, all phases together */
  inverterAndTrickleWatts: number;
}): GridProjection {
  const fresh = (reading: TimedReading | undefined) =>
    reading && inputs.nowMs - reading.time <= READING_MAX_AGE_MS ? reading.value : undefined;
  const amps: Partial<PhaseAmps> = {};
  for (const phase of ["r", "s", "t"] as const) {
    const activeWatts = fresh(inputs.activeWatts[phase]);
    const volts = fresh(inputs.gridVolts[phase]);
    if (activeWatts === undefined || volts === undefined) {
      const ageMs = (reading: TimedReading | undefined) => (reading ? inputs.nowMs - reading.time : Infinity);
      const oldestMs = Math.max(ageMs(inputs.activeWatts[phase]), ageMs(inputs.gridVolts[phase]));
      return {
        status: "missing",
        detail: Number.isFinite(oldestMs)
          ? `phase ${phase.toUpperCase()}'s AC output or grid voltage is ${Math.round(oldestMs / 1000)} s old`
          : `phase ${phase.toUpperCase()}'s AC output or grid voltage has never been read`,
      };
    }
    if (volts < GRID_PRESENT_MIN_VOLTS) {
      return { status: "no_grid", detail: `phase ${phase.toUpperCase()} reads ${Math.round(volts)} V: no grid` };
    }
    const loadWatts = Math.max(activeWatts, fresh(inputs.apparentWatts[phase]) ?? 0);
    amps[phase] = (loadWatts + inputs.inverterAndTrickleWatts / 3) / volts;
  }
  return { status: "ok", ampsPerPhase: amps as PhaseAmps };
}

/** The hold minimum the guard applies: the knob, but never within 1 °C of the freezing P1's threshold */
export function holdGuardMinBatteryCelsius(
  holdMinBatteryCelsius: number,
  chargingBatteryTempP1Celsius: number
): number {
  return Math.max(holdMinBatteryCelsius, chargingBatteryTempP1Celsius + MIN_MARGIN_ABOVE_FREEZING_P1_CELSIUS);
}

/** The level a phase's projected grid current drops a hold at */
export function dropOutAmps(settings: HoldGuardSettings): number {
  return settings.maxGridInputAmps - settings.gridMarginAmps;
}

/** Whether the hold must drop out now, and the overload it carries on confirming otherwise */
function dropOutCause(
  previous: Extract<HoldGuardState, { phase: "allowed" }>,
  nowMs: number,
  readings: HoldGuardReadings,
  settings: HoldGuardSettings
):
  | { cause: HoldDropOutCause; reason: string; overload?: undefined }
  | { cause: undefined; overload: OverloadRun | undefined } {
  const { grid, coldestBatteryCelsius } = readings;
  if (grid.status === "missing") {
    return { cause: "readings_missing", reason: `${grid.detail}, so the breaker load can't be watched` };
  }
  if (grid.status === "no_grid") return { cause: "no_grid", reason: `${grid.detail}, a hold does nothing` };
  if (coldestBatteryCelsius !== undefined && coldestBatteryCelsius <= settings.minBatteryCelsius) {
    return {
      cause: "cold_battery",
      reason: `the coldest battery probe reads ${coldestBatteryCelsius.toFixed(1)} °C, at or below the hold minimum ${settings.minBatteryCelsius} °C (a hold trickles into the battery)`,
    };
  }
  const { phase, amps } = worstPhase(grid.ampsPerPhase);
  const limitAmps = dropOutAmps(settings);
  const running = previous.overload;
  if (amps < limitAmps) {
    if (!running) return { cause: undefined, overload: undefined };
    // The overload ends only once every reading has stayed below the level as long as one takes to confirm
    const belowSinceMs = running.belowSinceMs ?? nowMs;
    if (nowMs - belowSinceMs >= OVERLOAD_CONFIRM_MS) return { cause: undefined, overload: undefined };
    return { cause: undefined, overload: { sinceMs: running.sinceMs, belowSinceMs } };
  }
  const sinceMs = running?.sinceMs ?? nowMs;
  if (nowMs - sinceMs < OVERLOAD_CONFIRM_MS)
    return { cause: undefined, overload: { sinceMs, belowSinceMs: undefined } };
  return {
    cause: "overload",
    reason: `phase ${phase.toUpperCase()} would draw ${amps.toFixed(1)} A from the grid (${describeGrid(grid)}), at or above ${limitAmps} A (max grid draw ${settings.maxGridInputAmps} A − hold margin ${settings.gridMarginAmps} A) for ${Math.round((nowMs - sinceMs) / 1000)} s, counting dips below it shorter than ${OVERLOAD_CONFIRM_MS / 1000} s`,
  };
}

function comfortableReadings(readings: HoldGuardReadings, settings: HoldGuardSettings): boolean {
  const { grid, coldestBatteryCelsius } = readings;
  if (grid.status !== "ok") return false;
  if (worstPhase(grid.ampsPerPhase).amps > dropOutAmps(settings) - settings.reentryHysteresisAmps) return false;
  return (
    coldestBatteryCelsius === undefined ||
    coldestBatteryCelsius > settings.minBatteryCelsius + REENTRY_HYSTERESIS_CELSIUS
  );
}

function worstPhase(gridAmpsPerPhase: PhaseAmps): { phase: Phase; amps: number } {
  let worst: { phase: Phase; amps: number } = { phase: "r", amps: gridAmpsPerPhase.r };
  for (const phase of ["s", "t"] as const) {
    if (gridAmpsPerPhase[phase] > worst.amps) worst = { phase, amps: gridAmpsPerPhase[phase] };
  }
  return worst;
}

function describeGrid(grid: GridProjection): string {
  if (grid.status !== "ok") return grid.detail;
  const { r, s, t } = grid.ampsPerPhase;
  return `R ${r.toFixed(1)} A / S ${s.toFixed(1)} A / T ${t.toFixed(1)} A`;
}

function describeBattery(coldestBatteryCelsius: number | undefined): string {
  return coldestBatteryCelsius === undefined
    ? "no battery temperature"
    : `coldest battery probe ${coldestBatteryCelsius.toFixed(1)} °C`;
}

/** previous itself when next says the same, so a memo doesn't notify on every tick */
function unchangedOr(previous: HoldGuardState, next: HoldGuardState): { state: HoldGuardState; transition: undefined } {
  return { state: JSON.stringify(previous) === JSON.stringify(next) ? previous : next, transition: undefined };
}
