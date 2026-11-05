/**
 * Self-test of the session's NAK logging (setterNakStreaks.ts): one errorLog per streak of NAKs of a setter
 * parameter, warnLogs for the repeats, an hourly errorLog while it keeps going, and a streak ended by the
 * parameter's next ACK or by a long quiet. Run from backend/ with:
 *   yarn node src/inverterComms/setterNakStreaks.selftest.ts
 */
import process from "process";
import { setOnErrorLog } from "../utilities/logging.ts";
import {
  endSetterNakStreak,
  NAK_STREAK_EXPIRES_AFTER_MS,
  NAK_STREAK_REPAGE_INTERVAL_MS,
  reportSetterNak,
  type SetterNakStreaks,
} from "./setterNakStreaks.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

const errorLogs: string[] = [];
setOnErrorLog(args => errorLogs.push(args.map(argument => String(argument)).join(" ")));

function nak(streaks: SetterNakStreaks, parameter: string, command: string, nowMs: number): void {
  reportSetterNak(streaks, { parameter, command, answeredAfterWriteMs: 58, nowMs });
}

{
  const streaks: SetterNakStreaks = new Map();
  // Feeding's EDF1 once a minute for 50 min while discharge to the loads was off (2026-11-05)
  for (let minute = 0; minute < 50; minute++) nak(streaks, "EDF", "EDF1", minute * 60_000);
  check("50 NAKs of EDF1 a minute apart: one errorLog", errorLogs.length === 1, errorLogs.join(" | "));
  check("…the streak counts them", streaks.get("EDF")?.count === 50);
  nak(streaks, "SEP", "SEP01", 50 * 60_000);
  check("another parameter's NAK starts its own streak (one more errorLog)", errorLogs.length === 2);
  nak(streaks, "EDF", "EDF0", 50 * 60_000);
  check("EDF0 continues EDF1's streak (same parameter)", errorLogs.length === 2 && streaks.get("EDF")?.count === 51);
  endSetterNakStreak(streaks, { parameter: "EDF", command: "EDF1" });
  check("the ACK ends the streak", !streaks.has("EDF") && streaks.has("SEP"));
  nak(streaks, "EDF", "EDF1", 51 * 60_000);
  check("a NAK after the ACK is a new streak: errorLogged again", errorLogs.length === 3);
  endSetterNakStreak(streaks, { parameter: "GPMP0", command: "GPMP000350" });
  check("an ACK without a streak changes nothing", streaks.size === 2);
}

{
  // A recovery without an ACK (feeding's target moved to what the readback showed, dropped unsent), then a
  // new refusal a week later: a new streak, paged
  errorLogs.length = 0;
  const streaks: SetterNakStreaks = new Map();
  nak(streaks, "EDF", "EDF1", 0);
  nak(streaks, "EDF", "EDF1", 60_000);
  const weekLaterMs = 7 * 24 * 3_600_000;
  nak(streaks, "EDF", "EDF1", weekLaterMs);
  check(
    "a NAK long after the previous one starts a new streak, with an errorLog",
    errorLogs.length === 2 && streaks.get("EDF")?.count === 1,
    errorLogs.join(" | ")
  );
  nak(streaks, "EDF", "EDF1", weekLaterMs + NAK_STREAK_EXPIRES_AFTER_MS);
  check("…while one within the expiry continues it", errorLogs.length === 2 && streaks.get("EDF")?.count === 2);
}

{
  // A steady refusal every 10 min (the energy-distribution fallback) for 5 h: paged about hourly, with its count
  errorLogs.length = 0;
  const streaks: SetterNakStreaks = new Map();
  for (let attempt = 0; attempt <= 30; attempt++) nak(streaks, "SEP", "SEP01", attempt * 10 * 60_000);
  check(
    `a streak that keeps running errorLogs again every ${NAK_STREAK_REPAGE_INTERVAL_MS / 60_000} min, not on every NAK`,
    errorLogs.length === 6,
    `${errorLogs.length} errorLogs for 31 NAKs`
  );
  check("…naming its count", errorLogs.at(-1)?.includes("31 NAKs of SEP in a row") === true, errorLogs.at(-1));
}

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all setterNakStreaks selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
