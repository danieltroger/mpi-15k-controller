/**
 * When the Ah ledger started, in the two forms its startup history queries need. InfluxDB holds an anchor's
 * charge up to ledger start; local accumulation covers everything after it. The restore and integral
 * queries therefore cut the history at that instant, however late they finally answer — otherwise the data
 * that reached InfluxDB while they were retrying would be counted twice.
 *
 * The pi's wall clock can't define that instant: the unit deliberately starts before NTP has synced
 * (deploy/install-systemd-service.sh), so after a power cut the clock is stale and steps forward mid-boot.
 * The start is pinned on the monotonic clock instead and handed to InfluxDB as an offset from ITS `now()`,
 * so the cut lands on the database's own timeline, step or no step.
 */
export type LedgerStartClock = {
  msSinceStart: () => number;
  /** InfluxQL condition selecting only history from before the ledger started. */
  beforeStartCondition: () => string;
};

export function createLedgerStartClock(): LedgerStartClock {
  const startedAtMonotonicMs = performance.now();
  const msSinceStart = () => performance.now() - startedAtMonotonicMs;
  return {
    msSinceStart,
    beforeStartCondition: () => `time < now() - ${Math.round(msSinceStart())}ms`,
  };
}
