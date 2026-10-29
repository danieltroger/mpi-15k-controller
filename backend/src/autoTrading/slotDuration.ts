/**
 * The length of the planner's time step: day-ahead spot prices come in 15-min slots and every planner
 * pass works in them. Its own module so the pass modules (sellAllocation.ts) can use it without
 * importing planner.ts back — a module-level use in such a cycle would hit SLOT_MS before planner.ts
 * defined it. planner.ts re-exports it for everyone else.
 */
export const SLOT_MS = 15 * 60 * 1000;
