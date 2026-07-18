/** Generic path/value utilities for the config editor's pending-edit overlay. */

/** Stable map key for a path. NOT dot-joined — schedule keys are ISO strings containing dots. */
export function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export function getAtPath(root: unknown, path: readonly string[]): unknown {
  let node: unknown = root;
  for (const segment of path) {
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }
  return node;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality for JSON-shaped values (config never carries functions or cycles). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every(key => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}
