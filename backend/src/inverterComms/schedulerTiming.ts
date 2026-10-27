/**
 * The inverter session's timing: the measured numbers behind the write → confirm lifecycle. Pure,
 * no imports — the state machine using them is schedulerCore.ts.
 *
 * Every time here is the session's MONOTONIC clock (performance.now() ms), never wall time.
 */

/**
 * The inverter ACKs a setter at frame level immediately but APPLIES it seconds later, on an internal
 * housekeeping cycle, so every write is confirmed by reading the setting back. GS/PS polling carries on
 * through the write and the confirm readbacks slot in between poll rounds. July 2026 suggested
 * continuous traffic starves the commit (67 ACKed identical rewrites at ~1 command/1.2 s never became
 * visible; the commit landed 42 s into the first quiet period), so writes used to be followed by 12 s of
 * radio silence. #52's run on 2026-10-26 ruled that out for read traffic: 10 of 10 GPMP writes committed
 * with polling running throughout (9–10 rounds, 22–23 frames in between). That points the July
 * starvation at the identical rewrites, which the identical-setter gate below holds back.
 *
 * The first confirm runs when the commit has usually landed. In #52's run a readback 6.2–6.9 s after the
 * ACK still showed the old value 10 of 10 times, the next one at 10.8–11.5 s the new value 10 of 10
 * times, and one commit was seen at 9.2 s. So 9 s, which usually converges on the first try; it is also
 * the youngest a check can be and still be judged (a readback that early says nothing about the write)…
 */
export const FIRST_CONFIRM_AFTER_WRITE_MS = 9_000;
/** …then again this often while the readback still shows the old value (a GPMP answer is ~0.1 s of wire time)… */
export const CONFIRM_RECHECK_INTERVAL_MS = 4_000;
/**
 * …until this long after the write, then give up loudly ("never applied", P2). The verdict must land
 * before the identical-setter gate opens: an identical rewrite replaces the pending check, so a stuck
 * write would never reach its give-up alert. The 5 s margin covers the poll round (≤ 2 s with the
 * settings queries) the final confirm may wait behind, and once that confirm runs the pump only decides
 * the next action after its verdict. Still longer than the 42 s the July commit needed.
 */
export const CONFIRM_GIVE_UP_AFTER_WRITE_MS = 55_000;
/**
 * A hard gate so no consumer loop can hammer the same write into permanent starvation: an identical
 * setter string is never sent more often than this.
 */
export const IDENTICAL_SETTER_MIN_INTERVAL_MS = 60_000;
/**
 * A check's give-up only covers a write that keeps its check that long: any later write to the same
 * field replaces it. With polling continuous, the buy current's target moves every ~6 s, so a MUCHGC
 * that never commits is superseded check after check (#75's review: the first page ~6 min in, ~45 min
 * with a 45 s write throttle). So a field also pages when a readback this long after an ACKed write
 * shows neither it nor any later write: the field never moved on. Just past the give-up, so a write
 * that keeps its check pages through it first; either opens the field's one page per episode.
 */
export const STARVED_WRITE_PAGE_AFTER_MS = 60_000;
/**
 * For the confirm verdict, a write no readback has proven yet counts as landed (or as never
 * landing) this long after it was sent. Only an ambiguous readback needs it: after A→B→A with B
 * never seen, "A" could mean "nothing committed yet" forever (fieldWriteChains.ts). Below the give-up
 * minus one re-check, so a re-check always resolves it before the verdict. Commits up to 30 s are
 * attributed right: 7–11.5 s with polling running (#52), the 12–18 s the ambiguity was found at.
 * Slower ones (July 2026: one landed after 42 s) can make a burst's verdict wrong either way: a false
 * "confirmed" when the window takes both writes as landed, or a false give-up. So nothing that can lose
 * a write relies on this window: the satisfied drop uses DROP_TRUST_COMMIT_WINDOW_MS, and so does the
 * buy-window step-down's proof of its cap (#65).
 */
export const WRITE_COMMIT_WINDOW_MS = 30_000;
/**
 * The satisfied drop's horizon for the same question. The two mistakes cost differently: a drop
 * withheld too long costs one redundant write of what the readback already shows, while a drop let
 * through while a write is still landing can lose that write for good (#63: a buy window's 10 A cap,
 * with 42–48 s commits). Three windows covers the slowest commit seen with margin.
 * Residual risk: an A→B→A whose commits take longer than this.
 */
export const DROP_TRUST_COMMIT_WINDOW_MS = 3 * WRITE_COMMIT_WINDOW_MS;

/**
 * A consumer's settings readback request (settingsReadbackRequests.ts) makes every poll round a settings
 * round until its query decodes, for at most this long: the next round usually answers it within ~2 s,
 * but a query that keeps failing must not slow GS/PS for good.
 */
export const SETTINGS_READBACK_REQUEST_LIFETIME_MS = 60_000;

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
  /** A check is first judged, and the first confirm runs, this long after its write */
  firstConfirmAfterWriteMs: number;
  confirmRecheckIntervalMs: number;
  confirmGiveUpAfterWriteMs: number;
  /** A readback this long after an ACKed write that shows neither it nor any later write pages (STARVED_WRITE_PAGE_AFTER_MS) */
  starvedWritePageAfterMs: number;
  /** For the confirm, an unproven write counts as landed this long after its send (WRITE_COMMIT_WINDOW_MS) */
  writeCommitWindowMs: number;
  /** The same for the satisfied drop (DROP_TRUST_COMMIT_WINDOW_MS) */
  dropTrustCommitWindowMs: number;
  pollRoundGapMs: number;
  pollRoundGapAfterFailureMs: number;
};

export const DEFAULT_SCHEDULER_TIMING: Readonly<SchedulerTiming> = {
  firstConfirmAfterWriteMs: FIRST_CONFIRM_AFTER_WRITE_MS,
  confirmRecheckIntervalMs: CONFIRM_RECHECK_INTERVAL_MS,
  confirmGiveUpAfterWriteMs: CONFIRM_GIVE_UP_AFTER_WRITE_MS,
  starvedWritePageAfterMs: STARVED_WRITE_PAGE_AFTER_MS,
  writeCommitWindowMs: WRITE_COMMIT_WINDOW_MS,
  dropTrustCommitWindowMs: DROP_TRUST_COMMIT_WINDOW_MS,
  pollRoundGapMs: POLL_ROUND_GAP_MS,
  pollRoundGapAfterFailureMs: POLL_ROUND_GAP_AFTER_FAILURE_MS,
};
