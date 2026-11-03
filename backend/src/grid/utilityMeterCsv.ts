/**
 * Parses the utility's 15-min meter-value export ("Mätvärdesexport", one CSV per direction) into energy per
 * UTC quarter — pure, the caller reads the file. The format: UTF-8 with a BOM, `;`-separated, decimal comma,
 * a facility header block, then `Starttidpunkt;Sluttidpunkt;Energiriktning;Kvalitet;Kvantitet` rows in Swedish
 * local time. On the autumn DST day the 02:00–03:00 hour appears twice in file order, summer time first.
 * Only the quarter rows are read; nothing from the header block (the facility id) leaves this function.
 */

export type UtilityMeterDirection = "import" | "export";

export function parseUtilityMeterCsv(csvText: string): {
  direction: UtilityMeterDirection;
  kwhByQuarterStartMs: Map<number, number>;
  /** Rows that weren't one 15-min quarter (the import file holds an hourly stretch in 2023) */
  skippedRows: number;
} {
  const lines = csvText.replace(/^﻿/, "").split(/\r?\n/);
  const headerIndex = lines.findIndex(line => line.startsWith("Starttidpunkt;"));
  if (headerIndex < 0) throw new Error("Not a meter-value export: no Starttidpunkt header row");
  const occurrencesByStartText = new Map<string, number>();
  const kwhByQuarterStartMs = new Map<number, number>();
  let direction: UtilityMeterDirection | undefined;
  let skippedRows = 0;
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) continue;
    const [startText, endText, directionText, , quantityText] = line.split(";");
    const rowDirection = DIRECTIONS[directionText];
    if (!rowDirection) throw new Error(`Unknown energy direction ${JSON.stringify(directionText)} in a meter row`);
    if (direction && rowDirection !== direction) throw new Error("A meter export mixes import and export rows");
    direction = rowDirection;
    const occurrence = occurrencesByStartText.get(startText) ?? 0;
    occurrencesByStartText.set(startText, occurrence + 1);
    const startMs = stockholmLocalTimeToUtcMs(startText, occurrence);
    let endMs = stockholmLocalTimeToUtcMs(endText, occurrence);
    // The quarter ending at the repeated hour's first 03:00 has its end on the second pass
    if (endMs <= startMs) endMs = stockholmLocalTimeToUtcMs(endText, 1);
    const kwh = Number(quantityText.replace(",", "."));
    if (endMs - startMs !== QUARTER_MS || !Number.isFinite(kwh)) {
      skippedRows++;
      continue;
    }
    kwhByQuarterStartMs.set(startMs, kwh);
  }
  if (!direction) throw new Error("The meter export has no rows");
  return { direction, kwhByQuarterStartMs, skippedRows };
}

/**
 * A Stockholm wall-clock time ("YYYY-MM-DD HH:MM:SS") as a UTC instant. A time the autumn switch repeats has
 * two: `occurrence` 0 is the summer-time one, 1 the winter-time one.
 */
export function stockholmLocalTimeToUtcMs(localText: string, occurrence: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(localText);
  if (!match) throw new Error(`Expected a "YYYY-MM-DD HH:MM:SS" time, got ${JSON.stringify(localText)}`);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const wallClockAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  // Stockholm is UTC+1 or UTC+2: the instant is whichever offset formats back to the same wall clock
  const candidates = [2, 1]
    .map(offsetHours => wallClockAsUtcMs - offsetHours * 3_600_000)
    .filter(candidateMs => STOCKHOLM_WALL_CLOCK.format(candidateMs) === localText);
  if (!candidates.length) throw new Error(`${localText} doesn't exist in Stockholm (the spring-forward gap)`);
  return candidates[Math.min(occurrence, candidates.length - 1)];
}

const QUARTER_MS = 15 * 60_000;

const DIRECTIONS: Readonly<Record<string, UtilityMeterDirection>> = {
  Förbrukning: "import",
  Produktion: "export",
};

/** sv-SE with a 24-hour clock formats as "YYYY-MM-DD HH:MM:SS", the export's own format */
const STOCKHOLM_WALL_CLOCK = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
