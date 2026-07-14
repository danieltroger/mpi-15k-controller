import { readFileSync, promises as fs_promises } from "fs";
import path from "path";
import process from "process";
import { type Accessor, createSignal, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { AlertRecord, AlertSeverity } from "./alerting.types.ts";
import { decideSend, errorLogDedupeKey, formatErrorLogMessage, severityToPushoverPriority } from "./alertingLogic.ts";
import { sendPushoverMessage } from "./pushoverTransport.ts";
import { debugLog, logLog, setOnErrorLog, warnLog } from "../utilities/logging.ts";

export type AlertManager = {
  /** Fire an alert. Resolves once delivery has been decided/attempted (rules fire-and-forget this). */
  raise: (alert: { key: string; severity: AlertSeverity; title: string; message: string }) => Promise<AlertRecord>;
  /** Newest first, capped — exposed over the ws for the /system alerts card. */
  recentAlerts: Accessor<AlertRecord[]>;
};

type PersistedAlertState = {
  last_sent: Record<string, { at: string; severity: AlertSeverity }>;
  recent: AlertRecord[];
};

const RECENT_CAP = 50;

/**
 * The manager survives a main() crash-restart (its state is module-external: fs + these signals),
 * so the crash handler in index.ts can alert through the previous instance while the next one boots.
 */
let activeManager: AlertManager | undefined;
const earlyAlerts: Parameters<AlertManager["raise"]>[0][] = [];
const mainCrashTimesMs: number[] = [];

export function createAlertManager(config: Accessor<Config>): AlertManager {
  const persisted = loadAlertState();
  const [recentAlerts, setRecentAlerts] = createSignal<AlertRecord[]>(persisted.recent);
  const lastSentByKey = new Map<string, { atMs: number; severity: AlertSeverity }>(
    Object.entries(persisted.last_sent).map(([key, entry]) => [
      key,
      { atMs: +new Date(entry.at), severity: entry.severity },
    ])
  );
  const pushedAtMs: number[] = [];
  // Forwarded errorLogs are unbounded and uncurated compared to the threshold rules, so they get
  // their own (smaller) hourly budget — log noise must never rate-cap a real hazard P2.
  const errorLogPushedAtMs: number[] = [];
  let persistTimer: ReturnType<typeof setTimeout> | undefined;

  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const snapshot: PersistedAlertState = {
        last_sent: Object.fromEntries(
          [...lastSentByKey].map(([key, entry]) => [
            key,
            { at: new Date(entry.atMs).toISOString(), severity: entry.severity },
          ])
        ),
        recent: untrack(recentAlerts),
      };
      fs_promises
        .writeFile(alertStateFilePath(), JSON.stringify(snapshot, null, 2), { encoding: "utf-8" })
        .catch(e => warnLog("Alerting: failed to persist alert state", e));
    }, 2000);
  };

  const raise: AlertManager["raise"] = async alert => {
    const alertingConfig = untrack(config).alerting;
    const nowMs = Date.now();
    const record: AlertRecord = {
      key: alert.key,
      severity: alert.severity,
      title: alertingConfig.site_name ? `[${alertingConfig.site_name}] ${alert.title}` : alert.title,
      message: alert.message,
      at: new Date(nowMs).toISOString(),
      delivery: "disabled",
    };

    if (!alertingConfig.enabled) {
      debugLog("Alerting disabled — swallowing", alert.key);
      return record;
    }

    const isForwardedErrorLog = alert.key.startsWith("errorlog:");
    const budgetBucket = isForwardedErrorLog ? errorLogPushedAtMs : pushedAtMs;
    while (budgetBucket.length && budgetBucket[0] < nowMs - 3600_000) budgetBucket.shift();
    const decision = decideSend({
      nowMs,
      severity: alert.severity,
      lastSentForKey: lastSentByKey.get(alert.key),
      cooldownMs: alertingConfig.cooldown_minutes * 60_000,
      pushedAtMsLastHour: budgetBucket,
      maxPushesPerHour: isForwardedErrorLog
        ? alertingConfig.max_errorlog_pushes_per_hour
        : alertingConfig.max_pushes_per_hour,
    });

    if (decision === "cooldown") {
      // A repeat inside the cooldown isn't news — log it, don't clutter the recent list
      debugLog(`Alerting: ${alert.key} still in cooldown, not re-sending`);
      record.delivery = "cooldown";
      return record;
    }

    if (decision === "rate_capped") {
      record.delivery = "rate_capped";
      warnLog(`Alerting: hourly push cap reached — suppressing ${alert.key}`);
    } else if (alertingConfig.dry_run) {
      record.delivery = "dry_run";
      logLog(`Alerting DRY RUN [${alert.severity}] ${record.title}: ${record.message}`);
    } else if (!alertingConfig.pushover_app_token || !alertingConfig.pushover_recipient_key) {
      record.delivery = "unconfigured";
      warnLog(`Alerting: pushover tokens not configured — can't send [${alert.severity}] ${record.title}`);
    } else {
      const result = await sendPushoverMessage({
        token: alertingConfig.pushover_app_token,
        user: alertingConfig.pushover_recipient_key,
        title: record.title,
        message: record.message,
        ...severityToPushoverPriority(alert.severity),
      });
      record.delivery = result.ok ? "pushed" : "push_failed";
      record.detail = result.detail;
    }

    if (record.delivery === "pushed" || record.delivery === "dry_run") {
      lastSentByKey.set(alert.key, { atMs: nowMs, severity: alert.severity });
      if (record.delivery === "pushed") budgetBucket.push(nowMs);
    }
    setRecentAlerts(existing => [record, ...existing].slice(0, RECENT_CAP));
    persist();
    return record;
  };

  const manager: AlertManager = { raise, recentAlerts };
  activeManager = manager;

  // Every errorLog() anywhere in the backend becomes a deduped P2 (the "general error" tier)
  setOnErrorLog(args => {
    if (!untrack(config).alerting.error_log_p2) return;
    void raise({
      key: errorLogDedupeKey(args),
      severity: "P2",
      title: "Error logged",
      message: formatErrorLogMessage(args),
    });
  });

  for (const early of earlyAlerts.splice(0)) void raise(early);
  return manager;
}

/**
 * Called from the main() crash-restart loop in index.ts — deliberately importable without a
 * manager existing yet (a crash during boot queues the alert until the next boot creates one).
 * Two crashes within 30 minutes escalate to P1: single crashes recover silently all the time,
 * a loop means the controller is effectively down.
 */
export function alertOnMainCrash(error: unknown) {
  const nowMs = Date.now();
  mainCrashTimesMs.push(nowMs);
  while (mainCrashTimesMs.length && mainCrashTimesMs[0] < nowMs - 30 * 60_000) mainCrashTimesMs.shift();
  const alert = {
    key: "main-crash",
    severity: (mainCrashTimesMs.length >= 2 ? "P1" : "P2") as AlertSeverity,
    title: mainCrashTimesMs.length >= 2 ? "Controller crash-looping" : "Controller crashed (restarting)",
    message: `${mainCrashTimesMs.length} crash(es) in 30 min. Latest: ${formatErrorLogMessage([error])}`,
  };
  if (activeManager) void activeManager.raise(alert);
  else if (earlyAlerts.length < 20) earlyAlerts.push(alert);
}

function loadAlertState(): PersistedAlertState {
  try {
    // Synchronous on purpose: raise() must be usable the moment the manager exists, and a read
    // of a tiny json at boot is cheaper than making every caller await manager readiness.
    return { last_sent: {}, recent: [], ...JSON.parse(readFileSync(alertStateFilePath(), { encoding: "utf-8" })) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warnLog("Alerting: failed to load alert state — starting fresh (cooldowns reset)", e);
    }
    return { last_sent: {}, recent: [] };
  }
}

function alertStateFilePath() {
  return path.dirname(process.argv[1]) + "/../alert_state.json";
}
