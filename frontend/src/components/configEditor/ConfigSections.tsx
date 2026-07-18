import { createEffect, createMemo, For, Show } from "solid-js";
import { getAtPath, isRecord, pathKey } from "~/helpers/objectPath";
import { ConfigLeafField } from "./ConfigLeafField";
import { ConfigMapField } from "./ConfigMapField";
import {
  autoLabelForKey,
  HIDDEN_TOP_LEVEL_KEYS,
  type ConfigFieldMeta,
  type ConfigSectionMeta,
} from "./configFieldMeta";
import type { ConfigEditorState } from "./configEditorState";

/**
 * One collapsible section card. Field order/labels come from the meta table, but coverage comes
 * from the config itself: leaves that exist in the synced config without a meta entry render
 * anyway under "Other", so no backend knob can be invisible on this page.
 */
export function ConfigSection(props: { section: ConfigSectionMeta; state: ConfigEditorState; query: string }) {
  let detailsElement!: HTMLDetailsElement;

  const fields = createMemo<ConfigFieldMeta[]>(() => {
    const config = props.state.config();
    if (!config) return [...props.section.fields];
    const declaredLeaves = new Set(props.section.fields.map(meta => pathKey(meta.path)));
    const mapPrefixes = props.section.fields.filter(meta => meta.map).map(meta => meta.path);
    const orphans: ConfigFieldMeta[] = [];
    for (const rootKey of props.section.rootKeys) {
      if (rootKey in HIDDEN_TOP_LEVEL_KEYS) continue;
      collectOrphanLeaves(getAtPath(config, [rootKey]), [rootKey], declaredLeaves, mapPrefixes, orphans);
    }
    if (orphans.length) orphans[0] = { ...orphans[0], heading: "Other" };
    return [...props.section.fields, ...orphans];
  });

  const visibleFields = createMemo(() => {
    const query = props.query.trim().toLowerCase();
    if (!query) return fields();
    const tokens = query.split(/\s+/);
    return fields().filter(meta => {
      const haystack = `${meta.label} ${meta.path.join(".")} ${meta.help} ${props.section.title}`.toLowerCase();
      return tokens.every(token => haystack.includes(token));
    });
  });

  const dirtyCount = () => props.state.dirtyCountUnder(props.section.rootKeys);

  // Searching must reveal matches inside collapsed sections
  createEffect(() => {
    if (props.query.trim()) detailsElement.open = true;
  });

  return (
    <Show when={!props.query.trim() || visibleFields().length > 0}>
      <details ref={detailsElement} class="cfg-section" open={props.section.startOpen}>
        <summary class="cfg-section__summary">
          <span class="cfg-section__title">{props.section.title}</span>
          <Show when={dirtyCount() > 0}>
            <span class="cfg-section__dirty">{dirtyCount()} unsaved</span>
          </Show>
        </summary>
        <p class="cfg-section__desc">{props.section.description}</p>
        <For each={props.section.rootKeys.filter(rootKey => rootKey in HIDDEN_TOP_LEVEL_KEYS)}>
          {hiddenKey => <p class="cfg-section__note">{HIDDEN_TOP_LEVEL_KEYS[hiddenKey]}</p>}
        </For>
        <div class="cfg-grid">
          <For each={visibleFields()}>
            {meta => (
              <>
                <Show when={meta.heading && !props.query.trim()}>
                  <h3 class="cfg-heading">{meta.heading}</h3>
                </Show>
                <Show when={meta.map} fallback={<ConfigLeafField state={props.state} meta={meta} />}>
                  <div class="cfg-grid__full">
                    <ConfigMapField state={props.state} meta={meta} />
                  </div>
                </Show>
              </>
            )}
          </For>
        </div>
      </details>
    </Show>
  );
}

/** Depth-first walk collecting primitive leaves that no meta entry (and no map subtree) covers. */
function collectOrphanLeaves(
  value: unknown,
  path: readonly string[],
  declaredLeaves: ReadonlySet<string>,
  mapPrefixes: readonly (readonly string[])[],
  out: ConfigFieldMeta[]
) {
  if (declaredLeaves.has(pathKey(path))) return;
  if (mapPrefixes.some(prefix => prefix.length <= path.length && prefix.every((segment, i) => segment === path[i]))) {
    return;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      collectOrphanLeaves(value[key], [...path, key], declaredLeaves, mapPrefixes, out);
    }
    return;
  }
  if (value !== undefined) {
    out.push({ path, label: autoLabelForKey(path[path.length - 1]), help: "" });
  }
}
