/**
 * Self-test of the outlook's open-meteo reply mapping (priceOutlookWeather.ts parseOutlookWeather):
 * sites by request order and location_id, unix seconds to instants, dropped null hours, and refusal of
 * any reply whose site order can't be trusted. Run from backend/ with:
 *   yarn node src/autoTrading/priceOutlookWeather.selftest.ts
 */
import process from "process";
import { OUTLOOK_TEMPERATURE_POINTS, OUTLOOK_WIND_POINTS } from "./priceOutlookCoefficients.ts";
import { parseOutlookWeather } from "./priceOutlookWeather.ts";
import type { OutlookTemperaturePointName, OutlookWindPointName } from "./priceOutlook.types.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

const WIND_POINT_NAMES = Object.keys(OUTLOOK_WIND_POINTS) as OutlookWindPointName[];
const TEMPERATURE_POINT_NAMES = Object.keys(OUTLOOK_TEMPERATURE_POINTS) as OutlookTemperaturePointName[];

// ---------- open-meteo reply mapping ----------
{
  const firstSeconds = Date.parse("2026-11-01T23:00:00Z") / 1000;
  const requestOrder = [...WIND_POINT_NAMES, ...TEMPERATURE_POINT_NAMES];
  // The real shape: open-meteo numbers every entry but the first
  const reply: SyntheticReplyEntry[] = requestOrder.map((_pointName, index) => ({
    ...(index > 0 ? { location_id: index } : {}),
    utc_offset_seconds: 3600,
    hourly: {
      time: [firstSeconds, firstSeconds + 3600],
      wind_speed_100m: [index, null],
      temperature_2m: [index + 0.5, index + 1.5],
    },
  }));
  const parsed = parseOutlookWeather(reply, 42);
  check(
    "reply: sites map by request order, unix seconds become instants, null hours drop",
    parsed.windSpeedByPoint.DK1_west.length === 1 &&
      parsed.windSpeedByPoint.DK1_west[0].atMs === firstSeconds * 1000 &&
      parsed.windSpeedByPoint.SE1_markbygden[0].value === requestOrder.indexOf("SE1_markbygden") &&
      parsed.temperatureByPoint.Orebro.map(sample => sample.value).join() ===
        `${requestOrder.indexOf("Orebro") + 0.5},${requestOrder.indexOf("Orebro") + 1.5}` &&
      parsed.fetchedAtMs === 42
  );
  const swapped = structuredClone(reply);
  swapped[1].location_id = 2;
  swapped[2].location_id = 1;
  check(
    "reply: a reordered reply is refused rather than swapping sites",
    throws(() => parseOutlookWeather(swapped, 0))
  );
  const unnumbered = structuredClone(reply);
  for (const entry of unnumbered) delete entry.location_id;
  check(
    "reply: a reply without location_ids is refused (its order can't be verified)",
    throws(() => parseOutlookWeather(unnumbered, 0))
  );
  check(
    "reply: a missing point is refused",
    throws(() => parseOutlookWeather(reply.slice(1), 0))
  );
  const labelled = structuredClone(reply).map(entry => ({
    ...entry,
    hourly: { ...entry.hourly, time: ["2026-11-02T00:00", "2026-11-02T01:00"] },
  }));
  check(
    "reply: local-time labels (no timeformat=unixtime) are refused",
    throws(() => parseOutlookWeather(labelled, 0))
  );
}

console.log(
  failedChecks.length ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}` : "\nAll scenarios passed"
);
process.exit(failedChecks.length ? 1 : 0);

type SyntheticReplyEntry = {
  location_id?: number;
  utc_offset_seconds: number;
  hourly: { time: number[]; wind_speed_100m: (number | null)[]; temperature_2m: number[] };
};

function throws(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}
