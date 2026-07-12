import {
  createForm,
  Field,
  FieldArray,
  getValues,
  insert,
  remove,
  reset,
  setValues,
  zodForm,
  type FieldPath,
  type FormStore,
} from "@modular-forms/solid";
import type { Accessor, JSX } from "solid-js";
import { createEffect, createMemo, For, getOwner, Show, untrack } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import {
  configToBuySellFormData,
  diffMergeFormIntoConfig,
  isoToDatetimeLocal,
  type BuySellFormData,
  type BuySellScheduleRow,
  type ScheduleRowKind,
} from "~/helpers/buySellConfigMapping";
import { buySellFormSchema } from "~/helpers/buySellFormSchema";
import { formatDurationLabel, rowDurationHours, rowEnergyKwh } from "~/helpers/scheduleRowDerived";
import type { Config } from "../../../backend/src/config/config.types";
import type { AutoTraderStatus, StateWindow } from "../../../backend/src/autoTrading/autoTraderState.types";
import "./BuySellConfig.scss";

type BuySellForm = FormStore<BuySellFormData, undefined>;

/** New rows start at the next full hour, one hour long, at a kind-appropriate default power. */
function emptyRow(kind: ScheduleRowKind, config: Config): BuySellScheduleRow {
  const start = new Date();
  start.setMinutes(60, 0, 0);
  const end = new Date(+start + 3600_000);
  const power =
    kind === "sell"
      ? config.automatic_trading?.max_sell_power_watts ?? 15000
      : config.automatic_trading?.max_buy_power_watts ?? 3000;
  return { kind, start: isoToDatetimeLocal(start.toISOString()), end: isoToDatetimeLocal(end.toISOString()), power };
}

function duplicateScheduleRow(form: BuySellForm, atIndex: number) {
  const values = getValues(form);
  const row = values.rows?.[atIndex];
  if (!row) return;
  insert(form, "rows", {
    at: atIndex + 1,
    value: {
      kind: (row.kind as ScheduleRowKind) ?? "sell",
      start: row.start ?? "",
      end: row.end ?? "",
      power: row.power ?? 0,
    },
  });
}

/** Modular Forms does not put `value` on the spread props — inputs must bind `field.value` or they stay empty. */
function fieldValueForInput(field: { value: unknown }): string | number {
  const v = field.value;
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? v : "";
  return String(v);
}

function buySellSliceKey(c: Config): string {
  const t = c.automatic_trading;
  return JSON.stringify({
    scheduled_power_buying: c.scheduled_power_buying,
    scheduled_power_selling: c.scheduled_power_selling,
    floors: [t.emergency_soc_floor_percent, t.planner_soc_floor_percent, t.planner_soc_floor_sunny_percent],
    reserve: t.extra_reserve_kwh,
  });
}

/** A labelled number input with its explanation underneath — the whole form is made of these. */
function NumberField(props: {
  form: BuySellForm;
  name: FieldPath<BuySellFormData>;
  label: string;
  unit: string;
  help: string;
  min?: number;
  max?: number;
}) {
  return (
    <label class="buy-sell-config__label">
      <span>
        {props.label} <span class="buy-sell-config__unit">({props.unit})</span>
      </span>
      <Field of={props.form} name={props.name} type="number">
        {(field, p) => (
          <>
            <input
              {...p}
              value={fieldValueForInput(field)}
              class="buy-sell-config__input"
              type="number"
              min={props.min}
              max={props.max}
              step="any"
            />
            <Show when={field.error}>
              <span class="buy-sell-config__field-error">{field.error}</span>
            </Show>
          </>
        )}
      </Field>
      <span class="buy-sell-config__help">{props.help}</span>
    </label>
  );
}

function ScheduleRowMeta(props: { form: BuySellForm; index: number }) {
  const line = createMemo(() => {
    const values = getValues(props.form);
    const row = values.rows?.[props.index];
    if (!row) return { duration: "—", energy: "—" };
    const hours = rowDurationHours(String(row.start ?? ""), String(row.end ?? ""));
    if (hours === undefined) return { duration: "—", energy: "—" };
    const kwh = rowEnergyKwh(Number(row.power), hours);
    return { duration: formatDurationLabel(hours), energy: kwh === undefined ? "—" : `${kwh.toFixed(2)} kWh` };
  });
  return (
    <>
      <td class="buy-sell-config__meta">{line().duration}</td>
      <td class="buy-sell-config__meta">{line().energy}</td>
    </>
  );
}

/** A row is "planned" when it matches a window of the trader's last plan exactly (any edit makes it yours). */
function rowIsPlanned(
  row: { kind?: string; start?: string; end?: string; power?: number },
  plannedWindows: StateWindow[] | undefined
): boolean {
  if (!plannedWindows) return false;
  return plannedWindows.some(
    w =>
      w.kind === row.kind &&
      isoToDatetimeLocal(w.start) === row.start &&
      isoToDatetimeLocal(w.end) === row.end &&
      w.watts === Number(row.power)
  );
}

/** Renders only when `getConfig()` is defined. `createForm` runs with server-backed `initialValues` so inputs are filled on first paint (no race with `setValues`). */
function BuySellFormInner(props: {
  getConfig: Accessor<Config>;
  setConfig: (config: Config) => Promise<boolean | undefined>;
}) {
  const [status] = getBackendSyncedSignal<AutoTraderStatus>("autoTraderStatus");
  const [buySellForm, { Form }] = createForm<BuySellFormData>({
    initialValues: configToBuySellFormData(untrack(() => props.getConfig())),
    validate: zodForm(buySellFormSchema),
    validateOn: "submit",
    revalidateOn: "input",
  });

  let lastAppliedSnap = buySellSliceKey(untrack(() => props.getConfig()));
  // What the form was last synced from — saves only apply the diff vs this, so server-side
  // changes (e.g. the auto-trader writing windows) survive a save from an open tab.
  let pristine = configToBuySellFormData(untrack(() => props.getConfig()));

  const resetToServer = () => {
    const c = props.getConfig();
    lastAppliedSnap = buySellSliceKey(c);
    pristine = configToBuySellFormData(c);
    // reset (not setValues): it also clears the dirty flag, which hides the savebar again
    reset(buySellForm, { initialValues: pristine });
  };

  createEffect(() => {
    const c = props.getConfig();
    const snap = buySellSliceKey(c);
    if (snap === lastAppliedSnap) return;
    lastAppliedSnap = snap;
    // Don't clobber in-progress edits; the diff-merge on save reconciles instead
    if (buySellForm.dirty) return;
    pristine = configToBuySellFormData(c);
    setValues(buySellForm, pristine, { shouldDirty: false, shouldTouched: false });
  });

  const plannedWindows = () => status()?.last_plan?.windows;

  return (
    <Form
      class="buy-sell-config"
      onSubmit={async values => {
        // modular-forms hands over an empty FieldArray as undefined — normalize before merging
        const raw = values as BuySellFormData;
        const normalized: BuySellFormData = { ...raw, rows: raw.rows ?? [] };
        const next = diffMergeFormIntoConfig(pristine, normalized, props.getConfig());
        const ok = await props.setConfig(next);
        const owner = getOwner()!;
        if (ok) {
          await showToastWithMessage(owner, () => "Saved!");
          pristine = configToBuySellFormData(next);
          reset(buySellForm, { initialValues: pristine });
          lastAppliedSnap = buySellSliceKey(next);
        }
      }}
    >
      <section class="buy-sell-config__section" aria-labelledby="reserve-heading">
        <h2 id="reserve-heading">Battery reserve &amp; floors</h2>
        <p class="buy-sell-config__hint">
          The ladder the planner works between, from the hard bottom up. Emergency ≤ sunny ≤ planner floor.
        </p>
        <div class="buy-sell-config__grid2">
          <NumberField
            form={buySellForm}
            name="emergencySocFloor"
            label="Emergency floor"
            unit="% SOC"
            min={0}
            max={100}
            help="The hard bottom. Below this the battery is effectively empty and the house pulls from the grid — the planner prices those unavoidable imports."
          />
          <NumberField
            form={buySellForm}
            name="plannerSocFloor"
            label="Planner floor"
            unit="% SOC"
            min={0}
            max={100}
            help="Plans never project SOC below this. Your overnight safety margin against forecast misses."
          />
          <NumberField
            form={buySellForm}
            name="plannerSocFloorSunny"
            label="Sunny floor"
            unit="% SOC"
            min={0}
            max={100}
            help="Relaxed floor used while forecast solar covers the house — a miss then costs minutes of import, not a stranded night."
          />
          <NumberField
            form={buySellForm}
            name="extraReserveKwh"
            label="Extra reserve"
            unit="kWh"
            min={0}
            help="Kept on top of the floors when planning, e.g. for charging the car tonight."
          />
        </div>
      </section>

      <section class="buy-sell-config__section" aria-labelledby="guards-heading">
        <h2 id="guards-heading">Runtime guards</h2>
        <p class="buy-sell-config__hint">
          Hard stops the controller enforces while a window runs, regardless of what was planned. Each pair is a
          hysteresis: stop at one value, resume only past the other.
        </p>
        <h3 class="buy-sell-config__subheading">Selling</h3>
        <div class="buy-sell-config__grid2">
          <NumberField
            form={buySellForm}
            name="sellOnlyAboveSoc"
            label="Stop selling below"
            unit="% SOC"
            min={0}
            max={100}
            help="Selling pauses the moment SOC drops under this."
          />
          <NumberField
            form={buySellForm}
            name="sellStartAgainAboveSoc"
            label="Resume selling above"
            unit="% SOC"
            min={0}
            max={100}
            help="…and only resumes once SOC has recovered past this."
          />
          <NumberField
            form={buySellForm}
            name="onlySellAboveVoltage"
            label="Stop selling below"
            unit="V"
            min={0}
            help="Voltage sags under load — this catches an empty battery faster than SOC can."
          />
          <NumberField
            form={buySellForm}
            name="startSellingAgainAboveVoltage"
            label="Resume selling above"
            unit="V"
            min={0}
            help="Recovery voltage before selling may continue."
          />
        </div>
        <h3 class="buy-sell-config__subheading">Buying</h3>
        <div class="buy-sell-config__grid2">
          <NumberField
            form={buySellForm}
            name="buyOnlyBelowSoc"
            label="Stop charging above"
            unit="% SOC"
            min={0}
            max={100}
            help="Grid charging stops once SOC reaches this."
          />
          <NumberField
            form={buySellForm}
            name="buyStartAgainBelowSoc"
            label="Resume charging below"
            unit="% SOC"
            min={0}
            max={100}
            help="…and only starts again if SOC falls back under this."
          />
          <NumberField
            form={buySellForm}
            name="maxGridInputAmperage"
            label="Max grid draw"
            unit="A"
            min={0}
            help="Cap on total grid current while charging — protects the main fuse."
          />
        </div>
      </section>

      <section class="buy-sell-config__section" aria-labelledby="schedule-heading">
        <h2 id="schedule-heading">Schedule</h2>
        <p class="buy-sell-config__hint">
          Everything the controller will do, in order. Rows with a
          <span class="buy-sell-config__kind-inline">⚡ planned</span>
          badge were written by the auto-trader — edit or delete them freely: an edited window becomes yours and is
          planned around; deleting one blocks trading in that time range until unblocked.
        </p>
        <FieldArray of={buySellForm} name="rows">
          {fieldArray => (
            <>
              <div class="buy-sell-config__table-wrap">
                <table class="buy-sell-config__table">
                  <thead>
                    <tr>
                      <th scope="col">What</th>
                      <th scope="col">Start (local)</th>
                      <th scope="col">End (local)</th>
                      <th scope="col">Power (W)</th>
                      <th scope="col">Duration</th>
                      <th scope="col">Energy</th>
                      <th scope="col" class="buy-sell-config__th-actions">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={fieldArray.items}>
                      {(_, index) => (
                        <tr>
                          <td class="buy-sell-config__td-kind">
                            <Field of={buySellForm} name={`rows.${index()}.kind`} type="string">
                              {(field, p) => (
                                <>
                                  <input {...p} type="hidden" value={String(field.value ?? "sell")} />
                                  <span
                                    classList={{
                                      "buy-sell-config__kind": true,
                                      "buy-sell-config__kind--sell": field.value === "sell",
                                      "buy-sell-config__kind--buy": field.value === "buy",
                                    }}
                                  >
                                    {field.value === "sell" ? "Sell" : "Buy"}
                                  </span>
                                  <Show
                                    when={rowIsPlanned(getValues(buySellForm).rows?.[index()] ?? {}, plannedWindows())}
                                  >
                                    <span
                                      class="buy-sell-config__planned"
                                      title="Written by the auto-trader — editing makes it yours"
                                    >
                                      ⚡ planned
                                    </span>
                                  </Show>
                                </>
                              )}
                            </Field>
                          </td>
                          <td class="buy-sell-config__td-datetime">
                            <Field of={buySellForm} name={`rows.${index()}.start`} type="string">
                              {(field, p) => (
                                <>
                                  <input
                                    {...p}
                                    value={fieldValueForInput(field)}
                                    class="buy-sell-config__input"
                                    type="datetime-local"
                                    step={60}
                                  />
                                  <Show when={field.error}>
                                    <span class="buy-sell-config__field-error">{field.error}</span>
                                  </Show>
                                </>
                              )}
                            </Field>
                          </td>
                          <td class="buy-sell-config__td-datetime">
                            <Field of={buySellForm} name={`rows.${index()}.end`} type="string">
                              {(field, p) => (
                                <>
                                  <input
                                    {...p}
                                    value={fieldValueForInput(field)}
                                    class="buy-sell-config__input"
                                    type="datetime-local"
                                    step={60}
                                  />
                                  <Show when={field.error}>
                                    <span class="buy-sell-config__field-error">{field.error}</span>
                                  </Show>
                                </>
                              )}
                            </Field>
                          </td>
                          <td>
                            <Field of={buySellForm} name={`rows.${index()}.power`} type="number">
                              {(field, p) => (
                                <>
                                  <input
                                    {...p}
                                    value={fieldValueForInput(field)}
                                    class="buy-sell-config__input"
                                    type="number"
                                    min={0}
                                    step="any"
                                  />
                                  <Show when={field.error}>
                                    <span class="buy-sell-config__field-error">{field.error}</span>
                                  </Show>
                                </>
                              )}
                            </Field>
                          </td>
                          <ScheduleRowMeta form={buySellForm} index={index()} />
                          <td class="buy-sell-config__schedule-actions">
                            <div class="buy-sell-config__action-btns">
                              <button
                                type="button"
                                class="buy-sell-config__btn buy-sell-config__btn--small"
                                onClick={() => duplicateScheduleRow(buySellForm, index())}
                              >
                                Duplicate
                              </button>
                              <button
                                type="button"
                                class="buy-sell-config__btn buy-sell-config__btn--small"
                                onClick={() => remove(buySellForm, "rows", { at: index() })}
                              >
                                Remove
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
              <div class="buy-sell-config__add-btns">
                <button
                  type="button"
                  class="buy-sell-config__btn buy-sell-config__btn--secondary"
                  onClick={() => insert(buySellForm, "rows", { value: emptyRow("sell", props.getConfig()) })}
                >
                  + Sell window
                </button>
                <button
                  type="button"
                  class="buy-sell-config__btn buy-sell-config__btn--secondary"
                  onClick={() => insert(buySellForm, "rows", { value: emptyRow("buy", props.getConfig()) })}
                >
                  + Buy window
                </button>
              </div>
              <Show when={fieldArray.error}>
                <p class="buy-sell-config__field-error">{fieldArray.error}</p>
              </Show>
            </>
          )}
        </FieldArray>
      </section>

      {/* Appears only while there is something to save — the page's single write path */}
      <Show when={buySellForm.dirty}>
        <div class="buy-sell-config__savebar" role="status">
          <span class="buy-sell-config__savebar-text">
            Unsaved changes
            <Show when={buySellForm.response.status === "error" && buySellForm.response.message}>
              <span class="buy-sell-config__form-error"> — {buySellForm.response.message}</span>
            </Show>
          </span>
          <div class="buy-sell-config__savebar-actions">
            <button type="button" class="buy-sell-config__btn buy-sell-config__btn--secondary" onClick={resetToServer}>
              Discard
            </button>
            <button type="submit" class="buy-sell-config__btn buy-sell-config__btn--primary">
              Save
            </button>
          </div>
        </div>
      </Show>
    </Form>
  );
}

export function BuySellConfigForm(): JSX.Element {
  const [config, set_config] = getBackendSyncedSignal<Config>("config", undefined, false);

  return (
    <Show when={config()} fallback={<p class="buy-sell-config__loading">Loading configuration…</p>}>
      <BuySellFormInner getConfig={config as Accessor<Config>} setConfig={set_config!} />
    </Show>
  );
}
