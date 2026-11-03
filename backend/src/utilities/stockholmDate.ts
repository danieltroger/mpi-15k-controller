/**
 * The Swedish calendar date of an instant, and plain date arithmetic on such dates: the one definition of
 * "a Stockholm day" the settlement, the price fetches, the expected spot and the price outlook share, so
 * they can't disagree about which day an instant belongs to.
 *
 * Pure (no runtime imports): the frontend may import it too.
 */

/** Main: the Europe/Stockholm calendar date (YYYY-MM-DD) an instant falls on: 23 h and 25 h days at the DST switches */
export function stockholmDateOf(ms: number): string {
  return STOCKHOLM_DATE_FORMAT.format(ms);
}

/**
 * A calendar date plus whole days, DST-free (plain date arithmetic, no instants involved). "N days from
 * today" is addDays(stockholmDateOf(nowMs), N), never stockholmDateOf(nowMs + N × 24 h): when that span
 * crosses a DST switch, the instant is off by one day in the hour next to midnight.
 */
export function addDays(date: string, days: number): string {
  const [year, month, dayOfMonth] = calendarDateParts(date);
  return new Date(Date.UTC(year, month - 1, dayOfMonth + days)).toISOString().slice(0, 10);
}

/** [year, month 1–12, day of month] of a YYYY-MM-DD date; throws on anything else */
export function calendarDateParts(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Expected a YYYY-MM-DD date, got "${date}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * sv-SE formats as YYYY-MM-DD, the same string toLocaleDateString("sv-SE", { timeZone }) gives; one shared
 * formatter because bucketing calls this for every forecast hour and price slot
 */
const STOCKHOLM_DATE_FORMAT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
