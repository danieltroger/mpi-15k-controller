/**
 * Main: whether a promise settles within waitMs, and its value if so. The work itself carries on either way
 * (whatever it caches lands for a later caller), so this bounds how long a caller waits, not what it costs.
 * A rejection inside the window rejects; the promise must handle its own rejections once the window has
 * passed (nothing awaits it then).
 */
export async function settleWithin<Value>(
  promise: Promise<Value>,
  waitMs: number
): Promise<{ settled: true; value: Value } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const windowClosed = new Promise<{ settled: false }>(resolve => {
    timer = setTimeout(() => resolve({ settled: false }), waitMs);
  });
  try {
    return await Promise.race([promise.then(value => ({ settled: true as const, value })), windowClosed]);
  } finally {
    clearTimeout(timer);
  }
}
