import { Config, ProposedScheduleEntry, PriceInfo, HourlyWeather } from "../config/config.types";
import { priceService, CachedPrices } from "../electricityPrices/priceService";
import { weatherService, WeatherForecast } from "../weather/weatherService";
import { logLog, errorLog } from "../utilities/logging";

export interface PlanGenerationInput {
  currentSOC: number;
  batteryCapacityWh: number;
  maxChargePowerW: number;
  maxDischargePowerW: number;
}

export interface PlanGenerationResult {
  entries: ProposedScheduleEntry[];
  based_on_soc: number;
  prices_fetched: boolean;
  weather_fetched: boolean;
  generated_at: string;
  errors: string[];
}

function combineDateAndHour(date: Date, hour: number): Date {
  const result = new Date(date);
  result.setHours(hour, 0, 0, 0);
  return result;
}

function formatISOWithTimezone(date: Date): string {
  const offset = date.getTimezoneOffset() / 60;
  const sign = offset <= 0 ? "+" : "-";
  const offsetHours = Math.abs(Math.floor(offset));
  const offsetMinutes = Math.abs(date.getTimezoneOffset() % 60);
  const tz = `${sign}${String(offsetHours).padStart(2, "0")}:${String(offsetMinutes).padStart(2, "0")}`;
  return date.toISOString().replace("Z", tz);
}

export async function generatePriceWeatherPlan(
  config: Config,
  input: PlanGenerationInput
): Promise<PlanGenerationResult> {
  const errors: string[] = [];
  let prices: CachedPrices | null = null;
  let weather: WeatherForecast | null = null;
  let prices_fetched = false;
  let weather_fetched = false;

  const { currentSOC, batteryCapacityWh, maxChargePowerW, maxDischargePowerW } = input;
  const { buy_when_price_below_sek, sell_when_price_above_sek, buy_when_free } = config.electricity_prices

  const { min_sunshine_to_store_for_evening, target_evening_soc } = config.weather

  try {
    prices = await priceService.fetchPrices(config.electricity_prices?.price_zone || "SE3");
    prices_fetched = true;
  } catch (e) {
    errors.push(`Failed to fetch prices: ${e}`);
  }

  try {
    weather = await weatherService.fetchForecast(config.weather.latitude, config.weather.longitude, 2);
    weather_fetched = true;
  } catch (e) {
    errors.push(`Failed to fetch weather: ${e}`);
  }

  const entries: ProposedScheduleEntry[] = [];
  const now = new Date();

  const todaysSunshineHours = weather ? weatherService.getTodaysSunshineHours(weather) : 0;
  const tomorrowsSunshineHours = weather ? weatherService.getTomorrowsSunshineHours(weather) : 0;

  const allPrices = prices ? [...prices.today, ...prices.tomorrow] : [];

  if (allPrices.length === 0) {
    errors.push("No price data available");
  }

  const priceMap = new Map<number, PriceInfo>();
  allPrices.forEach(p => {
    const startTime = new Date(p.time_start);
    const hour = startTime.getHours();
    priceMap.set(hour, p);
  });

  for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
    const targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + dayOffset);

    for (let hour = 0; hour < 24; hour++) {
      const scheduleTime = combineDateAndHour(targetDate, hour);
      if (scheduleTime <= now) continue;

      const priceInfo = priceMap.get(hour);
      const price = priceInfo?.SEK_per_kWh ?? 0;

      const hourWeather = weather?.hourly.find(h => {
        const time = new Date(h.time);
        return time.getHours() === hour && time.getDate() === scheduleTime.getDate();
      });
      const sunshineHours = hourWeather ? hourWeather.sunshine_duration / 3600 : 0;
      const solarGenerationkWh = hourWeather ? (hourWeather.shortwave_radiation * 0.18 * 10) / 1000 : 0;

      const socAtHour = estimateSOCAtHour(currentSOC, batteryCapacityWh, entries, scheduleTime, solarGenerationkWh);

      const isCheapPrice = price <= buy_when_price_below_sek;
      const isFreePrice = price <= 0.01 && buy_when_free;
      const isExpensivePrice = price >= sell_when_price_above_sek;
      const isEveningHour = hour >= 17 && hour <= 22;
      const isMorningHour = hour >= 6 && hour <= 9;

      if (isFreePrice || isCheapPrice) {
        if (socAtHour < target_evening_soc + 20) {
          const startTimeISO = formatISOWithTimezone(scheduleTime);
          const endTimeISO = formatISOWithTimezone(new Date(scheduleTime.getTime() + 60 * 60 * 1000));

          entries.push({
            start_time: startTimeISO,
            end_time: endTimeISO,
            action: "buy",
            power_watts: maxChargePowerW,
            reason: isFreePrice
              ? `Price is free (${price.toFixed(3)} SEK/kWh)`
              : `Price is low (${price.toFixed(2)} SEK/kWh)`,
            price_sek_per_kwh: price,
          });
        }
      }

      if (isExpensivePrice && socAtHour > 20) {
        const isHighSunshineExpected =
          (dayOffset === 0 && todaysSunshineHours >= min_sunshine_to_store_for_evening) ||
          (dayOffset === 1 && tomorrowsSunshineHours >= min_sunshine_to_store_for_evening);

        if (isHighSunshineExpected && isEveningHour) {
          continue;
        }

        const startTimeISO = formatISOWithTimezone(scheduleTime);
        const endTimeISO = formatISOWithTimezone(new Date(scheduleTime.getTime() + 60 * 60 * 1000));

        entries.push({
          start_time: startTimeISO,
          end_time: endTimeISO,
          action: "sell",
          power_watts: maxDischargePowerW,
          reason: isHighSunshineExpected
            ? `Price high (${price.toFixed(2)} SEK/kWh) but storing for evening`
            : `Price is high (${price.toFixed(2)} SEK/kWh)`,
          price_sek_per_kwh: price,
        });
      }
    }
  }

  logLog(
    `Generated plan with ${entries.length} entries. SOC: ${currentSOC}%, Sunshine today: ${todaysSunshineHours.toFixed(1)}h`
  );

  return {
    entries,
    based_on_soc: currentSOC,
    prices_fetched,
    weather_fetched,
    generated_at: new Date().toISOString(),
    errors,
  };
}

function estimateSOCAtHour(
  currentSOC: number,
  batteryCapacityWh: number,
  entries: ProposedScheduleEntry[],
  targetTime: Date,
  expectedSolarkWh: number
): number {
  let estimatedSOC = currentSOC;

  entries.forEach(entry => {
    const entryStart = new Date(entry.start_time);
    const entryEnd = new Date(entry.end_time);

    if (entryStart <= targetTime && targetTime < entryEnd) {
      const durationHours = 1;
      const energyWh = entry.power_watts * durationHours;

      if (entry.action === "buy") {
        estimatedSOC += (energyWh / batteryCapacityWh) * 100;
      } else {
        estimatedSOC -= (energyWh / batteryCapacityWh) * 100;
      }
    }
  });

  estimatedSOC += ((expectedSolarkWh * 1000) / batteryCapacityWh) * 100;

  return Math.max(0, Math.min(100, estimatedSOC));
}

export function clearPastScheduleEntries(config: Config): Config {
  const now = new Date();
  const nowISO = now.toISOString();

  const buyingSchedule = config.scheduled_power_buying.schedule;
  const sellingSchedule = config.scheduled_power_selling.schedule;

  const filteredBuying: typeof buyingSchedule = {};
  const filteredSelling: typeof sellingSchedule = {};

  Object.entries(buyingSchedule).forEach(([key, value]) => {
    if (value.end_time > nowISO) {
      filteredBuying[key] = value;
    }
  });

  Object.entries(sellingSchedule).forEach(([key, value]) => {
    if (value.end_time > nowISO) {
      filteredSelling[key] = value;
    }
  });

  return {
    ...config,
    scheduled_power_buying: {
      ...config.scheduled_power_buying,
      schedule: filteredBuying,
    },
    scheduled_power_selling: {
      ...config.scheduled_power_selling,
      schedule: filteredSelling,
    },
  };
}

export function mergeProposedEntriesIntoConfig(config: Config, proposedEntries: ProposedScheduleEntry[]): Config {
  const newBuyingSchedule = { ...config.scheduled_power_buying.schedule };
  const newSellingSchedule = { ...config.scheduled_power_selling.schedule };

  proposedEntries.forEach(entry => {
    if (entry.action === "buy") {
      newBuyingSchedule[entry.start_time] = {
        end_time: entry.end_time,
        charging_power: entry.power_watts,
      };
    } else if (entry.action === "sell") {
      newSellingSchedule[entry.start_time] = {
        end_time: entry.end_time,
        power_watts: entry.power_watts,
      };
    }
  });

  return {
    ...config,
    scheduled_power_buying: {
      ...config.scheduled_power_buying,
      schedule: newBuyingSchedule,
    },
    scheduled_power_selling: {
      ...config.scheduled_power_selling,
      schedule: newSellingSchedule,
    },
  };
}
