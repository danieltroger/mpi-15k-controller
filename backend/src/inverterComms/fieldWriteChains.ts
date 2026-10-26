/**
 * Per readback field: the writes no readback has proven committed yet, in send order — pure. The
 * inverter ACKs at once but commits seconds later, in the order the writes went out, so a readback
 * shows the value of the latest write that has landed, or what the field held before any of them.
 *
 * A→B→A is where that matters (PR #63's delta review): "A" read back can mean "nothing committed
 * yet" as well as "the second A committed", so it proves the second A only once B is known to have
 * landed — seen in a readback, or past its commit window. And while B may still land, a readback
 * showing A (or anything but B) can't vouch for the field: a queued A must not be dropped against it.
 * The scheduler keeps two sets of chains over the same writes, one per commit window: the confirm's
 * and the satisfied drop's longer one (schedulerTiming.ts). The longer one is also what the session
 * hands consumers as a field's unproven writes (the buy-window step-down's proof of its cap, #65).
 */
import type { DecodedFieldValue, SettingsQueryCommandName } from "./pi17Protocol.types.ts";

export type FieldWrite = { value: DecodedFieldValue; sentAtMs: number };

export type FieldWriteChain = {
  /** What the field held before `writes`: the last readback or proven write; undefined if never read */
  settledValue: DecodedFieldValue | undefined;
  /** Sent but not yet proven committed, oldest first */
  writes: readonly FieldWrite[];
};

/** Keyed by readbackFieldKey(query, field) */
export type FieldWriteChains = Readonly<Record<string, FieldWriteChain>>;

const NO_UNPROVEN_WRITES: readonly FieldWrite[] = [];

export function readbackFieldKey(query: SettingsQueryCommandName, field: string): string {
  return `${query}:${field}`;
}

/** One field's writes that no readback has proven landed yet, oldest first (none: an empty list) */
export function unprovenWritesIn(
  chains: FieldWriteChains,
  query: SettingsQueryCommandName,
  field: string
): readonly FieldWrite[] {
  return chains[readbackFieldKey(query, field)]?.writes ?? NO_UNPROVEN_WRITES;
}

/** Record one field's write in a set of chains (a copy) */
export function chainsWithWrite(
  chains: FieldWriteChains,
  fieldKey: string,
  write: FieldWrite,
  latestReadbackValue: DecodedFieldValue | undefined
): FieldWriteChains {
  return { ...chains, [fieldKey]: chainWithWrite(chains[fieldKey], write, latestReadbackValue) };
}

/** Credit one query's readback to a set of chains (a copy), every field with `commitWindowMs` */
export function chainsAfterReadback(
  chains: FieldWriteChains,
  query: SettingsQueryCommandName,
  fields: Readonly<Record<string, DecodedFieldValue>>,
  decodedAtMs: number,
  commitWindowMs: number
): FieldWriteChains {
  const credited = { ...chains };
  for (const [field, value] of Object.entries(fields)) {
    const fieldKey = readbackFieldKey(query, field);
    const chain = chainAfterReadback(credited[fieldKey], value, decodedAtMs, commitWindowMs);
    if (chain) credited[fieldKey] = chain;
    else delete credited[fieldKey];
  }
  return credited;
}

/** Every send counts — ACKed, NAKed or unanswered alike: a NAK'd or lost write can still have committed */
export function chainWithWrite(
  chain: FieldWriteChain | undefined,
  write: FieldWrite,
  latestReadbackValue: DecodedFieldValue | undefined
): FieldWriteChain {
  return chain
    ? { ...chain, writes: [...chain.writes, write] }
    : { settledValue: latestReadbackValue, writes: [write] };
}

/**
 * Credit a readback to the fewest committed writes it can mean (later ones may still land) and drop
 * the writes it proves. Writes older than `commitWindowMs` count as landed: without that, A→B→A
 * read back as A with B never seen would stay ambiguous forever. Undefined once nothing is unproven.
 */
export function chainAfterReadback(
  chain: FieldWriteChain | undefined,
  readValue: DecodedFieldValue,
  decodedAtMs: number,
  commitWindowMs: number
): FieldWriteChain | undefined {
  if (!chain) return undefined;
  // Sent in order, so the writes past their window are a prefix
  const pastWindow = chain.writes.filter(write => write.sentAtMs + commitWindowMs <= decodedAtMs).length;
  const valueAfterCommits = [chain.settledValue, ...chain.writes.map(write => write.value)];
  const fewestCommitsShowingIt = valueAfterCommits.findIndex(
    (value, committedCount) => committedCount >= pastWindow && value === readValue
  );
  // Nothing from the window's floor on explains the value: fewer writes landed than the window
  // assumes, the start was never read, or another hand changed it. The readback is what's settled.
  const settledCount = fewestCommitsShowingIt === -1 ? pastWindow : fewestCommitsShowingIt;
  const writes = chain.writes.slice(settledCount);
  if (!writes.length) return undefined;
  return { settledValue: fewestCommitsShowingIt === -1 ? readValue : valueAfterCommits[settledCount], writes };
}

/**
 * Does a readback of `readValue` (already credited with chainAfterReadback) prove `write` landed?
 * Only if it shows the write's value and no earlier write of another value is still unproven —
 * with one pending, the field may simply not have moved yet.
 */
export function readbackProvesWrite(
  chain: FieldWriteChain | undefined,
  write: FieldWrite,
  readValue: DecodedFieldValue | undefined
): boolean {
  if (readValue !== write.value) return false;
  const position = chain?.writes.findIndex(
    candidate => candidate.sentAtMs === write.sentAtMs && candidate.value === write.value
  );
  // Not in the chain (any more): a readback already proved it, or it is past its window
  if (chain === undefined || position === undefined || position === -1) return true;
  return chain.writes.slice(0, position).every(earlier => earlier.value === write.value);
}

/** Could a write still in flight move the field away from `value`? */
export function chainMayLeave(chain: FieldWriteChain | undefined, value: DecodedFieldValue): boolean {
  return chain !== undefined && chain.writes.some(write => write.value !== value);
}
