import { logLog } from "../utilities/logging.ts";
import { type PriceSlot15, SLOT_MS } from "./planner.ts";

const PRICE_API_BASE = "https://www.elprisetjustnu.se/api/v1/prices";

type ApiEntry = { SEK_per_kWh: number; time_start: string; time_end: string };

export type FetchedPrices = {
  slots: PriceSlot15[];
  /** Whether the last fetched day extends past ~22:00 local tomorrow (i.e. tomorrow's prices are in) */
  coversTomorrow: boolean;
  fetchedAtMs: number;
  horizonEndMs: number;
};

let cache: { area: string; value: FetchedPrices } | undefined;

function dateInStockholm(msOffsetDays: number): { year: string; month: string; day: string } {
  const d = new Date(Date.now() + msOffsetDays * 24 * 3600 * 1000);
  // sv-SE formats as YYYY-MM-DD
  const [year, month, day] = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" }).split("-");
  return { year, month, day };
}

async function fetchDay(area: string, offsetDays: number): Promise<ApiEntry[] | undefined> {
  const { year, month, day } = dateInStockholm(offsetDays);
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

  const [today, tomorrow] = await Promise.all([fetchDay(area, 0), fetchDay(area, 1)]);
  if (!today) throw new Error("Price API has no data for today");

  const slots: PriceSlot15[] = [];
  for (const entry of [...today, ...(tomorrow ?? [])]) {
    const startMs = +new Date(entry.time_start);
    const endMs = +new Date(entry.time_end);
    if (!isFinite(startMs) || !isFinite(endMs) || typeof entry.SEK_per_kWh !== "number") continue;
    for (let t = startMs; t < endMs; t += SLOT_MS) {
      slots.push({ startMs: t, spot: entry.SEK_per_kWh });
    }
  }
  slots.sort((a, b) => a.startMs - b.startMs);

  const horizonEndMs = slots.length ? slots[slots.length - 1].startMs + SLOT_MS : Date.now();
  const value: FetchedPrices = {
    slots,
    coversTomorrow: !!tomorrow?.length,
    fetchedAtMs: Date.now(),
    horizonEndMs,
  };
  cache = { area, value };
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
