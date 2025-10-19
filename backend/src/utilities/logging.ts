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
}

export function debugLog(...args: any[]) {
  print("debug", "[DEBUG]", ...args);
}
