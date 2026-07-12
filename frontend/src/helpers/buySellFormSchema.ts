import { z } from "zod";
import { datetimeLocalToIso, type BuySellFormData } from "./buySellConfigMapping";

const scheduleRowSchema = z.object({
  start: z.string(),
  end: z.string(),
  power: z.coerce.number(),
});

export const buySellFormSchema = z
  .object({
    buyOnlyBelowSoc: z.coerce.number(),
    buyStartAgainBelowSoc: z.coerce.number(),
    maxGridInputAmperage: z.coerce.number(),
    sellOnlyAboveSoc: z.coerce.number(),
    sellStartAgainAboveSoc: z.coerce.number(),
    onlySellAboveVoltage: z.coerce.number(),
    startSellingAgainAboveVoltage: z.coerce.number(),
    // .default([]): modular-forms materializes an EMPTY FieldArray as undefined, and a bare
    // z.array() then fails with "Required" — which made the whole form unsavable whenever the
    // buy schedule had no rows (e.g. after old buy windows were pruned).
    buyingRows: z.array(scheduleRowSchema).default([]),
    sellingRows: z.array(scheduleRowSchema).default([]),
  })
  .superRefine((data, ctx) => {
    const checkRows = (rows: BuySellFormData["buyingRows"], path: "buyingRows" | "sellingRows") => {
      const seen = new Set<string>();
      rows.forEach((row, i) => {
        if (row.start.trim() === "" || row.end.trim() === "") return;
        const k = datetimeLocalToIso(row.start);
        if (seen.has(k)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path, i, "start"],
            message: "Duplicate start time in this list",
          });
        }
        seen.add(k);
      });

      rows.forEach((row, i) => {
        const hasAny = row.start.trim() !== "" || row.end.trim() !== "";
        const hasAll = row.start.trim() !== "" && row.end.trim() !== "";
        if (hasAny && !hasAll) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [path, i, "start"],
            message: "Set both start and end, or clear the row",
          });
        }
        if (hasAll) {
          if (new Date(row.end) <= new Date(row.start)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [path, i, "end"],
              message: "End must be after start",
            });
          }
        }
      });
    };

    checkRows(data.buyingRows, "buyingRows");
    checkRows(data.sellingRows, "sellingRows");
  });
