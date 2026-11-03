/**
 * Self-test of the settlement's meter correction (settlementGridPower.ts): quarters with the published
 * meter-equivalent fields use them, quarters without (history, the restart quarter) are rebuilt from 10-s means
 * of the raw reading through the same mapping, both registers count within a quarter, and at the identity
 * calibration the rebuild is the reading split by sign. Against a fake InfluxDB client. Run from backend/ with:
 *   yarn node src/autoTrading/settlementGridPower.selftest.ts
 */
import type Influx from "influx";
import { DEFAULT_METER_CALIBRATION, IDENTITY_METER_CALIBRATION } from "../grid/meterCalibrationBounds.ts";
import { meterEquivalentGrid } from "../grid/meterEquivalentGrid.ts";
import { SLOT_MS } from "./planner.ts";
import { check, finishSelftest } from "./plannerSelftestFixtures.ts";
import {
  publishedMeterFieldsCoverQuarter,
  querySettlementQuarters,
  reconstructQuarterMeterPower,
} from "./settlementGridPower.ts";
import { computeRealizedRevenue } from "./tradingPerformance.ts";

const DAY_START_MS = Date.UTC(2026, 9, 31, 23, 0); // 2026-11-01 00:00 Stockholm
const FEES = { sell_bonus_sek_per_kwh: 0.092, buy_surcharges_sek_per_kwh: 1.186, vat_multiplier: 1.25 };
const BUCKETS_PER_QUARTER = SLOT_MS / 10_000;

function nanoTime(ms: number) {
  return { getNanoTime: () => ms * 1e6 };
}

/** 10-s buckets for one quarter, `phaseSumAt(bucketIndex)` W each */
function quarterBuckets(quarterStartMs: number, phaseSumAt: (bucketIndex: number) => number, converter = "DC to AC") {
  return Array.from({ length: BUCKETS_PER_QUARTER }, (_, bucketIndex) => ({
    time: nanoTime(quarterStartMs + bucketIndex * 10_000),
    grid: phaseSumAt(bucketIndex),
    converter,
  }));
}

function meterExportOf(phaseSumWatts: number) {
  return meterEquivalentGrid(
    { phase_sum_watts: phaseSumWatts, converter_direction: "DC to AC" },
    DEFAULT_METER_CALIBRATION
  ).meter_equivalent_grid_export_watts;
}

// ---------- The rebuild from 10-s means ----------
{
  // One quarter that sold for half of it and imported for the other half: the meter counts both registers
  const mixed = reconstructQuarterMeterPower(
    Array.from({ length: BUCKETS_PER_QUARTER }, (_, bucketIndex) => ({
      startMs: DAY_START_MS + bucketIndex * 10_000,
      phaseSumW: bucketIndex < BUCKETS_PER_QUARTER / 2 ? -10_000 : 2_000,
      converter: bucketIndex < BUCKETS_PER_QUARTER / 2 ? "DC to AC" : "AC to DC",
    })),
    DEFAULT_METER_CALIBRATION
  );
  const mixedQuarter = mixed.byQuarterStartMs.get(DAY_START_MS);
  const expectedExportW = meterExportOf(-10_000) / 2;
  const expectedImportW = (2000 + 210 + 2.5 * 4) / 2;
  check(
    "rebuild: a quarter that sold, then charged, counts both registers at the meter",
    !!mixedQuarter &&
      Math.abs(mixedQuarter.exportW - expectedExportW) < 1e-9 &&
      Math.abs(mixedQuarter.importW - expectedImportW) < 1e-9,
    JSON.stringify(mixedQuarter)
  );
  const identity = reconstructQuarterMeterPower(
    [
      { startMs: DAY_START_MS, phaseSumW: -300, converter: "DC to AC" },
      { startMs: DAY_START_MS + 10_000, phaseSumW: 100, converter: "Idle" },
    ],
    IDENTITY_METER_CALIBRATION
  ).byQuarterStartMs.get(DAY_START_MS);
  check(
    "rebuild: at the identity calibration it is the reading split by sign, per bucket",
    identity?.exportW === 150 && identity?.importW === 50,
    JSON.stringify(identity)
  );
  const unknownDirection = reconstructQuarterMeterPower(
    [
      { startMs: DAY_START_MS, phaseSumW: 1000, converter: null },
      { startMs: DAY_START_MS + 10_000, phaseSumW: null, converter: "Idle" },
    ],
    DEFAULT_METER_CALIBRATION
  );
  check(
    "rebuild: a bucket without a converter direction counts as converting, and is counted for the log",
    unknownDirection.bucketsWithoutConverterDirection === 1 &&
      unknownDirection.byQuarterStartMs.get(DAY_START_MS)?.importW === 1000 + 210 + 2.5,
    JSON.stringify([...unknownDirection.byQuarterStartMs])
  );
  check(
    "coverage: as many published samples as readings cover the quarter",
    publishedMeterFieldsCoverQuarter(720, 720)
  );
  check("coverage: a few lost messages still cover it", publishedMeterFieldsCoverQuarter(700, 720));
  check("coverage: the restart quarter (fields from mid-quarter) doesn't", !publishedMeterFieldsCoverQuarter(300, 720));
  check("coverage: a quarter without the fields doesn't", !publishedMeterFieldsCoverQuarter(null, 720));
}

// ---------- A day: published quarters as they are, the others rebuilt ----------
{
  const quarterStarts = [0, 1, 2].map(quarterIndex => DAY_START_MS + quarterIndex * SLOT_MS);
  const quarterRows = [
    // Published: a full sell quarter
    {
      time: nanoTime(quarterStarts[0]),
      meter_import: 0,
      meter_export: 14196,
      meter_samples: 720,
      grid: -14654,
      grid_samples: 720,
      pv1: 0,
      pv2: 0,
      house: 315,
    },
    // The restart quarter: the fields only from mid-quarter, so rebuilt
    {
      time: nanoTime(quarterStarts[1]),
      meter_import: 0,
      meter_export: 50,
      meter_samples: 300,
      grid: -250,
      grid_samples: 720,
      pv1: 0,
      pv2: 0,
      house: 400,
    },
    // History: no fields at all
    {
      time: nanoTime(quarterStarts[2]),
      meter_import: null,
      meter_export: null,
      meter_samples: null,
      grid: -75,
      grid_samples: 720,
      pv1: 10,
      pv2: null,
      house: 500,
    },
  ];
  const bucketRows = [
    ...quarterBuckets(quarterStarts[1], () => -250),
    // Alternating 600 W pass-through import and 750 W export: the quarter's mean reading nets to −75 W
    ...quarterBuckets(quarterStarts[2], bucketIndex => (bucketIndex % 2 ? 600 : -750), "Idle"),
  ];
  const issuedQueries: string[] = [];
  const fakeInflux = {
    query: async (queryText: string) => {
      issuedQueries.push(queryText);
      return queryText.includes("GROUP BY time(15m)") ? quarterRows : bucketRows;
    },
  } as unknown as Influx.InfluxDB;
  const { quarters, notes } = await querySettlementQuarters(
    fakeInflux,
    DAY_START_MS,
    DAY_START_MS + 3 * SLOT_MS,
    DEFAULT_METER_CALIBRATION,
    "prefer-published"
  );
  check(
    "day: the published quarter uses the published fields",
    quarters[0].meterSource === "published" && quarters[0].meterExportW === 14196 && quarters[0].readingW === -14654
  );
  check(
    "day: the restart quarter is rebuilt from the 10-s means",
    quarters[1].meterSource === "reconstructed" &&
      Math.abs((quarters[1].meterExportW ?? NaN) - meterExportOf(-250)) < 1e-9
  );
  // The history quarter alternates: 600 W pass-through import (+105 W) and 750 W export, half each
  const historyExpectedImportW = (600 + 105 + 2.5 * 0.36) / 2;
  const historyExpectedExportW = meterExportOf(-750) / 2;
  check(
    "day: the history quarter is rebuilt, both registers counted where the reading's mean would net them away",
    quarters[2].meterSource === "reconstructed" &&
      Math.abs((quarters[2].meterImportW ?? NaN) - historyExpectedImportW) < 1e-9 &&
      Math.abs((quarters[2].meterExportW ?? NaN) - historyExpectedExportW) < 1e-9 &&
      quarters[2].pvW === 10,
    JSON.stringify(quarters[2])
  );
  check("day: the reconstruction notes no guesses", notes.bucketsWithoutConverterDirection === 0);
  check(
    "day: one quarter query and one 10-s query",
    issuedQueries.length === 2 && issuedQueries[1].includes("time(10s)")
  );
  check(
    "day: the 10-s query covers only the quarters that need the rebuild, not the published one",
    issuedQueries[1].includes(`time >= ${quarterStarts[1]}ms AND time < ${quarterStarts[2] + SLOT_MS}ms`),
    issuedQueries[1]
  );

  // The day's money at the meter against the reading: the sell is credited ~3 % lower
  const spot = 1.5;
  const meterRevenue = computeRealizedRevenue(
    quarters.map(quarter => ({ importW: quarter.meterImportW ?? 0, exportW: quarter.meterExportW ?? 0, spot })),
    0.25,
    FEES
  );
  const readingRevenue = computeRealizedRevenue(
    quarters.map(quarter => ({
      importW: Math.max(0, quarter.readingW ?? 0),
      exportW: Math.max(0, -(quarter.readingW ?? 0)),
      spot,
    })),
    0.25,
    FEES
  );
  check(
    "day: the meter-equivalent settlement exports less and earns less than the reading's",
    meterRevenue.export_kwh < readingRevenue.export_kwh && meterRevenue.revenue_sek < readingRevenue.revenue_sek,
    `(meter ${JSON.stringify(meterRevenue)}, reading ${JSON.stringify(readingRevenue)})`
  );

  // All quarters published: no 10-s query at all
  const publishedOnlyQueries: string[] = [];
  const publishedOnlyInflux = {
    query: async (queryText: string) => {
      publishedOnlyQueries.push(queryText);
      return [quarterRows[0]];
    },
  } as unknown as Influx.InfluxDB;
  await querySettlementQuarters(
    publishedOnlyInflux,
    DAY_START_MS,
    DAY_START_MS + SLOT_MS,
    DEFAULT_METER_CALIBRATION,
    "prefer-published"
  );
  check("day: a fully published day issues no 10-s query", publishedOnlyQueries.length === 1);
}

// ---------- The replay ("reconstruct-all"): published quarters never carry their recorded calibration in ----------
{
  // A published sell quarter, its fields recorded at the calibrated defaults; the raw reading under it
  const sellQuarterRow = {
    time: nanoTime(DAY_START_MS),
    meter_import: 0,
    meter_export: meterExportOf(-14654),
    meter_samples: 720,
    grid: -14654,
    grid_samples: 720,
    pv1: 0,
    pv2: 0,
    house: 315,
  };
  const replayInflux = {
    query: async (queryText: string) =>
      queryText.includes("GROUP BY time(15m)") ? [sellQuarterRow] : quarterBuckets(DAY_START_MS, () => -14654),
  } as unknown as Influx.InfluxDB;
  const atIdentity = await querySettlementQuarters(
    replayInflux,
    DAY_START_MS,
    DAY_START_MS + SLOT_MS,
    IDENTITY_METER_CALIBRATION,
    "reconstruct-all"
  );
  check(
    "replay: a published day replayed at the identity is the raw split, not the recorded calibration",
    atIdentity.quarters[0].meterSource === "reconstructed" &&
      atIdentity.quarters[0].meterExportW === 14654 &&
      atIdentity.quarters[0].meterImportW === 0 &&
      atIdentity.notes.publishedQuartersRecomputed === 1,
    JSON.stringify(atIdentity)
  );
  const preferringPublished = await querySettlementQuarters(
    replayInflux,
    DAY_START_MS,
    DAY_START_MS + SLOT_MS,
    IDENTITY_METER_CALIBRATION,
    "prefer-published"
  );
  check(
    "replay: the live settlement keeps the published quarter as recorded",
    preferringPublished.quarters[0].meterSource === "published" &&
      preferringPublished.quarters[0].meterExportW === meterExportOf(-14654) &&
      preferringPublished.notes.publishedQuartersRecomputed === 0
  );
}

finishSelftest();
