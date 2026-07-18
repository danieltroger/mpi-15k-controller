import { createSignal, For, Show } from "solid-js";
import { pathIsUnsettable } from "../../../../backend/src/config/configPatch";
import type { ConfigFieldMeta } from "./configFieldMeta";
import type { ConfigEditorState } from "./configEditorState";

/**
 * One config value: label, matching input, explanation. Edits are STAGED into the editor state
 * (savebar commits them) — nothing is written on input. Fields without a staged edit render the
 * live synced value, so backend-side changes stay visible while other fields are being edited.
 */
export function ConfigLeafField(props: { state: ConfigEditorState; meta: ConfigFieldMeta }) {
  const path = () => props.meta.path;
  const effective = () => props.state.effectiveValue(path());
  const dirty = () => !!props.state.pendingFor(path());
  // The control kind follows the live value's type; meta settles it when the value is absent
  const kind = () => {
    if (props.meta.readonly) return "readonly";
    if (props.meta.options) return "select";
    const value = effective();
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    return "text";
  };

  return (
    <div class="cfg-field" classList={{ "cfg-field--dirty": dirty(), "cfg-field--ro": kind() === "readonly" }}>
      <div class="cfg-field__head">
        <span class="cfg-field__label">
          {props.meta.label}
          <Show when={props.meta.unit}>
            <span class="cfg-field__unit"> ({props.meta.unit})</span>
          </Show>
        </span>
        <Show when={dirty()}>
          <button
            type="button"
            class="cfg-field__revert"
            title="Revert this change"
            onClick={() => props.state.unstage(path())}
          >
            ↺ edited
          </button>
        </Show>
      </div>
      {controlFor(kind(), props)}
      <span class="cfg-field__help">
        {props.meta.help} <code class="cfg-field__key">{path().join(".")}</code>
      </span>
    </div>
  );
}

function controlFor(kind: string, props: { state: ConfigEditorState; meta: ConfigFieldMeta }) {
  const path = () => props.meta.path;
  const effective = () => props.state.effectiveValue(path());
  const displayString = () => {
    const value = effective();
    return value === undefined ? "" : String(value);
  };

  switch (kind) {
    case "readonly":
      return (
        <span class="cfg-field__rovalue" title="Written by the controller">
          {displayString() || "—"}
          <span class="cfg-field__ropill">read-only</span>
        </span>
      );
    case "boolean":
      return (
        <button
          type="button"
          role="switch"
          aria-checked={effective() === true}
          class="cfg-toggle"
          classList={{ "cfg-toggle--on": effective() === true }}
          onClick={() => props.state.stageSet(path(), !(effective() === true))}
        >
          <span class="cfg-toggle__track">
            <span class="cfg-toggle__knob" />
          </span>
          <span class="cfg-toggle__text">{effective() === true ? "On" : "Off"}</span>
        </button>
      );
    case "select":
      return (
        <select class="cfg-input" onChange={event => props.state.stageSet(path(), event.currentTarget.value)}>
          <Show when={effective() === undefined}>
            <option value="" disabled selected>
              — not set —
            </option>
          </Show>
          <For each={props.meta.options}>
            {option => (
              <option value={option.value} selected={option.value === effective()}>
                {option.label}
              </option>
            )}
          </For>
        </select>
      );
    case "number":
      return (
        <input
          class="cfg-input"
          type="number"
          step={props.meta.step ?? "any"}
          min={props.meta.min}
          max={props.meta.max}
          value={displayString()}
          onKeyDown={event => event.key === "Escape" && (event.currentTarget.value = displayString())}
          onChange={event => {
            const element = event.currentTarget;
            const parsed = parseFloat(element.value.trim());
            // Empty/garbage never gets staged — the field snaps back to the effective value
            if (!Number.isFinite(parsed)) {
              element.value = displayString();
              return;
            }
            props.state.stageSet(path(), parsed);
          }}
        />
      );
    default:
      return <TextControl state={props.state} meta={props.meta} />;
  }
}

function TextControl(props: { state: ConfigEditorState; meta: ConfigFieldMeta }) {
  const path = () => props.meta.path;
  const [revealed, setRevealed] = createSignal(false);
  const displayString = () => {
    const value = props.state.effectiveValue(path());
    return value === undefined ? "" : String(value);
  };
  return (
    <input
      class="cfg-input"
      type={props.meta.secret && !revealed() ? "password" : "text"}
      value={displayString()}
      onFocus={() => setRevealed(true)}
      onBlur={() => setRevealed(false)}
      onKeyDown={event => event.key === "Escape" && (event.currentTarget.value = displayString())}
      onChange={event => {
        const raw = event.currentTarget.value;
        // Clearing an optional key removes it; required keys stage the empty string visibly
        if (raw === "" && pathIsUnsettable(path())) props.state.stageUnset(path());
        else props.state.stageSet(path(), raw);
      }}
    />
  );
}
