import { createForm, getValues, insert, remove, setValues, zodForm } from "@modular-forms/solid";
import type { Accessor } from "solid-js";
import { createEffect, createMemo, For, Show, getOwner, untrack } from "solid-js";
import { getBackendSyncedSignal, sendBackendAction } from "~/helpers/getBackendSyncedSignal";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { configToBuySellFormData, formValuesToConfig, type BuySellFormData } from "~/helpers/buySellConfigMapping";
import { buySellFormSchema } from "~/helpers/buySellFormSchema";
import { formatDurationLabel, rowDurationHours, rowEnergyKwh } from "~/helpers/scheduleRowDerived";
import type { Config, ProposedScheduleEntry } from "../../../backend/src/config/config.types";
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

  const proposedSchedule = createMemo(() => props.getConfig()?.proposed_schedule);

  const hasProposedSchedule = createMemo(() => {
    const ps = proposedSchedule();
    return ps && ps.entries && ps.entries.length > 0;
  });

  const handleGeneratePlan = async () => {
    const owner = getOwner();
    if (!owner) return;

    try {
      await showToastWithMessage(owner, () => "Generating plan...");
      await sendBackendAction("generate_plan", "plan");
      await showToastWithMessage(owner, () => "Plan generated!");
    } catch (e) {
      const owner = getOwner();
      if (owner) {
        await showToastWithMessage(owner, () => "Failed to generate plan");
      }
    }
  };

  const handleAcceptPlan = async () => {
    const owner = getOwner();
    if (!owner) return;

    try {
      const c = props.getConfig();
      const ps = c.proposed_schedule;
      if (!ps || !ps.entries.length) return;

      const newConfig = { ...c };
      ps.entries.forEach((entry: ProposedScheduleEntry) => {
        if (entry.action === "buy") {
          newConfig.scheduled_power_buying = {
            ...newConfig.scheduled_power_buying,
            schedule: {
              ...newConfig.scheduled_power_buying.schedule,
              [entry.start_time]: {
                end_time: entry.end_time,
                charging_power: entry.power_watts,
              },
            },
          };
        } else if (entry.action === "sell") {
          newConfig.scheduled_power_selling = {
            ...newConfig.scheduled_power_selling,
            schedule: {
              ...newConfig.scheduled_power_selling.schedule,
              [entry.start_time]: {
                end_time: entry.end_time,
                power_watts: entry.power_watts,
              },
            },
          };
        }
      });

      newConfig.proposed_schedule = {
        entries: [],
        generated_at: "",
        based_on_soc: 0,
        prices_fetched: false,
        weather_fetched: false,
      };

      await props.setConfig(newConfig);
      await showToastWithMessage(owner, () => "Plan accepted!");
    } catch (e) {
      const owner = getOwner();
      if (owner) {
        await showToastWithMessage(owner, () => "Failed to accept plan");
      }
    }
  };

  const handleRejectPlan = async () => {
    const owner = getOwner();
    if (!owner) return;

    try {
      const c = props.getConfig();
      const updatedConfig = {
        ...c,
        proposed_schedule: {
          entries: [],
          generated_at: "",
          based_on_soc: 0,
          prices_fetched: false,
          weather_fetched: false,
        },
      };
      await props.setConfig(updatedConfig);
      await showToastWithMessage(owner, () => "Plan rejected");
    } catch (e) {
      const owner = getOwner();
      if (owner) {
        await showToastWithMessage(owner, () => "Failed to reject plan");
      }
    }
  };

  return (
    <Form
      class="buy-sell-config"
      onSubmit={async values => {
        const c = props.getConfig();
        const next = formValuesToConfig(values, c);
        const ok = await props.setConfig(next);
        const owner = getOwner()!;
        if (ok) {
          await showToastWithMessage(owner, () => "Saved!");
          setValues(buySellForm, configToBuySellFormData(next), {
            shouldDirty: false,
            shouldTouched: false,
          });
          lastAppliedSnap = buySellSliceKey(next);
        }
      }}
    >
      <Show when={hasProposedSchedule()}>
        <section class="buy-sell-config__section" aria-labelledby="proposed-plan-heading">
          <h2 id="proposed-plan-heading">Proposed Power Plan</h2>
          <p class="buy-sell-config__hint">
            A new plan has been generated based on current SOC ({proposedSchedule()?.based_on_soc?.toFixed(0)}%)
            {proposedSchedule()?.prices_fetched ? " and electricity prices" : ""}
            {proposedSchedule()?.weather_fetched ? " and weather forecasts" : ""}. Review and accept or reject.
          </p>

          <div class="buy-sell-config__table-wrap">
            <table class="buy-sell-config__table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Action</th>
                  <th scope="col">Power (W)</th>
                  <th scope="col">Price (SEK/kWh)</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                <For each={proposedSchedule()?.entries || []}>
                  {entry => (
                    <tr>
                      <td>
                        {new Date(entry.start_time).toLocaleString("sv-SE", { hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td
                        class={entry.action === "buy" ? "buy-sell-config__action-buy" : "buy-sell-config__action-sell"}
                      >
                        {entry.action === "buy" ? "Buy" : "Sell"}
                      </td>
                      <td>{entry.power_watts} W</td>
                      <td>{entry.price_sek_per_kwh?.toFixed(2) || "—"}</td>
                      <td>{entry.reason}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>

          <div class="buy-sell-config__toolbar">
            <button
              type="button"
              class="buy-sell-config__btn buy-sell-config__btn--secondary"
              onClick={handleRejectPlan}
            >
              Reject Plan
            </button>
            <button type="button" class="buy-sell-config__btn buy-sell-config__btn--primary" onClick={handleAcceptPlan}>
              Accept Plan
            </button>
          </div>
        </section>
      </Show>

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
        <button type="button" class="buy-sell-config__btn buy-sell-config__btn--secondary" onClick={handleGeneratePlan}>
          Generate Plan
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
          Schedule when to charge from the grid (charging power in watts). Buying only applies when state of charge is
          below the limits below.
        </p>

        <div class="buy-sell-config__grid2">
          <label class="buy-sell-config__label">
            Only buy below SOC (%)
            <Field name="buyOnlyBelowSoc">
              {(field, p) => (
                <>
                  <input
                    {...p}
                    value={fieldValueForInput(field)}
                    class="buy-sell-config__input"
                    type="number"
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
            <Field name="buyStartAgainBelowSoc">
              {(field, p) => (
                <>
                  <input
                    {...p}
                    value={fieldValueForInput(field)}
                    class="buy-sell-config__input"
                    type="number"
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
            <Field name="maxGridInputAmperage">
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
          </label>
        </div>

        <h3 class="buy-sell-config__subheading">Schedule</h3>
        <p class="buy-sell-config__hint buy-sell-config__hint--schedule">
          Duration and energy update as you edit. Energy assumes constant charging power for the window: kWh = (watts ×
          hours) / 1000.
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
                            <Field name={`buyingRows.${index()}.power`}>
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
          Schedule export power (watts). Selling only applies when SOC and battery voltage are above the thresholds
          below.
        </p>

        <div class="buy-sell-config__grid2">
          <label class="buy-sell-config__label">
            Only sell above SOC (%)
            <Field name="sellOnlyAboveSoc">
              {(field, p) => (
                <>
                  <input
                    {...p}
                    value={fieldValueForInput(field)}
                    class="buy-sell-config__input"
                    type="number"
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
            <Field name="sellStartAgainAboveSoc">
              {(field, p) => (
                <>
                  <input
                    {...p}
                    value={fieldValueForInput(field)}
                    class="buy-sell-config__input"
                    type="number"
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
            <Field name="onlySellAboveVoltage">
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
          </label>
          <label class="buy-sell-config__label">
            Start selling again above voltage (V)
            <Field name="startSellingAgainAboveVoltage">
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
          </label>
        </div>

        <h3 class="buy-sell-config__subheading">Schedule</h3>
        <p class="buy-sell-config__hint buy-sell-config__hint--schedule">
          Duration and energy update as you edit. Energy assumes constant export power for the window: kWh = (watts ×
          hours) / 1000.
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
                            <Field name={`sellingRows.${index()}.power`}>
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
    <Show when={config()} fallback={<p class="buy-sell-config__loading">Loading configuration…</p>}>
      <BuySellFormInner getConfig={config as Accessor<Config>} setConfig={set_config!} />
    </Show>
  );
}
