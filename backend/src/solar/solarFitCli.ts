/**
 * Runs the monthly solar refit by hand, exactly as the controller would (InfluxDB history +
 * open-meteo archives → worker-thread fit → gates), and prints the result. Read-only unless
 * --write is given, which persists backend/solar_model_state.json (e.g. to bootstrap before a
 * planPreview dry-run). Never touches config.json or the inverter — safe next to the live service.
 *
 * Usage (from backend/):  yarn node src/solar/solarFitCli.ts [--write]
 */
import { promises as fs_promises } from "fs";
import path from "path";
import process from "process";
import Influx from "influx";
import { mergeWithDefaults } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import { AZIMUTH_BIN_EDGES, ELEVATION_BIN_EDGES } from "./pvModel.ts";
import { refitSolarModel } from "./solarRefit.ts";
import { STATE_FILE_PATH } from "./solarModelStore.ts";

const configPath = path.resolve(path.dirname(process.argv[1]), "../..", "config.json");
const config = mergeWithDefaults(
  JSON.parse(await fs_promises.readFile(configPath, { encoding: "utf-8" })) as Partial<Config>
);
if (!config.influxdb) {
  console.error("No influxdb section in", configPath);
  process.exit(1);
}
const persist = process.argv.includes("--write");
const { judgement, computation, state } = await refitSolarModel({
  config,
  influxClient: new Influx.InfluxDB({ ...config.influxdb }),
  nowMs: Date.now(),
  persist,
});

console.log(`\n=== Solar refit: ${judgement.accepted ? "ACCEPTED" : "REJECTED"} ===`);
for (const reason of judgement.pageReasons) console.log("  would page (P2):", reason);
for (const reason of judgement.warnReasons) console.log("  warning:", reason);
console.log("  trailing year:", JSON.stringify(computation.trailing_year));
for (const stringKey of ["string1", "string2"] as const) {
  const { fit, level, capacity_change, mask_energy_change } = computation.strings[stringKey];
  const spec = config.automatic_trading.solar_model[stringKey];
  console.log(
    `\n${stringKey} (${spec.tilt_degrees}° / ${spec.azimuth_degrees}°, ${spec.nameplate_kwp} kWp): physical k ${fit.physical_k.toFixed(3)} ` +
      `(${((fit.physical_k / spec.nameplate_kwp) * 100).toFixed(0)} % of nameplate), sky ${fit.physical_sky_factor.toFixed(3)} | ` +
      `forecast k ${fit.forecast_k.toFixed(3)}, sky ${fit.forecast_sky_factor.toFixed(3)} | fit hours ${fit.fit_hours} | ` +
      `90-day level ${level.ratio?.toFixed(3) ?? "n/a"} (${level.modelled_kwh} kWh) | Δk ${capacity_change ?? "n/a"} | Δmask energy ${mask_energy_change ?? "n/a"}`
  );
  console.log(
    "az\\el " +
      ELEVATION_BIN_EDGES.slice(0, -1)
        .map(edge => String(edge).padStart(5))
        .join("")
  );
  fit.mask.forEach((row, azimuthBin) => {
    if (!fit.mask_sample_counts[azimuthBin]?.some(count => count > 0)) return;
    const cells = row.map((value, elevationBin) =>
      (fit.mask_sample_counts[azimuthBin][elevationBin] >= 6 ? value.toFixed(2) : ".").padStart(5)
    );
    console.log(String(AZIMUTH_BIN_EDGES[azimuthBin]).padStart(5) + " " + cells.join(""));
  });
}
console.log(
  persist && state ? `\nState written to ${STATE_FILE_PATH}` : "\n(dry run — nothing written; pass --write to persist)"
);
process.exit(0);
