/**
 * Self-test of the settlement backlog's retry rule (settlementBacklog.ts): a failed day stops the run so the
 * watermark can't pass it (before, a newer day settling in the same run stranded it for good), it is retried
 * on later runs, and given up on, loudly, on its last run in the window. Simulates daily runs with a fake
 * settler: every day is settled at most once, a failing day costs at most one attempt per run for at most
 * SETTLEMENT_BACKLOG_DAYS runs, and no run does more than SETTLEMENT_BACKLOG_DAYS attempts. Run from backend/ with:
 *   yarn node src/autoTrading/settlementBacklog.selftest.ts
 */
import process from "process";
import { addDays } from "../utilities/stockholmDate.ts";
import { SETTLEMENT_BACKLOG_DAYS, settleBacklog } from "./settlementBacklog.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

const capturedWarnings: string[] = [];
const realConsoleWarn = console.warn;
console.warn = (...args: unknown[]) => {
  capturedWarnings.push(args.map(String).join(" "));
  realConsoleWarn(...args);
};

type Simulation = {
  /** The run (today's date) on which each day settled, once per settling: a day listed twice settled twice */
  settledOnRun: Map<string, string[]>;
  attemptsByDate: Map<string, number>;
  attemptsPerRun: number[];
  giveUpWarnings: string[];
  finalWatermark: string | undefined;
};

const FIRST_RUN = "2026-10-20";
const LAST_RUN = "2026-11-05";

// ---------- every day succeeds ----------
{
  const run = await simulateDailyRuns({ initialWatermark: "2026-10-18", failsOn: () => false });
  check(
    "all succeed: each day from 10-19 settles once, on the run of the day after",
    everyDaySettledOnce(run, "2026-10-19", addDays(LAST_RUN, -1)) &&
      [...run.settledOnRun].every(([date, runs]) => runs[0] === addDays(date, 1)) &&
      !run.giveUpWarnings.length,
    describe(run)
  );
}

// ---------- a transient failure is retried, not stranded ----------
{
  // 10-24 fails on its first two attempts. Before, the run on 10-26 settled 10-25 after 10-24 failed, moving
  // the watermark past 10-24 for good
  const run = await simulateDailyRuns({
    initialWatermark: "2026-10-18",
    failsOn: (date, attempt) => date === "2026-10-24" && attempt <= 2,
  });
  check(
    "transient: a day failing twice settles on its third run, and the newer days wait behind it",
    everyDaySettledOnce(run, "2026-10-19", addDays(LAST_RUN, -1)) &&
      run.attemptsByDate.get("2026-10-24") === 3 &&
      run.settledOnRun.get("2026-10-24")?.[0] === "2026-10-27" &&
      run.settledOnRun.get("2026-10-25")?.[0] === "2026-10-27" &&
      run.settledOnRun.get("2026-10-26")?.[0] === "2026-10-27" &&
      !run.giveUpWarnings.length,
    describe(run)
  );
}

// ---------- a day that never settles is given up on, loudly, after a bounded retry ----------
{
  const run = await simulateDailyRuns({ initialWatermark: "2026-10-18", failsOn: date => date === "2026-10-24" });
  check(
    "permanent: tried once per run on 3 runs, then given up with one warning; every other day settles once",
    everyDaySettledOnce(run, "2026-10-19", addDays(LAST_RUN, -1), ["2026-10-24"]) &&
      run.attemptsByDate.get("2026-10-24") === SETTLEMENT_BACKLOG_DAYS &&
      run.giveUpWarnings.length === 1 &&
      run.giveUpWarnings[0].includes("2026-10-24") &&
      run.settledOnRun.get("2026-10-25")?.[0] === "2026-10-27" &&
      run.settledOnRun.get("2026-10-26")?.[0] === "2026-10-27" &&
      run.attemptsPerRun.every(attempts => attempts <= SETTLEMENT_BACKLOG_DAYS),
    describe(run)
  );
}

// ---------- a long outage: five days never settle ----------
{
  const outage = ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"];
  const run = await simulateDailyRuns({ initialWatermark: "2026-10-18", failsOn: date => outage.includes(date) });
  check(
    "outage: each failed day given up once within the window, the first good day after still settles once",
    everyDaySettledOnce(run, "2026-10-19", addDays(LAST_RUN, -1), outage) &&
      outage.every(date => (run.attemptsByDate.get(date) ?? 0) <= SETTLEMENT_BACKLOG_DAYS) &&
      run.giveUpWarnings.length === outage.length &&
      run.settledOnRun.get("2026-10-29")?.[0] === "2026-10-31" &&
      run.attemptsPerRun.every(attempts => attempts <= SETTLEMENT_BACKLOG_DAYS),
    describe(run)
  );
}

// ---------- several runs a day (restarts) ----------
{
  const run = await simulateDailyRuns({
    initialWatermark: "2026-10-18",
    failsOn: date => date === "2026-10-24",
    runsPerDay: 3,
  });
  check(
    "restarts: three runs a day settle nothing twice, and a failing day still costs at most one attempt per run",
    everyDaySettledOnce(run, "2026-10-19", addDays(LAST_RUN, -1), ["2026-10-24"]) &&
      (run.attemptsByDate.get("2026-10-24") ?? 0) <= 3 * SETTLEMENT_BACKLOG_DAYS &&
      run.giveUpWarnings.length === 1 &&
      run.attemptsPerRun.every(attempts => attempts <= SETTLEMENT_BACKLOG_DAYS),
    describe(run)
  );
}

// ---------- no watermark yet ----------
{
  const run = await simulateDailyRuns({ initialWatermark: undefined, failsOn: () => false });
  check(
    "fresh state: the first run settles the whole window, oldest first, then one day per run",
    everyDaySettledOnce(run, addDays(FIRST_RUN, -SETTLEMENT_BACKLOG_DAYS), addDays(LAST_RUN, -1)) &&
      run.settledOnRun.get(addDays(FIRST_RUN, -SETTLEMENT_BACKLOG_DAYS))?.[0] === FIRST_RUN &&
      run.finalWatermark === addDays(LAST_RUN, -1),
    describe(run)
  );
}

console.warn = realConsoleWarn;
console.log(
  failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll scenarios passed"
);
process.exit(failedChecks.length ? 1 : 0);

/** settleBacklog once (or runsPerDay times) every day FIRST_RUN…LAST_RUN, carrying the watermark like the state does */
async function simulateDailyRuns(options: {
  initialWatermark: string | undefined;
  /** Whether the settler fails this day on its n-th attempt (1-based) */
  failsOn: (date: string, attempt: number) => boolean;
  runsPerDay?: number;
}): Promise<Simulation> {
  const simulation: Simulation = {
    settledOnRun: new Map(),
    attemptsByDate: new Map(),
    attemptsPerRun: [],
    giveUpWarnings: [],
    finalWatermark: options.initialWatermark,
  };
  capturedWarnings.length = 0;
  for (let today = FIRST_RUN; today <= LAST_RUN; today = addDays(today, 1)) {
    for (let runOfDay = 0; runOfDay < (options.runsPerDay ?? 1); runOfDay++) {
      let attemptsThisRun = 0;
      await settleBacklog({
        today,
        lastSettledDate: simulation.finalWatermark,
        settleDay: async date => {
          attemptsThisRun++;
          const attempt = (simulation.attemptsByDate.get(date) ?? 0) + 1;
          simulation.attemptsByDate.set(date, attempt);
          return options.failsOn(date, attempt) ? null : { date };
        },
        recordSettled: async date => {
          simulation.finalWatermark = date;
          simulation.settledOnRun.set(date, [...(simulation.settledOnRun.get(date) ?? []), today]);
        },
      });
      simulation.attemptsPerRun.push(attemptsThisRun);
    }
  }
  simulation.giveUpWarnings = capturedWarnings.filter(warning => warning.includes("giving up on settling"));
  return simulation;
}

/** Every date firstDate…lastDate settled exactly once, except `neverSettled`, which never settled */
function everyDaySettledOnce(
  simulation: Simulation,
  firstDate: string,
  lastDate: string,
  neverSettled: string[] = []
): boolean {
  for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
    const settledCount = simulation.settledOnRun.get(date)?.length ?? 0;
    if (settledCount !== (neverSettled.includes(date) ? 0 : 1)) return false;
  }
  return [...simulation.settledOnRun.keys()].every(date => date >= firstDate && date <= lastDate);
}

function describe(simulation: Simulation): string {
  const late = [...simulation.settledOnRun]
    .filter(([date, runs]) => runs[0] !== addDays(date, 1))
    .map(([date, runs]) => `${date}@${runs.join("+")}`);
  const failingAttempts = [...simulation.attemptsByDate]
    .filter(([date]) => !simulation.settledOnRun.has(date) || (simulation.attemptsByDate.get(date) ?? 0) > 1)
    .map(([date, attempts]) => `${date}×${attempts}`);
  return `(${simulation.settledOnRun.size} settled; late ${late.join(", ") || "none"}; retried ${failingAttempts.join(", ") || "none"}; ${simulation.giveUpWarnings.length} give-ups; max ${Math.max(...simulation.attemptsPerRun)} attempts/run)`;
}
