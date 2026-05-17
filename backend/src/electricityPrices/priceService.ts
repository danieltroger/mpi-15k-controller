import { PriceInfo } from "../config/config.types";
import { logLog, errorLog } from "../utilities/logging";

const PRICE_API_BASE = "https://www.elprisetjustnu.se/api/v1/prices";

interface CachedPrices {
  today: PriceInfo[];
  tomorrow: PriceInfo[];
  lastFetched: Date;
}

class ElectricityPriceService {
  private cachedPrices: CachedPrices | null = null;
  private isFetching = false;
  private fetchListeners: (() => void)[] = [];

  async fetchPrices(priceZone: string = "SE3"): Promise<CachedPrices> {
    if (this.cachedPrices && this.isFresh(this.cachedPrices.lastFetched)) {
      return this.cachedPrices;
    }

    if (this.isFetching) {
      return new Promise((resolve) => {
        this.fetchListeners.push(() => resolve(this.cachedPrices!));
      });
    }

    this.isFetching = true;
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

      this.cachedPrices = {
        today,
        tomorrow,
        lastFetched: new Date(),
      };

      this.fetchListeners.forEach((cb) => cb());
      this.fetchListeners = [];

      return this.cachedPrices;
    } catch (e) {
      errorLog("Error fetching electricity prices:", e);
      throw e;
    } finally {
      this.isFetching = false;
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
      prices.find((p) => {
        const startTime = new Date(p.time_start);
        return startTime.getHours() === currentHour;
      }) || null
    );
  }

  getPriceForHour(prices: PriceInfo[], hour: number): PriceInfo | null {
    return (
      prices.find((p) => {
        const startTime = new Date(p.time_start);
        return startTime.getHours() === hour;
      }) || null
    );
  }

  getAllUpcomingPrices(prices: CachedPrices): PriceInfo[] {
    const now = new Date();
    const allPrices = [...prices.today, ...prices.tomorrow];

    return allPrices.filter((p) => {
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

  getCachedPrices(): CachedPrices | null {
    return this.cachedPrices;
  }

  async waitForTomorrowPrices(priceZone: string = "SE3", maxAttempts: number = 24): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      const prices = await this.fetchPrices(priceZone);
      if (prices.tomorrow.length > 0) {
        return true;
      }
      logLog(`Tomorrow's prices not yet available, waiting... (attempt ${i + 1}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
    }
    return false;
  }
}

export const priceService = new ElectricityPriceService();
export type { CachedPrices };