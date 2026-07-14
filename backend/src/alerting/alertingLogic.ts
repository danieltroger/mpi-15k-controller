import type { AlertSeverity } from "./alerting.types.ts";

/**
 * The pure decision core of alerting — no IO, no clock reads — so cooldown/escalation/rate-cap
 * behavior is testable in alerting.selftest.ts. The manager owns state and side effects.
 */

const SEVERITY_RANK: Record<AlertSeverity, number> = { P1: 3, P2: 2, P3: 1 };

export function severityRank(severity: AlertSeverity): number {
  return SEVERITY_RANK[severity];
}

/**
 * Pushover mapping: P1 = emergency priority (repeats every 60 s for an hour until someone
 * acknowledges; devices with Critical Alerts enabled ring through mute/DND), P2 = normal push,
 * P3 = quiet (no sound or vibration).
 */
export function severityToPushoverPriority(severity: AlertSeverity): {
  priority: number;
  retry?: number;
  expire?: number;
} {
  if (severity === "P1") return { priority: 2, retry: 60, expire: 3600 };
  if (severity === "P2") return { priority: 0 };
  return { priority: -1 };
}

export type SendDecision = "send" | "cooldown" | "rate_capped";

export function decideSend(input: {
  nowMs: number;
  severity: AlertSeverity;
  lastSentForKey?: { atMs: number; severity: AlertSeverity };
  cooldownMs: number;
  /** Timestamps of every push in the last hour (pruned by the caller) */
  pushedAtMsLastHour: number[];
  maxPushesPerHour: number;
}): SendDecision {
  const { lastSentForKey } = input;
  if (
    lastSentForKey &&
    input.nowMs - lastSentForKey.atMs < input.cooldownMs &&
    severityRank(input.severity) <= severityRank(lastSentForKey.severity)
  ) {
    return "cooldown";
  }
  // P1 must never be silenced by a chatty P2 bug — only the per-key cooldown applies to it
  if (input.severity !== "P1" && input.pushedAtMsLastHour.length >= input.maxPushesPerHour) {
    return "rate_capped";
  }
  return "send";
}

/**
 * Dedupe key for forwarded errorLog() calls: the same logical error must map to the same key even
 * when it embeds timestamps, readings or ports, so digits collapse to '#'. Two args are enough
 * context — later args tend to be whole error objects.
 */
export function errorLogDedupeKey(args: unknown[]): string {
  const text = args
    .slice(0, 2)
    .map(argument =>
      typeof argument === "string" ? argument : argument instanceof Error ? argument.message : safeStringify(argument)
    )
    .join(" ")
    .replace(/\d+/g, "#");
  return `errorlog:${text.slice(0, 80)}`;
}

export function formatErrorLogMessage(args: unknown[]): string {
  return args
    .map(argument =>
      typeof argument === "string"
        ? argument
        : argument instanceof Error
          ? argument.stack?.split("\n").slice(0, 2).join(" ") ?? argument.message
          : safeStringify(argument)
    )
    .join(" ")
    .slice(0, 900); // Pushover messages cap at 1024 chars
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Tri-state threshold with a set/clear gap: `true` at/above `setAt`, `false` at/below `clearAt`,
 * `undefined` (= hold the previous state) in between — the gap absorbs sensor noise hovering at
 * the line. For "alert when low" checks, negate value and both bounds.
 */
export function thresholdState(value: number, setAt: number, clearAt: number): boolean | undefined {
  if (value >= setAt) return true;
  if (value <= clearAt) return false;
  return undefined;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function formatSekForAlert(sek: number): string {
  return `${sek > 0 ? "+" : ""}${round1(sek)} SEK`;
}
