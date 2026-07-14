/**
 * Self-test for the pure alerting decision logic. Run from backend/ with:
 *   yarn node src/alerting/alerting.selftest.ts
 */
import { decideSend, errorLogDedupeKey, severityToPushoverPriority, thresholdState } from "./alertingLogic.ts";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// ——— severity → Pushover mapping ———
check("P1 is emergency priority with retry/expire", severityToPushoverPriority("P1"), {
  priority: 2,
  retry: 60,
  expire: 3600,
});
check("P2 is a normal push", severityToPushoverPriority("P2"), { priority: 0 });
check("P3 is quiet", severityToPushoverPriority("P3"), { priority: -1 });

// ——— cooldown / escalation / rate cap ———
const base = { nowMs: 1_000_000, cooldownMs: 30 * 60_000, pushedAtMsLastHour: [] as number[], maxPushesPerHour: 20 };

check("first alert sends", decideSend({ ...base, severity: "P2" }), "send");
check(
  "same key within cooldown is suppressed",
  decideSend({ ...base, severity: "P2", lastSentForKey: { atMs: base.nowMs - 60_000, severity: "P2" } }),
  "cooldown"
);
check(
  "escalation to P1 bypasses the cooldown",
  decideSend({ ...base, severity: "P1", lastSentForKey: { atMs: base.nowMs - 60_000, severity: "P2" } }),
  "send"
);
check(
  "de-escalation stays suppressed",
  decideSend({ ...base, severity: "P3", lastSentForKey: { atMs: base.nowMs - 60_000, severity: "P2" } }),
  "cooldown"
);
check(
  "same key after the cooldown sends again",
  decideSend({ ...base, severity: "P2", lastSentForKey: { atMs: base.nowMs - 31 * 60_000, severity: "P2" } }),
  "send"
);
const fullHour = Array.from({ length: 20 }, (_, i) => base.nowMs - i * 1000);
check("P2 hits the hourly cap", decideSend({ ...base, severity: "P2", pushedAtMsLastHour: fullHour }), "rate_capped");
check(
  "P1 is exempt from the hourly cap",
  decideSend({ ...base, severity: "P1", pushedAtMsLastHour: fullHour }),
  "send"
);

// ——— hysteresis ———
check("above set threshold → active", thresholdState(97.2, 97, 92), true);
check("inside the gap → hold", thresholdState(94, 97, 92), undefined);
check("below clear threshold → inactive", thresholdState(91.9, 97, 92), false);
check("inverted (undervoltage) set", thresholdState(-45.9, -46, -47), true);
check("inverted (undervoltage) hold", thresholdState(-46.5, -46, -47), undefined);
check("inverted (undervoltage) clear", thresholdState(-47.1, -46, -47), false);

// ——— errorLog dedupe keys ———
check(
  "same error with different numbers dedupes to one key",
  errorLogDedupeKey(["Price API returned 503 after 60000ms"]) ===
    errorLogDedupeKey(["Price API returned 502 after 31ms"]),
  true
);
check(
  "different errors get different keys",
  errorLogDedupeKey(["Auto trader errored"]) === errorLogDedupeKey(["Current measuring errored"]),
  false
);
check(
  "Error instances key on their message",
  errorLogDedupeKey([new Error("boom 123")]) === errorLogDedupeKey([new Error("boom 456")]),
  true
);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll alerting logic checks passed");
