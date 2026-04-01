import { createForm, getValues, insert, remove, setValues, zodForm } from "@modular-forms/solid";
import type { Accessor } from "solid-js";
import { createEffect, createMemo, For, Show, untrack } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import {
  configToBuySellFormData,
  formValuesToConfig,
  type BuySellFormData,
} from "~/helpers/buySellConfigMapping";
import { buySellFormSchema } from "~/helpers/buySellFormSchema";
import {
  formatDurationLabel,
  rowDurationHours,
  rowEnergyKwh,
} from "~/helpers/scheduleRowDerived";
import type { Config } from "../../../backend/src/config/config.types";
import "./BuySellConfig.scss";

const emptyRow = (): BuySellFormData["buyingRows"][number] => ({
  start: "",
  end: "",
  power: 0,
});

function duplicateScheduleRow(
  form: ReturnType<typeof createForm<BuySellFormData>>[0],
  kind: "buyingRows" | "sellingRows",
  atIndex: number
) {
  const v = getValues(form);
  const row = v[kind]?.[atIndex];
  if (!row) return;
  insert(form, kind, {
    at: atIndex + 1,
    value: {
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
  return JSON.stringify({
    scheduled_power_buying: c.scheduled_power_buying,
    scheduled_power_selling: c.scheduled_power_selling,
  });
}

function ScheduleRowMeta(props: {
  form: ReturnType<typeof createForm<BuySellFormData>>[0];
  kind: "buyingRows" | "sellingRows";
  index: number;
}) {
  const line = createMemo(() => {
    const v = getValues(props.form);
    const row = v[props.kind]?.[props.index];
    if (!row) return { duration: "—", energy: "—" };
    const start = String(row.start ?? "");
    const end = String(row.end ?? "");
    const hours = rowDurationHours(start, end);
    if (hours === undefined) return { duration: "—", energy: "—" };
    const duration = formatDurationLabel(hours);
    const kwh = rowEnergyKwh(Number(row.power), hours);
    const energy = kwh === undefined ? "—" : `${kwh.toFixed(2)} kWh`;
    return { duration, energy };
  });
  return (
    <>
      <td class="buy-sell-config__meta">{line().duration}</td>
      <td class="buy-sell-config__meta">{line().energy}</td>
    </>
  );
}

/** Renders only when `getConfig()` is defined. `createForm` runs with server-backed `initialValues` so inputs are filled on first paint (no race with `setValues`). */
function BuySellFormInner(props: {
  getConfig: Accessor<Config>;
  setConfig: (config: Config) => Promise<boolean | undefined>;
}) {
  const [buySellForm, { Form, Field, FieldArray }] = createForm<BuySellFormData>({
    initialValues: configToBuySellFormData(untrack(() => props.getConfig())),
    validate: zodForm(buySellFormSchema),
    validateOn: "submit",
    revalidateOn: "input",
  });

  let lastAppliedSnap = buySellSliceKey(untrack(() => props.getConfig()));

  createEffect(() => {
    const c = props.getConfig();
    const snap = buySellSliceKey(c);
    if (snap === lastAppliedSnap) return;
    lastAppliedSnap = snap;
    setValues(buySellForm, configToBuySellFormData(c), {
      shouldDirty: false,
      shouldTouched: false,
    });
  });

  return (
    <Form
      class="buy-sell-config"
      onSubmit={async values => {
        const c = props.getConfig();
        const next = formValuesToConfig(values, c);
        const ok = await props.setConfig(next);
        if (ok) {
          setValues(buySellForm, configToBuySellFormData(next), {
            shouldDirty: false,
            shouldTouched: false,
          });
          lastAppliedSnap = buySellSliceKey(next);
        }
      }}
    >
      <div class="buy-sell-config__toolbar">
        <button
          type="button"
          class="buy-sell-config__btn buy-sell-config__btn--secondary"
          onClick={() => {
            const c = props.getConfig();
            const snap = buySellSliceKey(c);
            lastAppliedSnap = snap;
            setValues(buySellForm, configToBuySellFormData(c), {
              shouldDirty: false,
              shouldTouched: false,
            });
          }}
        >
          Reload from server
        </button>
        <button type="submit" class="buy-sell-config__btn buy-sell-config__btn--primary">
          Save
        </button>
      </div>

      <Show when={buySellForm.response.status === "error" && buySellForm.response.message}>
        <p class="buy-sell-config__form-error" role="alert">
          {buySellForm.response.message}
        </p>
      </Show>

      <section class="buy-sell-config__section" aria-labelledby="buy-sell-buying-heading">
        <h2 id="buy-sell-buying-heading">Buying from grid</h2>
        <p class="buy-sell-config__hint">
          Schedule when to charge from the grid (charging power in watts). Buying only applies when
          state of charge is below the limits below.
        </p>

        <div class="buy-sell-config__grid2">
          <label class="buy-sell-config__label">
            Only buy below SOC (%)
            <Field name="buyOnlyBelowSoc" type="number">
              {(field, p) => (
                <>
                  <input
                    {...p}
                    value={fieldValueForInput(field)}
                    class="buy-sell-config__input"
                    min={0}
                    max={100}
                    step="any"
                  />
                  <Show when={field.error}>
                    <span class="buy-sell-config__field-error">{field.error}</span>
                  </Show>
                </>
              )}
            </Field>
          </label>
          <label class="buy-sell-config__label">
            Start buying again below SOC (%)
            <Field name="buyStartAgainBelowSoc" type="number">
              {(field, p) => (
                <>
                  <input
                    {...p}
                    value={fieldValueForInput(field)}
                    class="buy-sell-config__input"
                    min={0}
                    max={100}
                    step="any"
                  />
                  <Show when={field.error}>
                    <span class="buy-sell-config__field-error">{field.error}</span>
                  </Show>
                </>
              )}
            </Field>
          </label>
          <label class="buy-sell-config__label">
            Max grid input (A)
            <Field name="maxGridInputAmperage" type="number">
              {(field, p) => (
                <>
                  <input
                    {...p}
                    value={fieldValueForInput(field)}
                    class="buy-sell-config__input"
                    min={0}
                    step="any"
                  />
                  <Show when={field.error}>
                    <span class="buy-sell-config__field-error">{field.error}</span>
                  </Show>
                </>
              )}
            </Field>
          </label>
        </div>

        <h3 class="buy-sell-config__subheading">Schedule</h3>
        <p class="buy-sell-config__hint buy-sell-config__hint--schedule">
          Duration and energy update as you edit. Energy assumes constant charging power for the
          window: kWh = (watts × hours) / 1000.
        </p>
        <FieldArray name="buyingRows">
          {fieldArray => (
            <>
              <div class="buy-sell-config__table-wrap">
                <table class="buy-sell-config__table">
                  <thead>
                    <tr>
                      <th scope="col">Start (local)</th>
                      <th scope="col">End (local)</th>
                      <th scope="col">Charging power (W)</th>
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
                        <td class="buy-sell-config__td-datetime">
                          <Field name={`buyingRows.${index()}.start`} type="string">
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
                          <Field name={`buyingRows.${index()}.end`} type="string">
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
                          <Field name={`buyingRows.${index()}.power`} type="number">
                            {(field, p) => (
                              <>
                                <input
                                  {...p}
                                  value={fieldValueForInput(field)}
                                  class="buy-sell-config__input"
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
                        <ScheduleRowMeta form={buySellForm} kind="buyingRows" index={index()} />
                        <td class="buy-sell-config__schedule-actions">
                          <div class="buy-sell-config__action-btns">
                            <button
                              type="button"
                              class="buy-sell-config__btn buy-sell-config__btn--small"
                              onClick={() => duplicateScheduleRow(buySellForm, "buyingRows", index())}
                            >
                              Duplicate
                            </button>
                            <button
                              type="button"
                              class="buy-sell-config__btn buy-sell-config__btn--small"
                              onClick={() => remove(buySellForm, "buyingRows", { at: index() })}
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
              <button
                type="button"
                class="buy-sell-config__btn buy-sell-config__btn--secondary"
                onClick={() => insert(buySellForm, "buyingRows", { value: emptyRow() })}
              >
                Add row
              </button>
              <Show when={fieldArray.error}>
                <p class="buy-sell-config__field-error">{fieldArray.error}</p>
              </Show>
            </>
          )}
        </FieldArray>
      </section>

      <section class="buy-sell-config__section" aria-labelledby="buy-sell-selling-heading">
        <h2 id="buy-sell-selling-heading">Selling to grid</h2>
        <p class="buy-sell-config__hint">
          Schedule export power (watts). Selling only applies when SOC and battery voltage are above
          the thresholds below.
        </p>

        <div class="buy-sell-config__grid2">
          <label class="buy-sell-config__label">
            Only sell above SOC (%)
            <Field name="sellOnlyAboveSoc" type="number">
              {(field, p) => (
                <>
                  <input
                    {...p}
                    value={fieldValueForInput(field)}
                    class="buy-sell-config__input"
                    min={0}
                    max={100}
                    step="any"
                  />
                  <Show when={field.error}>
                    <span class="buy-sell-config__field-error">{field.error}</span>
                  </Show>
                </>
              )}
            </Field>
          </label>
          <label class="buy-sell-config__label">
            Start selling again above SOC (%)
            <Field name="sellStartAgainAboveSoc" type="number">
              {(field, p) => (
                <>
                  <input
                    {...p}
                    value={fieldValueForInput(field)}
                    class="buy-sell-config__input"
                    min={0}
                    max={100}
                    step="any"
                  />
                  <Show when={field.error}>
                    <span class="buy-sell-config__field-error">{field.error}</span>
                  </Show>
                </>
              )}
            </Field>
          </label>
          <label class="buy-sell-config__label">
            Only sell above voltage (V)
            <Field name="onlySellAboveVoltage" type="number">
              {(field, p) => (
                <>
                  <input
                    {...p}
                    value={fieldValueForInput(field)}
                    class="buy-sell-config__input"
                    min={0}
                    step="any"
                  />
                  <Show when={field.error}>
                    <span class="buy-sell-config__field-error">{field.error}</span>
                  </Show>
                </>
              )}
            </Field>
          </label>
          <label class="buy-sell-config__label">
            Start selling again above voltage (V)
            <Field name="startSellingAgainAboveVoltage" type="number">
              {(field, p) => (
                <>
                  <input
                    {...p}
                    value={fieldValueForInput(field)}
                    class="buy-sell-config__input"
                    min={0}
                    step="any"
                  />
                  <Show when={field.error}>
                    <span class="buy-sell-config__field-error">{field.error}</span>
                  </Show>
                </>
              )}
            </Field>
          </label>
        </div>

        <h3 class="buy-sell-config__subheading">Schedule</h3>
        <p class="buy-sell-config__hint buy-sell-config__hint--schedule">
          Duration and energy update as you edit. Energy assumes constant export power for the
          window: kWh = (watts × hours) / 1000.
        </p>
        <FieldArray name="sellingRows">
          {fieldArray => (
            <>
              <div class="buy-sell-config__table-wrap">
                <table class="buy-sell-config__table">
                  <thead>
                    <tr>
                      <th scope="col">Start (local)</th>
                      <th scope="col">End (local)</th>
                      <th scope="col">Export (W)</th>
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
                        <td class="buy-sell-config__td-datetime">
                          <Field name={`sellingRows.${index()}.start`} type="string">
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
                          <Field name={`sellingRows.${index()}.end`} type="string">
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
                          <Field name={`sellingRows.${index()}.power`} type="number">
                            {(field, p) => (
                              <>
                                <input
                                  {...p}
                                  value={fieldValueForInput(field)}
                                  class="buy-sell-config__input"
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
                        <ScheduleRowMeta form={buySellForm} kind="sellingRows" index={index()} />
                        <td class="buy-sell-config__schedule-actions">
                          <div class="buy-sell-config__action-btns">
                            <button
                              type="button"
                              class="buy-sell-config__btn buy-sell-config__btn--small"
                              onClick={() => duplicateScheduleRow(buySellForm, "sellingRows", index())}
                            >
                              Duplicate
                            </button>
                            <button
                              type="button"
                              class="buy-sell-config__btn buy-sell-config__btn--small"
                              onClick={() => remove(buySellForm, "sellingRows", { at: index() })}
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
              <button
                type="button"
                class="buy-sell-config__btn buy-sell-config__btn--secondary"
                onClick={() => insert(buySellForm, "sellingRows", { value: emptyRow() })}
              >
                Add row
              </button>
              <Show when={fieldArray.error}>
                <p class="buy-sell-config__field-error">{fieldArray.error}</p>
              </Show>
            </>
          )}
        </FieldArray>
      </section>
    </Form>
  );
}

export function BuySellConfigForm() {
  const [config, set_config] = getBackendSyncedSignal<Config>("config", undefined, false);

  return (
    <Show
      when={config()}
      fallback={<p class="buy-sell-config__loading">Loading configuration…</p>}
    >
      <BuySellFormInner
        getConfig={config as Accessor<Config>}
        setConfig={set_config!}
      />
    </Show>
  );
}
