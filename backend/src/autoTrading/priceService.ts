import { type Accessor, createSignal } from "solid-js";
import { logLog, warnLog } from "../utilities/logging.ts";
import { addDays, stockholmDateOf } from "../utilities/stockholmDate.ts";
import { SLOT_MS } from "./planner.ts";
import type { PriceSlot15 } from "./planner.types.ts";
import type { FetchedPrices } from "./priceService.types.ts";

export type { FetchedPrices } from "./priceService.types.ts";

const PRICE_API_BASE = "https://www.elprisetjustnu.se/api/v1/prices";

export type ApiEntry = { SEK_per_kWh: number; time_start: string; time_end: string };

let cache: { area: string; value: FetchedPrices } | undefined;

const [getLatestSpotPrices, setLatestSpotPrices] = createSignal<FetchedPrices | undefined>();
/**
 * Latest successful fetch as a reactive signal so wsMessaging's per-key broadcast effect fires when
 * new prices land (the plain module cache above isn't reactive). Exposed to the frontend as
 * `spotPrices` for the price/plan chart.
 */
export const latestSpotPrices: Accessor<FetchedPrices | undefined> = getLatestSpotPrices;

async function fetchDayByDate(area: string, date: string): Promise<ApiEntry[] | undefined> {
  const [year, month, day] = date.split("-");
  const url = `${PRICE_API_BASE}/${year}/${month}-${day}_${area}.json`;
  const controller = new AbortController();
  // Generous timeout: this pi's CPU is often pegged (SOC worker) which slows TLS + event loop
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 404) return undefined; // not published yet
    if (!response.ok) {
      console.error("Price response", await response.text(), "headers", Object.fromEntries(response.headers));
      throw new Error(`Price API ${url} returned ${response.status}`);
    }
    return (await response.json()) as ApiEntry[];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Normalise API entries to 15-min slots (handles the pre-2025-10 hourly-era days too), one slot per start:
 * the planner needs distinct, sorted slots, and a start seen twice would count that quarter-hour's energy
 * twice. Where entries overlap, the one that started latest owns the slot: the API's autumn switch-day files
 * (2024-10-27, 2025-10-26) stretch the last summer-time entry to 03:00 winter time, across the repeated
 * hour whose own entries follow it. An exact repeat (the same start, e.g. one day fetched twice) keeps the
 * first. Overlaps and malformed entries are warned about, never dropped silently.
 */
export function entriesToSlots(entries: ApiEntry[]): PriceSlot15[] {
  const slotsByStartMs = new Map<number, SlotFromEntry>();
  const overlaps: string[] = [];
  const malformedEntries: ApiEntry[] = [];
  for (const entry of entries) {
    const entryStartMs = +new Date(entry.time_start);
    const entryEndMs = +new Date(entry.time_end);
    if (!isFinite(entryStartMs) || !isFinite(entryEndMs) || typeof entry.SEK_per_kWh !== "number") {
      malformedEntries.push(entry);
      continue;
    }
    for (let slotStartMs = entryStartMs; slotStartMs < entryEndMs; slotStartMs += SLOT_MS) {
      const candidate = { slot: { startMs: slotStartMs, spot: entry.SEK_per_kWh }, entryStartMs };
      const existing = slotsByStartMs.get(slotStartMs);
      if (!existing) {
        slotsByStartMs.set(slotStartMs, candidate);
        continue;
      }
      const [kept, dropped] = entryStartMs > existing.entryStartMs ? [candidate, existing] : [existing, candidate];
      slotsByStartMs.set(slotStartMs, kept);
      overlaps.push(
        `${isoTime(slotStartMs)} (kept ${kept.slot.spot} from the entry starting ${isoTime(kept.entryStartMs)}, ` +
          `dropped ${dropped.slot.spot} from ${isoTime(dropped.entryStartMs)})`
      );
    }
  }
  if (overlaps.length) {
    warnLog(
      `Price API: ${overlaps.length} 15-min slot(s) covered by more than one entry, each kept once:`,
      listSome(overlaps)
    );
  }
  if (malformedEntries.length) {
    warnLog(
      `Price API: ${malformedEntries.length} malformed entr${malformedEntries.length === 1 ? "y" : "ies"} skipped, e.g.`,
      JSON.stringify(malformedEntries[0])
    );
  }
  return [...slotsByStartMs.values()].map(({ slot }) => slot).sort((first, second) => first.startMs - second.startMs);
}

/** A slot and the start of the entry it was expanded from, which decides who owns an overlapped slot */
type SlotFromEntry = { slot: PriceSlot15; entryStartMs: number };

const MAX_LISTED_OVERLAPS = 8;

function listSome(items: string[]): string {
  const listed = items.slice(0, MAX_LISTED_OVERLAPS).join(", ");
  return items.length > MAX_LISTED_OVERLAPS ? `${listed}, …` : listed;
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/** Fetch one specific date's (YYYY-MM-DD) 15-min spot prices; [] if the day isn't published. */
export async function fetchPriceSlotsForDate(area: string, dateStr: string): Promise<PriceSlot15[]> {
  const entries = await fetchDayByDate(area, dateStr);
  return entries ? entriesToSlots(entries) : [];
}

/**
 * Fetch today's (and, when published, tomorrow's) 15-min spot prices.
 * Entries are normalised to 15-min slots even if the API ever returns hourly data.
 */
export async function fetchPrices(area: string, forceRefresh = false): Promise<FetchedPrices> {
  const maxAgeMs = 20 * 60 * 1000;
  if (
    !forceRefresh &&
    cache &&
    cache.area === area &&
    Date.now() - cache.value.fetchedAtMs < maxAgeMs &&
    cache.value.coversTomorrow
  ) {
    return cache.value;
  }

  const { todayDate, tomorrowDate } = priceDatesToFetch(Date.now());
  const [today, tomorrow] = await Promise.all([fetchDayByDate(area, todayDate), fetchDayByDate(area, tomorrowDate)]);
  if (!today) throw new Error(`Price API has no data for today (${todayDate})`);

  const slots = entriesToSlots([...today, ...(tomorrow ?? [])]);

  const horizonEndMs = slots.length ? slots[slots.length - 1].startMs + SLOT_MS : Date.now();
  const value: FetchedPrices = {
    slots,
    // From the kept slots, not the response: a tomorrow URL serving another day's file must not end the wait
    coversTomorrow: slots.some(slot => stockholmDateOf(slot.startMs) === tomorrowDate),
    fetchedAtMs: Date.now(),
    horizonEndMs,
  };
  cache = { area, value };
  setLatestSpotPrices(value);
  logLog(
    "Fetched electricity prices:",
    slots.length,
    "slots, tomorrow included:",
    value.coversTomorrow,
    "horizon end:",
    new Date(horizonEndMs).toISOString()
  );
  return value;
}

export function getCachedPrices(area: string): FetchedPrices | undefined {
  return cache?.area === area ? cache.value : undefined;
}

/**
 * The Stockholm days fetchPrices asks for: today and the next calendar day. Not the date of now + 24 h: in
 * the 25-hour autumn day's first hour that instant is still today (today fetched twice, every slot doubled,
 * "tomorrow included" wrongly true), and in the spring-forward eve's last hour it is already Monday (Sunday's
 * published prices never fetched, the horizon ending at midnight).
 */
export function priceDatesToFetch(nowMs: number): { todayDate: string; tomorrowDate: string } {
  const todayDate = stockholmDateOf(nowMs);
  return { todayDate, tomorrowDate: addDays(todayDate, 1) };
}
