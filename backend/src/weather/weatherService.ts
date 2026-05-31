import { HourlyWeather } from "../config/config.types";
import { logLog, errorLog } from "../utilities/logging";

const WEATHER_API_BASE = "https://api.open-meteo.com/v1/forecast";

interface WeatherForecast {
  hourly: HourlyWeather[];
  lastFetched: Date;
}

class WeatherService {
  #cachedForecast: WeatherForecast | null = null;
  #isFetching = false;
  #fetchListeners: (() => void)[] = [];

  async fetchForecast(latitude: number, longitude: number, forecastDays: number = 2): Promise<WeatherForecast> {
    if (this.#cachedForecast && this.#isFresh(this.#cachedForecast.lastFetched)) {
      return this.#cachedForecast;
    }

    if (this.#isFetching) {
      return new Promise(resolve => {
        this.#fetchListeners.push(() => resolve(this.#cachedForecast!));
      });
    }

    this.#isFetching = true;

    const url = new URL(WEATHER_API_BASE);
    url.searchParams.set("latitude", latitude.toString());
    url.searchParams.set("longitude", longitude.toString());
    url.searchParams.set("hourly", "sunshine_duration,shortwave_radiation,cloud_cover");
    url.searchParams.set("forecast_days", forecastDays.toString());
    url.searchParams.set("timezone", "auto");

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`);
      }

      const data = await response.json();

      const hourly: HourlyWeather[] = data.hourly.time.map((time: string, i: number) => ({
        time,
        sunshine_duration: data.hourly.sunshine_duration?.[i] ?? 0,
        shortwave_radiation: data.hourly.shortwave_radiation?.[i] ?? 0,
        cloud_cover: data.hourly.cloud_cover?.[i] ?? 0,
      }));

      logLog(`Fetched ${hourly.length} hourly weather records`);

      this.#cachedForecast = {
        hourly,
        lastFetched: new Date(),
      };

      this.#fetchListeners.forEach(cb => cb());
      this.#fetchListeners = [];

      return this.#cachedForecast;
    } catch (e) {
      errorLog("Error fetching weather forecast:", e);
      throw e;
    } finally {
      this.#isFetching = false;
    }
  }

  #isFresh(lastFetched: Date): boolean {
    const now = new Date();
    const minutesSince = (now.getTime() - lastFetched.getTime()) / (1000 * 60);
    return minutesSince < 60;
  }

  getUpcomingHours(forecast: WeatherForecast, hours: number = 48): HourlyWeather[] {
    const now = new Date();
    return forecast.hourly.filter(h => {
      const time = new Date(h.time);
      return time > now && time <= new Date(now.getTime() + hours * 60 * 60 * 1000);
    });
  }

  getRemainingSunshineHoursToday(forecast: WeatherForecast): number {
    const now = new Date();
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    const todaysHours = forecast.hourly.filter(h => {
      const time = new Date(h.time);
      return time >= now && time <= todayEnd;
    });

    return todaysHours.reduce((sum, h) => sum + h.sunshine_duration / 3600, 0);
  }

  getTomorrowsSunshineHours(forecast: WeatherForecast): number {
    const now = new Date();
    const tomorrowStart = new Date(now);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    tomorrowStart.setHours(0, 0, 0, 0);

    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setHours(23, 59, 59, 999);

    const tomorrowsHours = forecast.hourly.filter(h => {
      const time = new Date(h.time);
      return time >= tomorrowStart && time <= tomorrowEnd;
    });

    return tomorrowsHours.reduce((sum, h) => sum + h.sunshine_duration / 3600, 0);
  }

  getEstimatedSolarGeneration(forecast: WeatherForecast, hours: number = 24): number {
    const upcomingHours = this.getUpcomingHours(forecast, hours);

    const PANEL_EFFICIENCY = 0.18;
    const PANEL_AREA_M2 = 10;

    const totalWh = upcomingHours.reduce((sum, h) => {
      const radiationW = h.shortwave_radiation;
      const generatedWh = (radiationW * PANEL_EFFICIENCY * PANEL_AREA_M2) / 1000;
      return sum + generatedWh;
    }, 0);

    return totalWh;
  }

  getCachedForecast(): WeatherForecast | null {
    return this.#cachedForecast;
  }
}

export const weatherService = new WeatherService();
export type { WeatherForecast };
