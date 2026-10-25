/**
 * An error's message with its cause chain. undici's fetch throws a bare "fetch failed" and hides
 * the actual network error (ECONNREFUSED 192.168.1.102:8086, ETIMEDOUT, …) in `cause`, sometimes as
 * an AggregateError of one error per address tried — exactly what a P2 needs to say.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof AggregateError && current.errors.length) {
      parts.push(current.errors.map(inner => describeError(inner)).join(" / "));
      break;
    }
    parts.push(current instanceof Error ? current.message || current.name : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.filter(Boolean).join(": ");
}

const MAX_CAUSE_DEPTH = 4;
