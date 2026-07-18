import { createMemo, createSignal, For, getOwner, Show } from "solid-js";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { createConfigEditorState } from "./configEditorState";
import { ConfigSection } from "./ConfigSections";
import { CONFIG_SECTIONS, HIDDEN_TOP_LEVEL_KEYS, type ConfigSectionMeta } from "./configFieldMeta";
import "./ConfigEditor.scss";

/**
 * The whole-config settings page: every value grouped and explained, edits staged locally and
 * written on Save as one path-scoped patch per changed field — so a save can only ever touch what
 * was actually edited, no matter how stale the tab is.
 */
export function ConfigEditor() {
  const state = createConfigEditorState();
  const owner = getOwner()!;
  const [query, setQuery] = createSignal("");

  // Top-level keys no curated section claims still get a section — nothing is invisible
  const allSections = createMemo<readonly ConfigSectionMeta[]>(() => {
    const config = state.config();
    if (!config) return CONFIG_SECTIONS;
    const claimed = new Set(CONFIG_SECTIONS.flatMap(section => section.rootKeys));
    const unclaimed = Object.keys(config).filter(key => !claimed.has(key) && !(key in HIDDEN_TOP_LEVEL_KEYS));
    if (!unclaimed.length) return CONFIG_SECTIONS;
    return [
      ...CONFIG_SECTIONS,
      {
        id: "uncurated",
        title: "Uncategorized",
        description: "Values the backend knows that this page has no curated home for yet.",
        rootKeys: unclaimed,
        fields: [],
      },
    ];
  });

  const save = async () => {
    const count = state.dirtyCount();
    if (await state.save()) {
      await showToastWithMessage(owner, () => `Saved ${count} change${count === 1 ? "" : "s"}`);
    }
  };

  return (
    <div class="cfg">
      <p class="cfg-intro">
        Everything the controller runs on, grouped by what it does. Edit freely — changes collect in the bar at the
        bottom and are only written when you press <b>Save</b>, each as its own field-level write. Values you haven't
        touched always show what the controller is using right now.
      </p>
      <input
        class="cfg-search"
        type="search"
        placeholder="Search settings… (e.g. “solar”, “floor”, “alert”)"
        value={query()}
        onInput={event => setQuery(event.currentTarget.value)}
      />
      <Show when={state.config()} fallback={<p class="cfg-loading">Waiting for the controller…</p>}>
        <For each={allSections()}>{section => <ConfigSection section={section} state={state} query={query()} />}</For>
        <details class="cfg-raw">
          <summary>Raw config (read-only)</summary>
          <pre>{JSON.stringify(state.config(), null, 2)}</pre>
        </details>
      </Show>
      <Show when={state.dirtyCount() > 0}>
        <div class="cfg-savebar" role="status">
          <span class="cfg-savebar__text">
            {state.dirtyCount()} unsaved change{state.dirtyCount() === 1 ? "" : "s"}
          </span>
          <div class="cfg-savebar__actions">
            <button type="button" class="cfg-btn cfg-btn--secondary" onClick={() => state.discardAll()}>
              Discard
            </button>
            <button
              type="button"
              class="cfg-btn cfg-btn--primary"
              disabled={state.saving()}
              onClick={() => void save()}
            >
              {state.saving() ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
