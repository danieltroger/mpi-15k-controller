/**
 * Self-test of the session's NAK logging (setterNakStreaks.ts): one errorLog per streak of NAKs of a setter
 * parameter, warnLogs for the repeats, and the parameter's next ACK ending the streak. Run from backend/ with:
 *   yarn node src/inverterComms/setterNakStreaks.selftest.ts
 */
import process from "process";
import { setOnErrorLog } from "../utilities/logging.ts";
import { endSetterNakStreak, reportSetterNak, type SetterNakStreaks } from "./setterNakStreaks.ts";

const fails: string[] = [];
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!condition) fails.push(name);
}

const errorLogs: string[] = [];
setOnErrorLog(args => errorLogs.push(args.map(argument => String(argument)).join(" ")));

const streaks: SetterNakStreaks = new Map();
// Feeding's EDF1 once a minute for an hour while discharge to the loads was off (2026-11-05)
for (let minute = 0; minute < 60; minute++) {
  reportSetterNak(streaks, { parameter: "EDF", command: "EDF1", answeredAfterWriteMs: 58 });
}
check("60 NAKs of EDF1 in a row: one errorLog", errorLogs.length === 1, errorLogs.join(" | "));
check("…the streak counts them", streaks.get("EDF") === 60);
reportSetterNak(streaks, { parameter: "SEP", command: "SEP01", answeredAfterWriteMs: 60 });
check("another parameter's NAK starts its own streak (one more errorLog)", errorLogs.length === 2);
reportSetterNak(streaks, { parameter: "EDF", command: "EDF0", answeredAfterWriteMs: 58 });
check("EDF0 continues EDF1's streak (same parameter)", errorLogs.length === 2 && streaks.get("EDF") === 61);
endSetterNakStreak(streaks, { parameter: "EDF", command: "EDF1" });
check("the ACK ends the streak", !streaks.has("EDF") && streaks.has("SEP"));
reportSetterNak(streaks, { parameter: "EDF", command: "EDF1", answeredAfterWriteMs: 58 });
check("a NAK after the ACK is a new streak: errorLogged again", errorLogs.length === 3);
endSetterNakStreak(streaks, { parameter: "GPMP0", command: "GPMP000350" });
check("an ACK without a streak changes nothing", streaks.size === 2);

console.log(
  `\n${fails.length ? `${fails.length} FAILED: ${fails.join(", ")}` : "all setterNakStreaks selftests passed"}`
);
process.exit(fails.length ? 1 : 0);
