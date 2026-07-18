import { createMemo, For, Show, untrack } from "solid-js";
import { getAtPath, isRecord } from "~/helpers/objectPath";
import { isoToDatetimeLocal } from "~/helpers/buySellConfigMapping";
import type { ConfigFieldMeta, ConfigMapColumn } from "./configFieldMeta";
import type { ConfigEditorState } from "./configEditorState";

/**
 * Editor for keyed Record sections (sell/buy schedules, thermometers): one row per entry with
 * add/remove. Row operations stage set/unset patches for exactly that entry's key — removed rows
 * stay visible struck-through until saved, added rows exist only as staged edits until saved.
 */
export function ConfigMapField(props: { state: ConfigEditorState; meta: ConfigFieldMeta }) {
  const mapMeta = () => props.meta.map!;
  const path = () => props.meta.path;
  const serverMap = () => {
    const value = getAtPath(props.state.config(), path());
    return isRecord(value) ? value : {};
  };
  const rowKeys = createMemo(() => {
    const keys = new Set(Object.keys(serverMap()));
    for (const edit of props.state.pendingUnder(path())) {
      if (edit.op === "set") keys.add(edit.path[edit.path.length - 1]);
    }
    return [...keys].sort();
  });
  const entryPath = (key: string) => [...path(), key];
  const isRemoved = (key: string) => props.state.pendingFor(entryPath(key))?.op === "unset";
  // A staged-removed row keeps showing its server values (struck-through) instead of blanking
  const entryFor = (key: string) => (isRemoved(key) ? serverMap()[key] : props.state.effectiveValue(entryPath(key)));
  const isDirty = (key: string) => !!props.state.pendingFor(entryPath(key));
  const serverHas = (key: string) => key in serverMap();

  const removeRow = (key: string) =>
    serverHas(key) ? props.state.stageUnset(entryPath(key)) : props.state.unstage(entryPath(key));

  const renameKey = (oldKey: string, newKey: string) => {
    if (newKey === oldKey || rowKeys().includes(newKey)) return false;
    const entry = untrack(() => entryFor(oldKey));
    props.state.stageSet(entryPath(newKey), entry);
    if (serverHas(oldKey)) props.state.stageUnset(entryPath(oldKey));
    else props.state.unstage(entryPath(oldKey));
    return true;
  };

  const addRow = () => {
    const config = untrack(props.state.config);
    if (!config) return;
    let key: string;
    if (mapMeta().keyKind === "text") {
      const answer = window.prompt(mapMeta().addPrompt ?? "Key:")?.trim();
      if (!answer) return;
      key = answer;
    } else {
      // Next full hour, bumped until the key is free
      const start = new Date();
      start.setMinutes(60, 0, 0);
      const taken = new Set(rowKeys());
      while (taken.has(start.toISOString())) start.setTime(+start + 3600_000);
      key = start.toISOString();
    }
    props.state.stageSet(entryPath(key), mapMeta().newEntryValue(config));
  };

  return (
    <div class="cfg-map">
      <div class="cfg-map__wrap">
        <table class="cfg-map__table">
          <thead>
            <tr>
              <th scope="col">{mapMeta().keyLabel}</th>
              <For each={mapMeta().columns}>
                {column => (
                  <th scope="col">
                    {column.label}
                    <Show when={column.unit}> ({column.unit})</Show>
                  </th>
                )}
              </For>
              <Show when={!mapMeta().columns.length}>
                <th scope="col">{mapMeta().valueLabel ?? "Value"}</th>
              </Show>
              <th scope="col" class="cfg-map__th-actions"></th>
            </tr>
          </thead>
          <tbody>
            <For each={rowKeys()}>
              {key => (
                <tr classList={{ "cfg-map__row--removed": isRemoved(key), "cfg-map__row--dirty": isDirty(key) }}>
                  <td>
                    <KeyInput
                      keyKind={mapMeta().keyKind}
                      currentKey={key}
                      disabled={isRemoved(key)}
                      rename={renameKey}
                    />
                  </td>
                  <For each={mapMeta().columns}>
                    {column => (
                      <td>
                        <ColumnInput
                          column={column}
                          disabled={isRemoved(key)}
                          entry={() => entryFor(key)}
                          commit={newEntry => props.state.stageSet(entryPath(key), newEntry)}
                        />
                      </td>
                    )}
                  </For>
                  <Show when={!mapMeta().columns.length}>
                    <td>
                      <input
                        class="cfg-input"
                        type="text"
                        disabled={isRemoved(key)}
                        value={String(entryFor(key) ?? "")}
                        onChange={event => props.state.stageSet(entryPath(key), event.currentTarget.value)}
                      />
                    </td>
                  </Show>
                  <td class="cfg-map__actions">
                    <Show
                      when={!isRemoved(key)}
                      fallback={
                        <button
                          type="button"
                          class="cfg-btn cfg-btn--small"
                          onClick={() => props.state.unstage(entryPath(key))}
                        >
                          Undo remove
                        </button>
                      }
                    >
                      <button type="button" class="cfg-btn cfg-btn--small" onClick={() => removeRow(key)}>
                        Remove
                      </button>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <Show when={!rowKeys().length}>
        <p class="cfg-map__empty">No entries.</p>
      </Show>
      <button type="button" class="cfg-btn cfg-btn--secondary" onClick={addRow}>
        {mapMeta().addLabel}
      </button>
    </div>
  );
}

function KeyInput(props: {
  keyKind: "datetime" | "text";
  currentKey: string;
  disabled: boolean;
  rename: (oldKey: string, newKey: string) => boolean;
}) {
  const shown = () => (props.keyKind === "datetime" ? isoToDatetimeLocal(props.currentKey) : props.currentKey);
  return (
    <input
      class="cfg-input"
      type={props.keyKind === "datetime" ? "datetime-local" : "text"}
      step={props.keyKind === "datetime" ? 60 : undefined}
      disabled={props.disabled}
      value={shown()}
      onChange={event => {
        const element = event.currentTarget;
        const raw = element.value.trim();
        const newKey = props.keyKind === "datetime" ? localToIsoOrUndefined(raw) : raw || undefined;
        if (newKey === undefined || !props.rename(props.currentKey, newKey)) element.value = shown();
      }}
    />
  );
}

function ColumnInput(props: {
  column: ConfigMapColumn;
  disabled: boolean;
  entry: () => unknown;
  commit: (newEntry: unknown) => void;
}) {
  const entryRecord = () => (isRecord(props.entry()) ? (props.entry() as Record<string, unknown>) : {});
  const value = () => entryRecord()[props.column.key];
  const shown = () =>
    props.column.kind === "datetime" ? isoToDatetimeLocal(String(value() ?? "")) : String(value() ?? "");
  return (
    <input
      class="cfg-input"
      type={props.column.kind === "datetime" ? "datetime-local" : props.column.kind === "number" ? "number" : "text"}
      step={props.column.kind === "datetime" ? 60 : props.column.kind === "number" ? "any" : undefined}
      disabled={props.disabled}
      value={shown()}
      onChange={event => {
        const element = event.currentTarget;
        let newValue: unknown;
        if (props.column.kind === "datetime") {
          newValue = localToIsoOrUndefined(element.value);
        } else if (props.column.kind === "number") {
          const parsed = parseFloat(element.value.trim());
          newValue = Number.isFinite(parsed) ? parsed : undefined;
        } else {
          newValue = element.value;
        }
        if (newValue === undefined) {
          element.value = shown();
          return;
        }
        props.commit({ ...entryRecord(), [props.column.key]: newValue });
      }}
    />
  );
}

function localToIsoOrUndefined(local: string): string | undefined {
  if (!local) return undefined;
  const parsed = new Date(local);
  return Number.isNaN(+parsed) ? undefined : parsed.toISOString();
}
