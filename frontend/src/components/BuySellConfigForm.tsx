import { createForm, insert, remove, setValues, zodForm } from "@modular-forms/solid";
import { createEffect, For, Show } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import {
  configToBuySellFormData,
  formValuesToConfig,
  type BuySellFormData,
} from "~/helpers/buySellConfigMapping";
import { buySellFormSchema } from "~/helpers/buySellFormSchema";
import type { Config } from "../../../backend/src/config/config.types";
import "./BuySellConfig.scss";

const defaultInitial: BuySellFormData = {
  buyOnlyBelowSoc: 40,
  buyStartAgainBelowSoc: 15,
  maxGridInputAmperage: 21,
  sellOnlyAboveSoc: 13,
  sellStartAgainAboveSoc: 25,
  onlySellAboveVoltage: 49.8,
  startSellingAgainAboveVoltage: 52.2,
  buyingRows: [],
  sellingRows: [],
};

const emptyRow = (): BuySellFormData["buyingRows"][number] => ({
  start: "",
  end: "",
  power: 0,
});

export function BuySellConfigForm() {
  const [config, set_config] = getBackendSyncedSignal<Config>("config", undefined, false);

  const [buySellForm, { Form, Field, FieldArray }] = createForm<BuySellFormData>({
    initialValues: defaultInitial,
    validate: zodForm(buySellFormSchema),
    validateOn: "submit",
    revalidateOn: "input",
  });

  createEffect(() => {
    const c = config();
    if (!c || buySellForm.dirty) return;
    setValues(buySellForm, configToBuySellFormData(c));
  });

  return (
    <Show
      when={config()}
      fallback={<p class="buy-sell-config__loading">Loading configuration…</p>}
    >
      <Form
        class="buy-sell-config"
        onSubmit={async values => {
          const c = config();
          if (!c || !set_config) return;
          const next = formValuesToConfig(values, c);
          const ok = await set_config(next);
          if (ok) {
            setValues(buySellForm, configToBuySellFormData(next), {
              shouldDirty: false,
              shouldTouched: false,
            });
          }
        }}
      >
        <div class="buy-sell-config__toolbar">
          <button
            type="button"
            class="buy-sell-config__btn buy-sell-config__btn--secondary"
            onClick={() => {
              const c = config();
              if (c) {
                setValues(buySellForm, configToBuySellFormData(c), {
                  shouldDirty: false,
                  shouldTouched: false,
                });
              }
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
                {(field, props) => (
                  <>
                    <input
                      {...props}
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
                {(field, props) => (
                  <>
                    <input
                      {...props}
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
                {(field, props) => (
                  <>
                    <input {...props} class="buy-sell-config__input" min={0} step="any" />
                    <Show when={field.error}>
                      <span class="buy-sell-config__field-error">{field.error}</span>
                    </Show>
                  </>
                )}
              </Field>
            </label>
          </div>

          <h3 class="buy-sell-config__subheading">Schedule</h3>
          <FieldArray name="buyingRows">
            {fieldArray => (
              <>
                <table class="buy-sell-config__table">
                  <thead>
                    <tr>
                      <th scope="col">Start (local)</th>
                      <th scope="col">End (local)</th>
                      <th scope="col">Charging power (W)</th>
                      <th scope="col">
                        <span class="buy-sell-config__sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={fieldArray.items}>
                      {itemIndex => (
                        <tr>
                          <td>
                            <Field name={`buyingRows.${itemIndex}.start`} type="string">
                              {(field, props) => (
                                <>
                                  <input
                                    {...props}
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
                            <Field name={`buyingRows.${itemIndex}.end`} type="string">
                              {(field, props) => (
                                <>
                                  <input
                                    {...props}
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
                            <Field name={`buyingRows.${itemIndex}.power`} type="number">
                              {(field, props) => (
                                <>
                                  <input
                                    {...props}
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
                          <td>
                            <button
                              type="button"
                              class="buy-sell-config__btn buy-sell-config__btn--small"
                              onClick={() =>
                                remove(buySellForm, "buyingRows", { at: itemIndex })
                              }
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
                <button
                  type="button"
                  class="buy-sell-config__btn buy-sell-config__btn--secondary"
                  onClick={() =>
                    insert(buySellForm, "buyingRows", { value: emptyRow() })
                  }
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
            Schedule export power (watts). Selling only applies when SOC and battery voltage are
            above the thresholds below.
          </p>

          <div class="buy-sell-config__grid2">
            <label class="buy-sell-config__label">
              Only sell above SOC (%)
              <Field name="sellOnlyAboveSoc" type="number">
                {(field, props) => (
                  <>
                    <input
                      {...props}
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
                {(field, props) => (
                  <>
                    <input
                      {...props}
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
                {(field, props) => (
                  <>
                    <input {...props} class="buy-sell-config__input" min={0} step="any" />
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
                {(field, props) => (
                  <>
                    <input {...props} class="buy-sell-config__input" min={0} step="any" />
                    <Show when={field.error}>
                      <span class="buy-sell-config__field-error">{field.error}</span>
                    </Show>
                  </>
                )}
              </Field>
            </label>
          </div>

          <h3 class="buy-sell-config__subheading">Schedule</h3>
          <FieldArray name="sellingRows">
            {fieldArray => (
              <>
                <table class="buy-sell-config__table">
                  <thead>
                    <tr>
                      <th scope="col">Start (local)</th>
                      <th scope="col">End (local)</th>
                      <th scope="col">Export (W)</th>
                      <th scope="col">
                        <span class="buy-sell-config__sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={fieldArray.items}>
                      {itemIndex => (
                        <tr>
                          <td>
                            <Field name={`sellingRows.${itemIndex}.start`} type="string">
                              {(field, props) => (
                                <>
                                  <input
                                    {...props}
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
                            <Field name={`sellingRows.${itemIndex}.end`} type="string">
                              {(field, props) => (
                                <>
                                  <input
                                    {...props}
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
                            <Field name={`sellingRows.${itemIndex}.power`} type="number">
                              {(field, props) => (
                                <>
                                  <input
                                    {...props}
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
                          <td>
                            <button
                              type="button"
                              class="buy-sell-config__btn buy-sell-config__btn--small"
                              onClick={() =>
                                remove(buySellForm, "sellingRows", { at: itemIndex })
                              }
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
                <button
                  type="button"
                  class="buy-sell-config__btn buy-sell-config__btn--secondary"
                  onClick={() =>
                    insert(buySellForm, "sellingRows", { value: emptyRow() })
                  }
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
    </Show>
  );
}
