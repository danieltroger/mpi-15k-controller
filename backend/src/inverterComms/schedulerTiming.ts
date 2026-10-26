/**
 * The inverter session's timing: the measured numbers behind the write → confirm lifecycle, and
 * the two confirm strategies the configured quiet gap selects between. Pure, no imports — the
 * state machine using them is schedulerCore.ts.
 *
 * Every time here is the session's MONOTONIC clock (performance.now() ms), never wall time.
 */

/**
 * Live-measured on the real MPI 15K (2026-07-18): the inverter ACKs a setter at frame level
 * immediately but APPLIES it on an internal housekeeping cycle — ~6 s after the write under light
 * traffic, and starved indefinitely under continuous traffic (67 ACKed identical rewrites over
 * 5m48s at ~1 command/1.2 s never became visible in the readback; the commit finally landed 42 s
 * into the first quiet period). Hence the default: full radio silence for this long after every
 * setter before the targeted confirm query runs…
 *
 * That evidence can't tell "any traffic starves the commit" from "rewriting the same register
 * restarts an internal delay" (all 67 were identical rewrites, which the identical-setter gate now
 * holds back anyway). usb_parameter_setting.quiet_gap_after_write_ms (default: this) is the live
 * knob for finding out (#52): 0 selects the interleaved strategy, where polling never pauses.
 */
export const QUIET_GAP_AFTER_WRITE_MS = 12_000;
/** …a longer silent backoff if the readback still shows the old value… */
export const CONFIRM_BACKOFF_MS = 30_000;
/** One confirm after the quiet gap + one re-check after the backoff, then give up loudly */
export const MAX_CONFIRM_ATTEMPTS = 2;
/**
 * …and a hard gate so no consumer loop can hammer the same write into permanent starvation:
 * an identical setter string is never sent more often than this.
 */
export const IDENTICAL_SETTER_MIN_INTERVAL_MS = 60_000;
/**
 * Longest quiet gap the scheduler accepts from config. The silent strategy's verdict (gap + two
 * confirm runs + the backoff between them) must land before the identical-setter gate opens: an
 * identical rewrite replaces the pending check, so a stuck write would never reach its give-up
 * alert. 15 s leaves room for both confirm queries timing out and retrying (~6.3 s each). It also
 * bounds how long GS/PS telemetry goes dark per write.
 */
export const MAX_QUIET_GAP_AFTER_WRITE_MS = 15_000;

/**
 * The interleaved strategy (quiet gap 0): GS/PS polling carries on through the write and the
 * confirm readbacks slot in between poll rounds — first when an unstarved commit should have
 * landed (the ~6 s housekeeping cycle; 2026-10-25 the native engine saw GPMP writes confirmed on
 * the first readback after a 12 s gap, so nothing closer to the ACK is known)…
 */
export const FIRST_INTERLEAVED_CONFIRM_AFTER_WRITE_MS = 6_000;
/** …then again this often while the readback still shows the old value (a GPMP answer is ~0.1 s of wire time)… */
export const INTERLEAVED_CONFIRM_INTERVAL_MS = 4_000;
/**
 * …until this long after the write, then give up loudly. Below IDENTICAL_SETTER_MIN_INTERVAL_MS
 * for the same reason as MAX_QUIET_GAP_AFTER_WRITE_MS: the 5 s margin covers the poll round (≤ 2 s
 * with the settings queries) the final confirm may wait behind, and once that confirm runs the
 * pump only decides the next action after its verdict. Still longer than the 42 s the July commit
 * needed once the line went quiet.
 */
export const INTERLEAVED_CONFIRM_GIVE_UP_AFTER_WRITE_MS = 55_000;
/**
 * If the hypothesis gap 0 tests is true (any traffic starves the commit), every interleaved write
 * gives up and every re-send starves again: inverter control would be off until someone reverts
 * the knob, with the P2 deduped to one push per cooldown. So one interleaved give-up puts every
 * later phase back on this measured silent gap until the knob next changes.
 */
export const STARVATION_FALLBACK_QUIET_GAP_MS = QUIET_GAP_AFTER_WRITE_MS;
/**
 * Setters held behind a stale gap-0 phase wait for its last verdict, at most its newest check's
 * give-up. If confirm runs keep failing (a consumer throwing on a settings readback), that verdict
 * never comes, so the hold lapses this long after it was due: a broken readback must not hold
 * control writes for good.
 */
export const STALE_HOLD_LAPSE_MARGIN_MS = 10_000;
/**
 * For the confirm verdict, a write no readback has proven yet counts as landed (or as never
 * landing) this long after it was sent. Only an ambiguous readback needs it: after A→B→A with B
 * never seen, "A" could mean "nothing committed yet" forever (fieldWriteChains.ts). As long as the
 * silent backoff, so the silent re-check always resolves it, and below the interleaved give-up minus
 * one re-check. Commits up to 30 s are attributed right: ~6 s under light traffic, the 12–18 s the
 * ambiguity was found at. Slower ones (July 2026: one landed 42 s into a quiet period) can make a
 * burst's verdict wrong either way: a false "confirmed" when the window takes both writes as landed,
 * or a false give-up. So nothing that can lose a write relies on this window: the satisfied drop
 * uses DROP_TRUST_COMMIT_WINDOW_MS.
 */
export const WRITE_COMMIT_WINDOW_MS = CONFIRM_BACKOFF_MS;
/**
 * The satisfied drop's horizon for the same question. The two mistakes cost differently: a drop
 * withheld too long costs one redundant write of what the readback already shows, while a drop let
 * through while a write is still landing can lose that write for good (#63: a buy window's 10 A cap,
 * with 42–48 s commits at the default). Three windows covers the slowest commit seen with margin.
 * Residual risk: an A→B→A whose commits take longer than this.
 */
export const DROP_TRUST_COMMIT_WINDOW_MS = 3 * WRITE_COMMIT_WINDOW_MS;

/**
 * Gap between the END of one background GS+PS round and the start of the next: rounds run
 * back-to-back. At 2400 baud the two responses (~117 + ~112 B) are ≈1 s of wire time, so a round
 * takes ≈1.1 s — the cadence the retired mpp-solar daemon achieved (~51 rounds/min, measured in
 * Influx before the first cutover). A fixed 2 s start-to-start pace would have cut the point rate
 * by ~40%.
 */
export const POLL_ROUND_GAP_MS = 50;
/** …but after a round with a failed query, breathe before hammering a line that isn't answering */
export const POLL_ROUND_GAP_AFTER_FAILURE_MS = 1_000;

export type SchedulerTiming = {
  /** usb_parameter_setting.quiet_gap_after_write_ms after effectiveQuietGapMs; 0 = interleaved strategy */
  quietGapAfterWriteMs: number;
  confirmBackoffMs: number;
  firstInterleavedConfirmAfterWriteMs: number;
  interleavedConfirmIntervalMs: number;
  interleavedConfirmGiveUpAfterWriteMs: number;
  /** The gap new phases use after an interleaved give-up, until the knob next changes */
  starvationFallbackQuietGapMs: number;
  /** For the confirm, an unproven write counts as landed this long after its send (WRITE_COMMIT_WINDOW_MS) */
  writeCommitWindowMs: number;
  /** The same for the satisfied drop (DROP_TRUST_COMMIT_WINDOW_MS) */
  dropTrustCommitWindowMs: number;
  pollRoundGapMs: number;
  pollRoundGapAfterFailureMs: number;
};

export const DEFAULT_SCHEDULER_TIMING: Readonly<SchedulerTiming> = {
  quietGapAfterWriteMs: QUIET_GAP_AFTER_WRITE_MS,
  confirmBackoffMs: CONFIRM_BACKOFF_MS,
  firstInterleavedConfirmAfterWriteMs: FIRST_INTERLEAVED_CONFIRM_AFTER_WRITE_MS,
  interleavedConfirmIntervalMs: INTERLEAVED_CONFIRM_INTERVAL_MS,
  interleavedConfirmGiveUpAfterWriteMs: INTERLEAVED_CONFIRM_GIVE_UP_AFTER_WRITE_MS,
  starvationFallbackQuietGapMs: STARVATION_FALLBACK_QUIET_GAP_MS,
  writeCommitWindowMs: WRITE_COMMIT_WINDOW_MS,
  dropTrustCommitWindowMs: DROP_TRUST_COMMIT_WINDOW_MS,
  pollRoundGapMs: POLL_ROUND_GAP_MS,
  pollRoundGapAfterFailureMs: POLL_ROUND_GAP_AFTER_FAILURE_MS,
};

/**
 * How a confirm phase treats the line until every check has its verdict:
 * - "silent": no traffic at all before each confirm (quiet gap, then the backoff), then give up
 *   after MAX_CONFIRM_ATTEMPTS
 * - "interleaved": background polling continues; confirms run between rounds, each check judged
 *   no earlier than its own write + firstInterleavedConfirmAfterWriteMs and giving up at its own
 *   write + interleavedConfirmGiveUpAfterWriteMs
 * Fixed, with its quiet gap, when a write arms a phase: writes merging into a running phase keep
 * both, so a live knob change applies from the first write after that phase ends. A gap-0 phase
 * that a knob change or the starvation fallback has left behind takes no new writes at all
 * (runningPhaseIsStale): they wait for it to end, at most 55 s.
 */
export type ConfirmStrategy = "silent" | "interleaved";

export function confirmStrategyFor(quietGapAfterWriteMs: number): ConfirmStrategy {
  return quietGapAfterWriteMs > 0 ? "silent" : "interleaved";
}

/** The configured quiet gap as the scheduler uses it, and why it differs when it had to be corrected */
export function effectiveQuietGapMs(configuredMs: number): { quietGapMs: number; correction: string | undefined } {
  if (typeof configuredMs !== "number" || !Number.isFinite(configuredMs) || configuredMs < 0) {
    return {
      quietGapMs: QUIET_GAP_AFTER_WRITE_MS,
      correction: `${JSON.stringify(configuredMs)} is not a non-negative number of ms — using the default ${QUIET_GAP_AFTER_WRITE_MS} ms`,
    };
  }
  if (configuredMs > MAX_QUIET_GAP_AFTER_WRITE_MS) {
    return {
      quietGapMs: MAX_QUIET_GAP_AFTER_WRITE_MS,
      correction: `${configuredMs} ms exceeds the ${MAX_QUIET_GAP_AFTER_WRITE_MS} ms maximum (the give-up must land before the ${IDENTICAL_SETTER_MIN_INTERVAL_MS} ms identical-setter gate) — using the maximum`,
    };
  }
  return { quietGapMs: configuredMs, correction: undefined };
}
