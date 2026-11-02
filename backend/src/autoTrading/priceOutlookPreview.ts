/**
 * Read-only preview of the SE3 daily-mean spot outlook: fetches today's open-meteo forecast and the
 * spot prices it needs, then prints the predicted D+2…D+6 daily means the way the winter study's
 * live_now.py does. Writes nothing and talks to no hardware, so it is safe to run next to the live
 * controller.
 *
 * Usage (from backend/):
 *   yarn node src/autoTrading/priceOutlookPreview.ts
 *   PRICE_AREA=SE3 yarn node src/autoTrading/priceOutlookPreview.ts   # the only area with a model
 */
import process from "process";
import { fetchPrices, fetchPriceSlotsForDate } from "./priceService.ts";
import { predictDailyMeanSpots } from "./priceOutlook.ts";
import { addDays, stockholmDateOf } from "../utilities/stockholmDate.ts";
import { isOutlookAvailableForArea } from "./priceOutlookCoefficients.ts";
import {
  dailyMeanSpotsOfSlots,
  outlookIssueDate,
  trailing30DayMeanSpot,
  trailingWindowDates,
} from "./priceOutlookInputs.ts";
import { fetchOutlookWeather } from "./priceOutlookWeather.ts";
import type { OutlookDayWeather } from "./priceOutlook.types.ts";

const area = process.env.PRICE_AREA ?? "SE3";
if (!isOutlookAvailableForArea(area)) {
  console.error(`No outlook for ${area}: the model's coefficients are fitted to SE3 prices`);
  process.exit(1);
}

const nowMs = Date.now();
const currentPrices = await fetchPrices(area);
const issueDate = outlookIssueDate(stockholmDateOf(nowMs), currentPrices.coversTomorrow);
if (!currentPrices.coversTomorrow) {
  console.log(`Tomorrow's prices aren't published yet, so the outlook is issued for yesterday (${issueDate})\n`);
}

// fetchPrices brings today and tomorrow; the rest of the window comes one published day at a time
const dailyMeanSpots = dailyMeanSpotsOfSlots(currentPrices.slots);
for (const date of trailingWindowDates(issueDate)) {
  if (dailyMeanSpots.has(date)) continue;
  for (const [slotDate, meanSpot] of dailyMeanSpotsOfSlots(await fetchPriceSlotsForDate(area, date))) {
    dailyMeanSpots.set(slotDate, meanSpot);
  }
}
const trailingMean = trailing30DayMeanSpot(issueDate, dailyMeanSpots);
if (!trailingMean.available) {
  console.error(
    `No ${area} spot prices for ${trailingMean.missingDates.join(", ")}; the trailing 30-day mean needs every day`
  );
  process.exit(1);
}

const weather = await fetchOutlookWeather(nowMs);
if (!weather) {
  console.error("No weather forecast (the warning above says why)");
  process.exit(1);
}
const result = predictDailyMeanSpots({
  weather,
  issueDate,
  dayAheadMeanSpot: dailyMeanSpots.get(addDays(issueDate, 1)) ?? Number.NaN,
  trailing30DayMeanSpot: trailingMean.meanSpot,
});
if (!result.available) {
  console.error(`Outlook unavailable: ${result.reason}`);
  process.exit(1);
}

const outlook = result.outlook;
if (!outlook.withinFittedSeason) {
  console.warn(
    `WARNING: ${issueDate} is outside the model's fitted months (October–March). Summer was never fitted or validated, so this outlook has no measured skill.\n`
  );
}
console.log(
  `issue ${outlook.issueDate}: D+1 mean ${outlook.dayAheadMeanSpot.toFixed(3)}, trailing-30 ${outlook.trailing30DayMeanSpot.toFixed(3)}, D+1 weather ${describeWeather(outlook.dayAheadWeather)}`
);
for (const day of outlook.days) {
  console.log(
    `  ${day.date} D+${day.leadDays}: ${describeWeather(day)} → predicted mean ${day.predictedMeanSpot.toFixed(3)} SEK/kWh`
  );
}
console.log(
  `  predicted mean(D+2..D+4) ${outlook.meanD2toD4.toFixed(3)}; max(D+2..D+5) ${outlook.maxD2toD5.toFixed(3)} (SEK/kWh spot, excl. VAT)`
);
process.exit(0);

function describeWeather(dayWeather: OutlookDayWeather): string {
  return [
    `nordic ${dayWeather.nordicWindCapacityFactor.toFixed(2)}`,
    `cont ${dayWeather.continentalWindCapacityFactor.toFixed(2)}`,
    `temp ${dayWeather.temperatureC.toFixed(1).padStart(5)}`,
    dayWeather.nonWorkingDay ? "off" : "work",
  ].join(" ");
}
