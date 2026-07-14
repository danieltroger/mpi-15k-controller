import { warnLog } from "../utilities/logging.ts";

/**
 * One Pushover message. Never throws and never calls errorLog — the alert manager forwards
 * errorLog() calls as alerts, so a failing transport logging through errorLog would recurse.
 */
export async function sendPushoverMessage(params: {
  token: string;
  user: string;
  title: string;
  message: string;
  priority: number;
  /** Seconds between re-delivery attempts (emergency priority only, min 30) */
  retry?: number;
  /** Seconds until an unacknowledged emergency alert stops repeating */
  expire?: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const body = new URLSearchParams({
    token: params.token,
    user: params.user,
    title: params.title,
    message: params.message,
    priority: String(params.priority),
  });
  if (params.priority === 2) {
    body.set("retry", String(params.retry ?? 60));
    body.set("expire", String(params.expire ?? 3600));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      body,
      signal: controller.signal,
    });
    if (response.ok) return { ok: true };
    const detail = await response
      .json()
      .then((parsed: { errors?: string[] }) => parsed.errors?.join("; ") ?? `HTTP ${response.status}`)
      .catch(() => `HTTP ${response.status}`);
    warnLog("Alerting: Pushover rejected message", detail);
    return { ok: false, detail };
  } catch (e) {
    warnLog("Alerting: Pushover request failed", e);
    return { ok: false, detail: String(e).slice(0, 200) };
  } finally {
    clearTimeout(timeout);
  }
}
