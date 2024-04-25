function print(prefix, ...args: any[]) {
  console.log(prefix, new Date().toISOString(), ...args);
}

export function log(...args: any[]) {
  print("[LOG]", ...args);
}

export function warn(...args: any[]) {
  print("[WARN]", ...args);
}
export function error(...args: any[]) {
  print("[ERROR]", ...args);
}
