import { PriceInfo } from "../config/config.types";
import { logLog, errorLog } from "../utilities/logging";

const PRICE_API_BASE = "https://www.elprisetjustnu.se/api/v1/prices";

interface CachedPrices {
  today: PriceInfo[];
  tomorrow: PriceInfo[];
  lastFetched: Date;
}

class ElectricityPriceService {
  private caches = new Map<string, CachedPrices>();
  private fetching = new Set<string>();
  private fetchListeners = new Map<string, (() => void)[]>();

  async fetchPrices(priceZone: string = "SE3", forceRefresh: boolean = false): Promise<CachedPrices> {
    const cache = this.caches.get(priceZone);
    if (!forceRefresh && cache && this.isFresh(cache.lastFetched)) {
      return cache;
    }

    if (!forceRefresh && this.fetching.has(priceZone)) {
      return new Promise(resolve => {
        const existing = () => resolve(this.caches.get(priceZone)!);
        const listeners = this.fetchListeners.get(priceZone) || [];
        listeners.push(existing);
        this.fetchListeners.set(priceZone, listeners);
      });
    }

    this.fetching.add(priceZone);
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");

    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowYear = tomorrow.getFullYear();
    const tomorrowMonth = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const tomorrowDay = String(tomorrow.getDate()).padStart(2, "0");

    try {
      const [todayRes, tomorrowRes] = await Promise.allSettled([
        fetch(`${PRICE_API_BASE}/${year}/${month}-${day}_${priceZone}.json`),
        fetch(`${PRICE_API_BASE}/${tomorrowYear}/${tomorrowMonth}-${tomorrowDay}_${priceZone}.json`),
      ]);

      let today: PriceInfo[] = [];
      let tomorrow: PriceInfo[] = [];

      if (todayRes.status === "fulfilled" && todayRes.value.ok) {
        today = await todayRes.value.json();
        logLog(`Fetched ${today.length} today's prices`);
      } else {
        errorLog("Failed to fetch today's prices");
      }

      if (tomorrowRes.status === "fulfilled" && tomorrowRes.value.ok) {
        tomorrow = await tomorrowRes.value.json();
        logLog(`Fetched ${tomorrow.length} tomorrow's prices`);
      } else {
        logLog("Tomorrow's prices not yet available (typical before 13:00)");
      }

      this.caches.set(priceZone, {
        today,
        tomorrow,
        lastFetched: new Date(),
      });

      this.fetching.delete(priceZone);
      this.fetchListeners.get(priceZone)?.forEach(cb => cb());
      this.fetchListeners.delete(priceZone);

      return this.caches.get(priceZone)!;
    } catch (e) {
      errorLog("Error fetching electricity prices:", e);
      throw e;
    } finally {
      this.fetching.delete(priceZone);
    }
  }

  private isFresh(lastFetched: Date): boolean {
    const now = new Date();
    const minutesSince = (now.getTime() - lastFetched.getTime()) / (1000 * 60);
    return minutesSince < 30;
  }

  getCurrentHourPrice(prices: PriceInfo[]): PriceInfo | null {
    const now = new Date();
    const currentHour = now.getHours();

    return (
      prices.find(p => {
        const startTime = new Date(p.time_start);
        return startTime.getHours() === currentHour;
      }) || null
    );
  }

  getPriceForHour(prices: PriceInfo[], hour: number): PriceInfo | null {
    return (
      prices.find(p => {
        const startTime = new Date(p.time_start);
        return startTime.getHours() === hour;
      }) || null
    );
  }

  getAllUpcomingPrices(prices: CachedPrices): PriceInfo[] {
    const now = new Date();
    const allPrices = [...prices.today, ...prices.tomorrow];

    return allPrices.filter(p => {
      const startTime = new Date(p.time_start);
      return startTime > now;
    });
  }

  findCheapestHours(prices: PriceInfo[], count: number = 5): PriceInfo[] {
    return [...prices].sort((a, b) => a.SEK_per_kWh - b.SEK_per_kWh).slice(0, count);
  }

  findMostExpensiveHours(prices: PriceInfo[], count: number = 5): PriceInfo[] {
    return [...prices].sort((a, b) => b.SEK_per_kWh - a.SEK_per_kWh).slice(0, count);
  }

  getAveragePrice(prices: PriceInfo[]): number {
    if (prices.length === 0) return 0;
    return prices.reduce((sum, p) => sum + p.SEK_per_kWh, 0) / prices.length;
  }

  getCachedPrices(priceZone: string = "SE3"): CachedPrices | null {
    return this.caches.get(priceZone) || null;
  }

}

export const priceService = new ElectricityPriceService();
export type { CachedPrices };
