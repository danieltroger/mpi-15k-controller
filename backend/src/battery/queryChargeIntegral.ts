import type Influx from "influx";
import { logLog } from "../utilities/logging.ts";

/**
 * Charge (amp-hours) integrated from hall sensor 2 since `fromMs`, reconstructed from the RAW mV field
 * so it survives calibration changes and deploys (raw_voltage_mv_2 has full history; a calculated_current
 * field would only exist from the day this ships). The inner query derives amps from the same formula the
 * live signal uses, the outer integrates it — integral(amps, 1h) is directly amp-hours (charge positive).
 * We start at fromMs + 1 to exclude the exact anchor sample.
 */
export async function queryChargeIntegral(
  db: Influx.InfluxDB,
  fromMs: number,
  zeroCurrentMillivolts: number,
  millivoltsPerAmpere: number
): Promise<number> {
  const query =
    `SELECT integral("amps", 1h) as charge FROM ` +
    `(SELECT ("raw_voltage_mv_2" - ${zeroCurrentMillivolts}) / ${millivoltsPerAmpere} AS amps ` +
    `FROM "current_values" WHERE time >= ${fromMs + 1}ms)`;
  logLog("Querying Ah ledger charge integral from", new Date(fromMs).toISOString());

  const results = await db.query<{ charge: number | null }>(query);
  const charge = results[0]?.charge;

  if (charge != null && !isNaN(charge)) {
    logLog("Got Ah ledger charge integral:", charge, "Ah from", new Date(fromMs).toISOString());
    return charge;
  }

  // No samples yet (e.g. we just anchored) — 0 Ah accumulated is the right answer.
  logLog("No charge data found for Ah ledger from", new Date(fromMs).toISOString());
  return 0;
}
