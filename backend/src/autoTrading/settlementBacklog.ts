import { warnLog } from "../utilities/logging.ts";
import { addDays } from "../utilities/stockholmDate.ts";

/** How many completed days back a settlement run looks, and so how many runs a failing day is retried on */
export const SETTLEMENT_BACKLOG_DAYS = 3;

export type SettlementBacklogRequest<Settled> = {
  /** Today's Stockholm date: only the days before it are complete */
  today: string;
  /** The watermark: this day and all before it count as settled */
  lastSettledDate: string | undefined;
  /** Settles one day, or null when it can't yet (prices not published, no inverter data, an error) */
  settleDay: (date: string) => Promise<Settled | null>;
  /** Moves the watermark to a settled day (and persists it) */
  recordSettled: (date: string, settled: Settled) => Promise<void>;
};

/**
 * Main: settle the completed days after the watermark within the backlog window, oldest first. A day that
 * fails ends the run, so the watermark can't pass it and the next run retries it; a newer day settling
 * first would strand it for good. On its last run in the window (the oldest day) it is given up on, loudly,
 * and the newer days go ahead. So a failing day costs one attempt per run for at most
 * SETTLEMENT_BACKLOG_DAYS runs and holds the newer days back by at most that long, all still in the window.
 */
export async function settleBacklog<Settled>(request: SettlementBacklogRequest<Settled>): Promise<void> {
  const oldestDate = addDays(request.today, -SETTLEMENT_BACKLOG_DAYS);
  for (let daysAgo = SETTLEMENT_BACKLOG_DAYS; daysAgo >= 1; daysAgo--) {
    const date = addDays(request.today, -daysAgo);
    if (request.lastSettledDate && date <= request.lastSettledDate) continue;
    const settled = await request.settleDay(date);
    if (settled) {
      await request.recordSettled(date, settled);
      continue;
    }
    if (date !== oldestDate) return; // retried on the next run
    warnLog(
      `Auto trader: giving up on settling ${date}: still unsettled on its last run in the ${SETTLEMENT_BACKLOG_DAYS}-day backlog window`
    );
  }
}
