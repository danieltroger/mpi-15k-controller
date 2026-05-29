import { Accessor, untrack } from "solid-js";
import { Config } from "../config/config.types";
import {
  generatePriceWeatherPlan,
  mergeProposedEntriesIntoConfig,
  clearPastScheduleEntries,
} from "../planGenerator/priceWeatherPlan";
import { priceService } from "../electricityPrices/priceService";
import { logLog, errorLog } from "../utilities/logging";

let scheduledTimeout: ReturnType<typeof setTimeout> | null = null;

async function runPlanGeneration(
  config: Accessor<Config>,
  setConfig: (value: Config | ((prev: Config) => Config)) => void,
  averageSOC: Accessor<number | undefined>
) {
  logLog("Running scheduled plan generation...");

  try {
    const currentConfig = untrack(config);
    const currentSOC = untrack(averageSOC);

    if (currentSOC === undefined) {
      errorLog("Cannot generate plan: SOC not available");
      return;
    }

    const prices = await priceService.fetchPrices(currentConfig.electricity_prices?.price_zone);

    if (prices.tomorrow.length === 0) {
      logLog("Tomorrow's prices not yet available, waiting...");
      for (let i = 0; i < 24; i++) {
        await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
        const retryPrices = await priceService.fetchPrices(currentConfig.electricity_prices?.price_zone, true);
        if (retryPrices.tomorrow.length > 0) {
          break;
        }
        logLog(`Retry ${i + 1}/24: still waiting for tomorrow's prices...`);
      }
    }

    const finalConfig = untrack(config);
    const result = await generatePriceWeatherPlan(finalConfig, {
      currentSOC,
      batteryCapacityWh: finalConfig.soc_calculations.current_state.capacity,
      maxChargePowerW: 15000,
      maxDischargePowerW: 15000,
    });

    if (result.errors.length > 0) {
      errorLog("Plan generation errors:", result.errors);
    }

    untrack(() => {
      setConfig(prev => ({
        ...prev,
        proposed_schedule: {
          entries: result.entries,
          generated_at: result.generated_at,
          based_on_soc: result.based_on_soc,
          prices_fetched: result.prices_fetched,
          weather_fetched: result.weather_fetched,
        },
      }));
    });

    logLog(`Proposed schedule generated with ${result.entries.length} entries`);
  } catch (e) {
    errorLog("Plan generation failed:", e);
  }
}

export function startPlanScheduler(
  configSignal: [Accessor<Config>, (value: Config | ((prev: Config) => Config)) => void],
  averageSOC: Accessor<number | undefined>
) {
  const [config, setConfig] = configSignal;

  const scheduleNextRun = () => {
    const now = new Date();
    const configVal = untrack(config);
    const timeStr = configVal.electricity_prices?.plan_generation_time || "13:10";
    const [targetHour, targetMinute] = timeStr.split(":").map(Number);

    let nextRun = new Date(now);
    nextRun.setHours(targetHour, targetMinute, 0, 0);

    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
    }

    const msUntilRun = nextRun.getTime() - now.getTime();
    logLog(`Plan scheduler scheduled for ${nextRun.toISOString()} (in ${Math.round(msUntilRun / 60000)} minutes)`);

    if (scheduledTimeout) {
      clearTimeout(scheduledTimeout);
    }

    scheduledTimeout = setTimeout(async () => {
      await runPlanGeneration(config, setConfig, averageSOC);
      scheduleNextRun();
    }, msUntilRun);
  };

  scheduleNextRun();
}

export function triggerManualPlanGeneration(
  configSignal: [Accessor<Config>, (value: Config | ((prev: Config) => Config)) => void],
  averageSOC: Accessor<number | undefined>
): Promise<void> {
  const [config, setConfig] = configSignal;
  return runPlanGeneration(config, setConfig, averageSOC);
}

export function acceptProposedSchedule(
  configSignal: [Accessor<Config>, (value: Config | ((prev: Config) => Config)) => void]
) {
  const [, setConfig] = configSignal;

  setConfig(prev => {
    const proposed = prev.proposed_schedule;
    if (!proposed || proposed.entries.length === 0) {
      return prev;
    }

    const clearedConfig = clearPastScheduleEntries(prev);
    const mergedConfig = mergeProposedEntriesIntoConfig(clearedConfig, proposed.entries);

    return {
      ...mergedConfig,
      proposed_schedule: {
        entries: [],
        generated_at: "",
        based_on_soc: 0,
        prices_fetched: false,
        weather_fetched: false,
      },
    };
  });

  logLog("Proposed schedule accepted and applied");
}

export function rejectProposedSchedule(
  configSignal: [Accessor<Config>, (value: Config | ((prev: Config) => Config)) => void]
) {
  const [config, setConfig] = configSignal;

  setConfig(prev => ({
    ...prev,
    proposed_schedule: {
      entries: [],
      generated_at: "",
      based_on_soc: 0,
      prices_fetched: false,
      weather_fetched: false,
    },
  }));

  logLog("Proposed schedule rejected");
}
