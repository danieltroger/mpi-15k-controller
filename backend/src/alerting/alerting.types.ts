/**
 * Pure type declarations for alerting, shared over the ws boundary (the /system alerts card
 * renders AlertRecord[]) — no runtime imports, see CLAUDE.md on shared wire types.
 */

/**
 * P1 pages everyone through DND (Pushover emergency priority + Critical Alerts), P2 is a normal
 * push, P3 is silent/informational. Extend here when a new tier is needed — everything maps
 * severities through alertingLogic.severityToPushoverPriority.
 */
export type AlertSeverity = "P1" | "P2" | "P3";

export type AlertDelivery =
  | "pushed"
  | "dry_run"
  | "push_failed"
  | "rate_capped"
  | "cooldown"
  | "unconfigured"
  | "disabled";

export type AlertRecord = {
  key: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  /** ISO timestamp of when the alert fired */
  at: string;
  delivery: AlertDelivery;
  /** Transport detail on failures ("invalid token", timeouts, …) */
  detail?: string;
};
