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
import { addDays, stockholmDateOf } from "./priceOutlookCalendar.ts";
import { isOutlookAvailableForArea } from "./priceOutlookCoefficients.ts";
import { fetchOutlookWeather } from "./priceOutlookWeather.ts";
import type { PriceSlot15 } from "./planner.types.ts";
import type { OutlookDayWeather } from "./priceOutlook.types.ts";

/** D−28…D+1, as in the study */
const TRAILING_DAYS = 30;

const area = process.env.PRICE_AREA ?? "SE3";
if (!isOutlookAvailableForArea(area)) {
  console.error(`No outlook for ${area}: the model's coefficients are fitted to SE3 prices`);
  process.exit(1);
}

const nowMs = Date.now();
const today = stockholmDateOf(nowMs);
const currentPrices = await fetchPrices(area);
// The model's issue day D is one whose auction already published D+1: before ~13:00 that is yesterday
const issueDate = currentPrices.coversTomorrow ? today : addDays(today, -1);
if (!currentPrices.coversTomorrow) {
  console.log(`Tomorrow's prices aren't published yet, so the outlook is issued for yesterday (${issueDate})\n`);
}

const dailyMeanSpots = dailyMeansOfSlots(currentPrices.slots);
const trailingDates = Array.from({ length: TRAILING_DAYS }, (_unused, index) =>
  addDays(issueDate, index - TRAILING_DAYS + 2)
);
for (const date of trailingDates) {
  if (dailyMeanSpots.has(date)) continue;
  const slots = await fetchPriceSlotsForDate(area, date);
  if (!slots.length) {
    console.error(`No ${area} spot prices published for ${date}; the trailing 30-day mean needs every day`);
    process.exit(1);
  }
  dailyMeanSpots.set(date, meanSpot(slots));
}
const dayAheadMeanSpot = dailyMeanSpots.get(addDays(issueDate, 1)) ?? Number.NaN;
const trailing30DayMeanSpot =
  trailingDates.reduce((sum, date) => sum + (dailyMeanSpots.get(date) ?? Number.NaN), 0) / TRAILING_DAYS;

const weather = await fetchOutlookWeather(nowMs);
if (!weather) {
  console.error("No weather forecast (the warning above says why)");
  process.exit(1);
}
const result = predictDailyMeanSpots({ weather, issueDate, dayAheadMeanSpot, trailing30DayMeanSpot });
if (!result.available) {
  console.error(`Outlook unavailable: ${result.reason}`);
  process.exit(1);
}

const outlook = result.outlook;
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

/** Each Stockholm day's mean over the slots this fetch has of it (fetchPrices returns whole days) */
function dailyMeansOfSlots(slots: PriceSlot15[]): Map<string, number> {
  const slotsByDate = new Map<string, PriceSlot15[]>();
  for (const slot of slots) {
    const date = stockholmDateOf(slot.startMs);
    const dateSlots = slotsByDate.get(date) ?? [];
    dateSlots.push(slot);
    slotsByDate.set(date, dateSlots);
  }
  return new Map([...slotsByDate].map(([date, dateSlots]) => [date, meanSpot(dateSlots)]));
}

function meanSpot(slots: PriceSlot15[]): number {
  return slots.reduce((sum, slot) => sum + slot.spot, 0) / slots.length;
}

function describeWeather(dayWeather: OutlookDayWeather): string {
  return [
    `nordic ${dayWeather.nordicWindCapacityFactor.toFixed(2)}`,
    `cont ${dayWeather.continentalWindCapacityFactor.toFixed(2)}`,
    `temp ${dayWeather.temperatureC.toFixed(1).padStart(5)}`,
    dayWeather.nonWorkingDay ? "off" : "work",
  ].join(" ");
}
