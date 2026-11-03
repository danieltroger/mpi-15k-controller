/**
 * Self-test of the meter-equivalent grid mapping (meterEquivalentGrid.ts): each calibrated regime against
 * the 2026-11-03 calibration's measurements, the exact identity at every setting 0, the grid switched off,
 * the sign handling (a small export that comes out as a net import), the PS-round plumbing
 * (meterEquivalentGridRound.ts) and the bounds correction (meterCalibrationBounds.ts). Run from backend/ with:
 *   yarn node src/grid/meterEquivalentGrid.selftest.ts
 */
import process from "process";
import { default_config } from "../config/config.ts";
import type { MeterCalibrationConfig } from "../config/config.types.ts";
import type { DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import {
  DEFAULT_METER_CALIBRATION,
  effectiveMeterCalibration,
  IDENTITY_METER_CALIBRATION,
  METER_CALIBRATION_BOUNDS,
} from "./meterCalibrationBounds.ts";
import { meterEquivalentGrid } from "./meterEquivalentGrid.ts";
import type { ConverterDirection } from "./meterEquivalentGrid.types.ts";
import { METER_EQUIVALENT_GRID_FIELD_NAMES, withMeterEquivalentGridFields } from "./meterEquivalentGridRound.ts";

const failedChecks: string[] = [];
function check(name: string, passed: boolean, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}: ${name} ${detail}`);
  if (!passed) failedChecks.push(name);
}

function meterOf(
  phaseSumWatts: number,
  converterDirection: ConverterDirection,
  calibration = DEFAULT_METER_CALIBRATION
) {
  const meterEquivalent = meterEquivalentGrid(
    { phase_sum_watts: phaseSumWatts, converter_direction: converterDirection },
    calibration
  );
  return {
    importW: meterEquivalent.meter_equivalent_grid_import_watts,
    exportW: meterEquivalent.meter_equivalent_grid_export_watts,
  };
}

function within(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

// ---------- The calibrated regimes, against what the meter counted ----------
{
  // Night feed at 350 W: the inverter reads ~250 W export, the meter exported ~48 W (median)
  const nightFeed = meterOf(-250, "DC to AC");
  check(
    "export: the night feed's ~250 W reading reaches the meter as ~50 W",
    within(nightFeed.exportW, 48, 5) && nightFeed.importW === 0,
    JSON.stringify(nightFeed)
  );
  // Sells at 14.5 kW: meter = 0.969 × the reading
  const sell = meterOf(-14500, "DC to AC");
  check(
    "export: a 14.5 kW sell reaches the meter at 0.969 × the reading",
    within(sell.exportW / 14500, 0.969, 0.002),
    `(${(sell.exportW / 14500).toFixed(4)})`
  );
  // The binned export curve: meter − |reading| = −215 W at 5 kW, −325 W at 11 kW (within ~30 W)
  check("export: 5 kW loses ~215 W", within(5000 - meterOf(-5000, "DC to AC").exportW, 215, 30));
  check("export: 11 kW loses ~325 W", within(11000 - meterOf(-11000, "DC to AC").exportW, 325, 30));
  // Buy windows at ~14.5 kW: the meter counts ~747 W more (×1.051)
  const buy = meterOf(14500, "AC to DC");
  check(
    "import: a 14.5 kW buy window counts ~747 W more at the meter",
    within(buy.importW - 14500, 747, 25) && buy.exportW === 0,
    `(+${(buy.importW - 14500).toFixed(0)} W)`
  );
  check("import: 12.5 kW charging counts ~608 W more", within(meterOf(12500, "AC to DC").importW - 12500, 608, 25));
  check("import: 1.5 kW charging counts ~226 W more", within(meterOf(1500, "AC to DC").importW - 1500, 226, 25));
  // Pass-through (converter idle): reading + 100–110 W
  const passThrough = meterOf(600, "Idle");
  check(
    "import: pass-through counts 100–110 W more",
    within(passThrough.importW - 600, 105, 6),
    `(+${(passThrough.importW - 600).toFixed(1)} W)`
  );
  // Hold / small charge, and the battery covering part of the house: reading + 205–215 W
  check("import: a small charge counts 205–215 W more", within(meterOf(400, "AC to DC").importW - 400, 210, 6));
  check(
    "import: the battery helping the house counts ~210 W more",
    within(meterOf(130, "DC to AC").importW - 130, 210, 6)
  );
}

// ---------- Grid off, and the sign handling ----------
{
  for (const converterDirection of ["DC to AC", "AC to DC", "Idle"] as const) {
    const gridOff = meterOf(0, converterDirection);
    check(
      `grid off (reading exactly 0, ${converterDirection}): the meter counts nothing`,
      gridOff.importW === 0 && gridOff.exportW === 0
    );
  }
  // A reading of −150 W is less than the inverter's draw: the meter sees a ~50 W import, no export
  const smallExport = meterOf(-150, "DC to AC");
  check(
    "sign: an export smaller than the draw comes out as a net import",
    smallExport.exportW === 0 && within(smallExport.importW, 50, 1),
    JSON.stringify(smallExport)
  );
  // Exactly at the draw: nothing either way
  const balanced = meterOf(-200, "DC to AC", { ...DEFAULT_METER_CALIBRATION, export_watts_per_kw_squared: 0 });
  check("sign: an export equal to the draw counts as nothing", balanced.exportW === 0 && balanced.importW === 0);
  // At most one register is non-zero, both ≥ 0, across the whole range
  let registersOk = true;
  for (let phaseSumWatts = -16000; phaseSumWatts <= 16000; phaseSumWatts += 37) {
    for (const converterDirection of ["DC to AC", "AC to DC", "Idle"] as const) {
      const meter = meterOf(phaseSumWatts, converterDirection);
      if (meter.importW < 0 || meter.exportW < 0 || (meter.importW > 0 && meter.exportW > 0)) registersOk = false;
      if (phaseSumWatts > 0 && meter.importW <= phaseSumWatts) registersOk = false; // an import never shrinks
      if (phaseSumWatts < 0 && meter.exportW >= -phaseSumWatts) registersOk = false; // an export never grows
    }
  }
  check("sign: both registers ≥ 0, at most one non-zero, imports only grow and exports only shrink", registersOk);
}

// ---------- The identity: every setting 0 reproduces the reading exactly ----------
{
  let identityExact = true;
  for (const phaseSumWatts of [-15123.5, -14654, -250, -1, -0.5, 0, 0.5, 1, 87, 9999.9, 15252]) {
    for (const converterDirection of ["DC to AC", "AC to DC", "Idle"] as const) {
      const meter = meterOf(phaseSumWatts, converterDirection, IDENTITY_METER_CALIBRATION);
      if (meter.importW !== Math.max(0, phaseSumWatts) || meter.exportW !== Math.max(0, -phaseSumWatts))
        identityExact = false;
    }
  }
  check("identity: every setting 0 = the reading split by sign, bit for bit", identityExact);
}

// ---------- The PS round: derived fields added next to the raw ones, never over them ----------
{
  const psRound: DecodedRound = {
    command: "PS",
    wireCommand: "PS",
    decodedAt: 1_793_700_000_000,
    fields: {
      ac_input_total_active_power: -14654,
      "dc/ac_power_direction": "DC to AC",
      line_power_direction: "Output",
    },
  };
  const { round, unmappable } = withMeterEquivalentGridFields(psRound, DEFAULT_METER_CALIBRATION);
  check(
    "round: a PS round gets both derived fields",
    METER_EQUIVALENT_GRID_FIELD_NAMES.every(name => typeof round.fields[name] === "number") && !unmappable
  );
  check(
    "round: the raw grid reading is untouched",
    round.fields.ac_input_total_active_power === -14654 &&
      psRound.fields.meter_equivalent_grid_export_watts === undefined
  );
  check(
    "round: the derived export is the mapping's, rounded to 0.1 W",
    round.fields.meter_equivalent_grid_export_watts === Math.round(meterOf(-14654, "DC to AC").exportW * 10) / 10 &&
      round.fields.meter_equivalent_grid_import_watts === 0
  );
  const gsRound: DecodedRound = { command: "GS", wireCommand: "GS", decodedAt: 0, fields: { battery_voltage: 52.1 } };
  const gsResult = withMeterEquivalentGridFields(gsRound, DEFAULT_METER_CALIBRATION);
  check("round: a GS round passes through unchanged", gsResult.round === gsRound && !gsResult.unmappable);
  const brokenRound: DecodedRound = {
    ...psRound,
    fields: { ac_input_total_active_power: 500, "dc/ac_power_direction": "Invalid option: 7" },
  };
  const brokenResult = withMeterEquivalentGridFields(brokenRound, DEFAULT_METER_CALIBRATION);
  check(
    "round: a PS round without a known converter direction is reported, not guessed",
    brokenResult.round === brokenRound && !!brokenResult.unmappable?.includes("dc/ac_power_direction"),
    brokenResult.unmappable
  );
}

// ---------- Bounds: the config default, clamping and non-numbers ----------
{
  check(
    "bounds: the config default is the calibrated defaults",
    JSON.stringify(default_config.meter_calibration) === JSON.stringify(DEFAULT_METER_CALIBRATION)
  );
  let defaultsInside = true;
  for (const [settingName, bounds] of Object.entries(METER_CALIBRATION_BOUNDS)) {
    if (bounds.defaultValue < bounds.min || bounds.defaultValue > bounds.max) defaultsInside = false;
    if (IDENTITY_METER_CALIBRATION[settingName as keyof MeterCalibrationConfig] < bounds.min) defaultsInside = false;
  }
  check("bounds: every default lies inside its bounds, and the identity (all 0) is allowed", defaultsInside);
  const corrected = effectiveMeterCalibration({
    export_draw_watts: 900,
    export_watts_per_kw_squared: -1,
    import_draw_converting_watts: "210",
    import_draw_pass_through_watts: 105,
  });
  check(
    "bounds: too high is clamped, negative and non-numbers fall back to the default, a missing key to its default",
    corrected.calibration.export_draw_watts === 500 &&
      corrected.calibration.export_watts_per_kw_squared === 1.2 &&
      corrected.calibration.import_draw_converting_watts === 210 &&
      corrected.calibration.import_draw_pass_through_watts === 105 &&
      corrected.calibration.feed_in_setpoint_shortfall_watts === 100 &&
      corrected.corrections.length === 5,
    JSON.stringify(corrected.corrections)
  );
  check(
    "bounds: an in-bounds calibration passes without corrections",
    effectiveMeterCalibration(DEFAULT_METER_CALIBRATION).corrections.length === 0
  );
}

console.log(
  failedChecks.length
    ? `\n${failedChecks.length} FAILURES: ${failedChecks.join(", ")}`
    : "\nAll meter-equivalent grid checks passed"
);
process.exit(failedChecks.length ? 1 : 0);
