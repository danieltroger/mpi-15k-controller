/**
 * The session pump's one way to sleep: until a deadline, or until something wakes it early (a
 * setter queued, the device opened, the session disposed), whichever comes first. Times are the
 * session's monotonic clock.
 */
export type PumpWaiter = { resolve: () => void; timer: ReturnType<typeof setTimeout> | undefined };

/** Whatever owns the pump's current sleep (the session state) */
export type PumpSleepOwner = { pumpWaiter: PumpWaiter | undefined };

export function waitUntilOrWoken(owner: PumpSleepOwner, untilMs: number): Promise<void> {
  return new Promise<void>(resolve => {
    const waiter: PumpWaiter = { resolve, timer: undefined };
    // Cap so a (theoretically impossible) Infinity can only ever nap, not hang the pump
    const delayMs = Math.min(Math.max(0, untilMs - performance.now()), 60_000);
    waiter.timer = setTimeout(() => settleWaiter(owner, waiter), delayMs);
    owner.pumpWaiter = waiter;
  });
}

export function wakePump(owner: PumpSleepOwner): void {
  if (owner.pumpWaiter) settleWaiter(owner, owner.pumpWaiter);
}

function settleWaiter(owner: PumpSleepOwner, waiter: PumpWaiter): void {
  clearTimeout(waiter.timer);
  if (owner.pumpWaiter === waiter) owner.pumpWaiter = undefined;
  waiter.resolve();
}
