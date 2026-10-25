import type Influx from "influx";
import type { Config } from "../config/config.types.ts";
import { logLog } from "../utilities/logging.ts";

/**
 * Charge (amp-hours) integrated from hall sensor 2 since `fromMs`, reconstructed from the RAW mV field
 * so it survives calibration changes and deploys (raw_voltage_mv_2 has full history; a calculated_current
 * field would only exist from the day this ships). The inner query derives amps from the same formula the
 * live signal uses, the outer integrates it — integral(amps, 1h) is directly amp-hours (charge positive).
 * We start at fromMs + 1 to exclude the exact anchor sample, and stop where `untilCondition` says (ledger
 * start: local accumulation owns everything after it).
 */
export async function queryChargeIntegral({
  database,
  fromMs,
  untilCondition,
  zero_current_millivolts2,
  millivolts_per_ampere2,
}: {
  database: Influx.InfluxDB;
  fromMs: number;
  untilCondition: string;
} & Pick<Config["current_measuring"], "zero_current_millivolts2" | "millivolts_per_ampere2">): Promise<number> {
  const query =
    `SELECT integral("amps", 1h) as charge FROM ` +
    `(SELECT ("raw_voltage_mv_2" - ${zero_current_millivolts2}) / ${millivolts_per_ampere2} AS amps ` +
    `FROM "current_values" WHERE time >= ${fromMs + 1}ms AND ${untilCondition})`;
  logLog("Querying Ah ledger charge integral from", new Date(fromMs).toISOString());

  const results = await database.query<{ charge: number | null }>(query);
  const charge = results[0]?.charge;

  if (charge != null && !isNaN(charge)) {
    logLog("Got Ah ledger charge integral:", charge, "Ah from", new Date(fromMs).toISOString());
    return charge;
  }

  // No samples in the span (e.g. we anchored right before a restart) — 0 Ah accumulated is the right answer.
  logLog("No charge data found for Ah ledger from", new Date(fromMs).toISOString());
  return 0;
}
