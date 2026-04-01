/** Hours between `datetime-local` values; undefined if invalid or end ≤ start. */
export function rowDurationHours(startLocal: string, endLocal: string): number | undefined {
  if (!startLocal.trim() || !endLocal.trim()) return undefined;
  const a = new Date(startLocal).getTime();
  const b = new Date(endLocal).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return undefined;
  return (b - a) / (1000 * 60 * 60);
}

export function formatDurationLabel(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "—";
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Energy in kWh from average power (W) over `hours`. */
export function rowEnergyKwh(powerWatts: number, hours: number | undefined): number | undefined {
  if (hours === undefined || !Number.isFinite(powerWatts)) return undefined;
  const kwh = (powerWatts * hours) / 1000;
  return Number.isFinite(kwh) ? kwh : undefined;
}
