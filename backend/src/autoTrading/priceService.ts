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
 * the planner needs distinct, sorted slots, and a start seen twice (overlapping entries, or one day fetched
 * twice) would count that quarter-hour's energy twice. Keeps the first price and warns, never silently.
 */
export function entriesToSlots(entries: ApiEntry[]): PriceSlot15[] {
  const slotsByStartMs = new Map<number, PriceSlot15>();
  const duplicates: string[] = [];
  for (const entry of entries) {
    const startMs = +new Date(entry.time_start);
    const endMs = +new Date(entry.time_end);
    if (!isFinite(startMs) || !isFinite(endMs) || typeof entry.SEK_per_kWh !== "number") continue;
    for (let slotStartMs = startMs; slotStartMs < endMs; slotStartMs += SLOT_MS) {
      const kept = slotsByStartMs.get(slotStartMs);
      if (kept) {
        duplicates.push(`${new Date(slotStartMs).toISOString()} (kept ${kept.spot}, dropped ${entry.SEK_per_kWh})`);
        continue;
      }
      slotsByStartMs.set(slotStartMs, { startMs: slotStartMs, spot: entry.SEK_per_kWh });
    }
  }
  if (duplicates.length) {
    const listed = duplicates.slice(0, MAX_LISTED_DUPLICATES).join(", ");
    warnLog(
      `Price API: ${duplicates.length} duplicate 15-min slot(s) dropped, each start's first price kept:`,
      duplicates.length > MAX_LISTED_DUPLICATES ? `${listed}, …` : listed
    );
  }
  return [...slotsByStartMs.values()].sort((first, second) => first.startMs - second.startMs);
}

const MAX_LISTED_DUPLICATES = 8;

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
    coversTomorrow: !!tomorrow?.length,
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
