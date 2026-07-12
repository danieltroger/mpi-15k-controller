import { z } from "zod";
import { datetimeLocalToIso, type BuySellFormData } from "./buySellConfigMapping";

const scheduleRowSchema = z.object({
  kind: z.enum(["sell", "buy"]),
  start: z.string(),
  end: z.string(),
  power: z.coerce.number(),
});

export const buySellFormSchema = z
  .object({
    emergencySocFloor: z.coerce.number().min(0).max(100),
    plannerSocFloor: z.coerce.number().min(0).max(100),
    plannerSocFloorSunny: z.coerce.number().min(0).max(100),
    extraReserveKwh: z.coerce.number().min(0),
    // Runtime SOC thresholds deliberately allow >100: setting a buy threshold to 101 means
    // "charge unconditionally" (and a sell cutoff >100 means "never sell") — both in live use.
    buyOnlyBelowSoc: z.coerce.number().min(0),
    buyStartAgainBelowSoc: z.coerce.number().min(0),
    maxGridInputAmperage: z.coerce.number().min(0),
    sellOnlyAboveSoc: z.coerce.number().min(0),
    sellStartAgainAboveSoc: z.coerce.number().min(0),
    onlySellAboveVoltage: z.coerce.number().min(0),
    startSellingAgainAboveVoltage: z.coerce.number().min(0),
    // .default([]): modular-forms materializes an EMPTY FieldArray as undefined, and a bare
    // z.array() then fails with "Required" — which made the whole form unsavable whenever the
    // schedule had no rows (e.g. after old windows were pruned).
    rows: z.array(scheduleRowSchema).default([]),
  })
  .superRefine((data, ctx) => {
    // The floors form a ladder (see AutomaticTradingConfig comments): the relaxed sunny floor may
    // never exceed the normal planner floor, the emergency bottom sits under both, and the
    // runtime sell cutoff must stay at or below the sunny floor or the planner would promise
    // energy the runtime refuses to deliver.
    if (data.plannerSocFloorSunny > data.plannerSocFloor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["plannerSocFloorSunny"],
        message: "Sunny floor must be ≤ the planner floor",
      });
    }
    if (data.emergencySocFloor > data.plannerSocFloorSunny) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["emergencySocFloor"],
        message: "Emergency floor must be ≤ the sunny floor",
      });
    }
    // (No hard rule tying the sell cutoff to the sunny floor: the config comment recommends
    // cutoff ≤ sunny floor, but the live systems run other arrangements on purpose.)
    // Hysteresis pairs must not invert
    if (data.sellStartAgainAboveSoc < data.sellOnlyAboveSoc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sellStartAgainAboveSoc"],
        message: "Resume threshold must be ≥ the stop threshold",
      });
    }
    if (data.startSellingAgainAboveVoltage < data.onlySellAboveVoltage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startSellingAgainAboveVoltage"],
        message: "Resume voltage must be ≥ the stop voltage",
      });
    }
    if (data.buyStartAgainBelowSoc > data.buyOnlyBelowSoc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["buyStartAgainBelowSoc"],
        message: "Resume threshold must be ≤ the stop threshold",
      });
    }

    const checkRows = (kind: "sell" | "buy") => {
      const seen = new Set<string>();
      data.rows.forEach((row, i) => {
        if (row.kind !== kind || row.start.trim() === "" || row.end.trim() === "") return;
        const k = datetimeLocalToIso(row.start);
        if (seen.has(k)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["rows", i, "start"],
            message: "Duplicate start time for this kind",
          });
        }
        seen.add(k);
      });
    };
    checkRows("sell");
    checkRows("buy");

    data.rows.forEach((row, i) => {
      const hasAny = row.start.trim() !== "" || row.end.trim() !== "";
      const hasAll = row.start.trim() !== "" && row.end.trim() !== "";
      if (hasAny && !hasAll) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows", i, "start"],
          message: "Set both start and end, or clear the row",
        });
      }
      if (hasAll && new Date(row.end) <= new Date(row.start)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows", i, "end"],
          message: "End must be after start",
        });
      }
    });
  });

export type ParsedBuySellForm = BuySellFormData;
