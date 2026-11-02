import { addDays, calendarDateParts } from "../utilities/stockholmDate.ts";

/**
 * Whether a date (YYYY-MM-DD) is a weekend or holiday in the calendar the SE3 outlook was fitted with
 * (the winter study's issue_days.py): Saturdays, Sundays, the fixed days Jan 1, Jan 6, May 1, Jun 6,
 * Dec 24, 25, 26 and 31, and the Easter-bound Good Friday, Easter Monday and Ascension Day.
 *
 * Deliberately the study's list rather than the full Swedish calendar: the coefficients learned the
 * effect of exactly these days. Midsummer Eve (the Friday in Jun 19–25) is missing from it; that
 * never mattered to a fit on October–March issue days, and the model isn't validated for summer.
 * (Easter Sunday, Whitsun, Midsummer Day and All Saints' Day always fall on a weekend.)
 */
export function isNonWorkingDay(date: string): boolean {
  const [year, month, dayOfMonth] = calendarDateParts(date);
  const weekday = new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay();
  if (weekday === SUNDAY || weekday === SATURDAY) return true;
  if (FIXED_HOLIDAYS.has(date.slice(5))) return true;
  const easter = easterSunday(year);
  return date === addDays(easter, -2) || date === addDays(easter, 1) || date === addDays(easter, 39);
}

/** Easter Sunday (YYYY-MM-DD) of a Gregorian year: the anonymous Meeus/Jones/Butcher algorithm, as in the study */
export function easterSunday(year: number): string {
  const golden = year % 19;
  const century = Math.floor(year / 100);
  const yearInCentury = year % 100;
  const leapCenturies = Math.floor(century / 4);
  const centuryRest = century % 4;
  const correction = Math.floor((century + 8) / 25);
  const moonCorrection = Math.floor((century - correction + 1) / 3);
  const epact = (19 * golden + century - leapCenturies - moonCorrection + 15) % 30;
  const leapYearPart = Math.floor(yearInCentury / 4);
  const yearRest = yearInCentury % 4;
  // Never negative (32 + … outweighs epact ≤ 29 and yearRest ≤ 3), so JS % matches Python's here
  const weekdayOffset = (32 + 2 * centuryRest + 2 * leapYearPart - epact - yearRest) % 7;
  const monthCorrection = Math.floor((golden + 11 * epact + 22 * weekdayOffset) / 451);
  const daysFromMarch = epact + weekdayOffset - 7 * monthCorrection + 114;
  return isoDate(year, Math.floor(daysFromMarch / 31), (daysFromMarch % 31) + 1);
}

const SUNDAY = 0;
const SATURDAY = 6;
/** MM-DD: New Year, Epiphany, May Day, National Day, Christmas Eve/Day, Boxing Day, New Year's Eve */
const FIXED_HOLIDAYS = new Set(["01-01", "01-06", "05-01", "06-06", "12-24", "12-25", "12-26", "12-31"]);

function isoDate(year: number, month: number, dayOfMonth: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
}
