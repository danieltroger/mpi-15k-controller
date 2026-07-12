function print(logFunction: "log" | "debug" | "warn" | "error", prefix: string, ...args: any[]) {
  console[logFunction](prefix, new Date().toISOString(), ...args);
}

export function logLog(...args: any[]) {
  print("log", "[LOG]", ...args);
}

export function warnLog(...args: any[]) {
  print("warn", "[WARN]", ...args);
}
export function errorLog(...args: any[]) {
  print("error", "[ERROR]", ...args);
  // Forwarded to alerting (P2 push) when registered. Listener errors must never break logging.
  try {
    onErrorLogListener?.(args);
  } catch {
    /* a listener that throws gets no better treatment than silence — logging must stay bulletproof */
  }
}

let onErrorLogListener: ((args: any[]) => void) | undefined;

/** Alerting registers here to turn every errorLog into a (deduped) push notification. */
export function setOnErrorLog(listener: ((args: any[]) => void) | undefined) {
  onErrorLogListener = listener;
}

export function debugLog(...args: any[]) {
  print("debug", "[DEBUG]", ...args);
}
