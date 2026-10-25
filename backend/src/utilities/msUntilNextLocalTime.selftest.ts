/**
 * msUntilNextLocalTime with its shared formatter must give exactly what the per-step
 * toLocaleTimeString version gave, across both DST changes, and be fast. Run from backend/ with:
 *   yarn node src/utilities/msUntilNextLocalTime.selftest.ts
 */
import { msUntilNextLocalTime } from "./msUntilNextLocalTime.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

const TARGETS = ["03:30", "03:40", "13:10", "13:20", "02:15", "02:30", "00:00", "23:59"];
// 02:30 has no occurrence within 25 h of some spring-forward start times; both versions then
// default to 24 h — the new one's errorLog for that is expected here, so keep it off the output
const originalConsoleError = console.error;
console.error = () => {};
for (const day of ["2026-10-25", "2026-03-29", "2026-06-21"]) {
  let mismatches = 0;
  let comparisons = 0;
  const dayStartMs = Date.parse(`${day}T00:00:00Z`) - 3 * 3600_000;
  // Every 37 minutes (and a few seconds off the minute) through the local day and its DST change
  for (let nowMs = dayStartMs; nowMs < dayStartMs + 28 * 3600_000; nowMs += 37 * 60_000 + 13_000) {
    for (const target of TARGETS) {
      comparisons++;
      if (msUntilNextLocalTime(target, nowMs) !== previousImplementation(target, nowMs)) mismatches++;
    }
  }
  check(
    `identical to the old version around ${day}`,
    mismatches === 0,
    `(${comparisons} comparisons, ${mismatches} mismatches)`
  );
}

console.error = originalConsoleError;

const calls = 50;
const startedMs = performance.now();
for (let call = 0; call < calls; call++)
  msUntilNextLocalTime("13:10", Date.parse("2026-10-25T12:00:00Z") + call * 60_000);
const perCallMs = (performance.now() - startedMs) / calls;
check(
  "timing: a worst-case scan (target just passed) takes under 15 ms",
  perCallMs < 15,
  `(${perCallMs.toFixed(2)} ms per call; per-step toLocaleTimeString took ~190 ms on the VM)`
);

console.log(fails.length ? `\n${fails.length} FAILURES: ${fails.join(", ")}` : "\nAll local-time checks passed");
process.exit(fails.length ? 1 : 0);

/** The implementation before the shared formatter, verbatim apart from the injectable now */
function previousImplementation(hhmm: string, nowMs: number): number {
  const startMinute = Math.floor(nowMs / 60000) * 60000;
  for (let minute = 1; minute <= 25 * 60; minute++) {
    const candidate = startMinute + minute * 60000;
    const local = new Date(candidate).toLocaleTimeString("sv-SE", {
      timeZone: "Europe/Stockholm",
      hour: "2-digit",
      minute: "2-digit",
    });
    if (local === hhmm) return candidate - nowMs;
  }
  return 24 * 3600 * 1000;
}
