import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { useConfigPatcher } from "~/helpers/useConfigPatcher";
import { deepEqual, getAtPath, pathKey } from "~/helpers/objectPath";
import type { ConfigPatch } from "../../../../backend/src/wsContract.types";

export type PendingEdit =
  | { path: readonly string[]; op: "set"; value: unknown }
  | { path: readonly string[]; op: "unset" };

export type ConfigEditorState = ReturnType<typeof createConfigEditorState>;

/**
 * The config page's edit model: fields stage changes into a pending map (nothing is written on
 * input), the savebar turns the staged edits into one path-scoped patch each on Save. Fields
 * without a staged edit always show the live synced value, so concurrent backend/trader/other-tab
 * changes stay visible while you edit something else — and can never be reverted by your save.
 */
export function createConfigEditorState() {
  const [config] = getBackendSyncedSignal("config");
  const { sendPatches } = useConfigPatcher();
  const [pendingEdits, setPendingEdits] = createSignal<ReadonlyMap<string, PendingEdit>>(new Map());
  const [saving, setSaving] = createSignal(false);

  // A staged edit that now equals the server state is no longer an edit (our save landed, or
  // someone else made the same change) — drop it so the savebar count stays honest.
  createEffect(() => {
    const current = config();
    if (!current) return;
    setPendingEdits(edits => {
      const next = new Map(edits);
      let changed = false;
      for (const [key, edit] of edits) {
        const serverValue = getAtPath(current, edit.path);
        const resolved = edit.op === "set" ? deepEqual(serverValue, edit.value) : serverValue === undefined;
        if (resolved) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : edits;
    });
  });

  const stageSet = (path: readonly string[], value: unknown) => {
    const serverValue = getAtPath(untrack(config), path);
    setPendingEdits(edits => {
      const next = new Map(edits);
      if (deepEqual(serverValue, value)) next.delete(pathKey(path));
      else next.set(pathKey(path), { path, op: "set", value });
      return next;
    });
  };

  const stageUnset = (path: readonly string[]) => {
    const serverValue = getAtPath(untrack(config), path);
    setPendingEdits(edits => {
      const next = new Map(edits);
      if (serverValue === undefined) next.delete(pathKey(path));
      else next.set(pathKey(path), { path, op: "unset" });
      return next;
    });
  };

  const unstage = (path: readonly string[]) =>
    setPendingEdits(edits => {
      if (!edits.has(pathKey(path))) return edits;
      const next = new Map(edits);
      next.delete(pathKey(path));
      return next;
    });

  const discardAll = () => setPendingEdits(new Map());

  const pendingFor = (path: readonly string[]) => pendingEdits().get(pathKey(path));

  /** Staged edits exactly one level below `prefix` — how map editors find added/removed rows. */
  const pendingUnder = (prefix: readonly string[]) =>
    [...pendingEdits().values()].filter(
      edit => edit.path.length === prefix.length + 1 && prefix.every((segment, i) => edit.path[i] === segment)
    );

  /** The value a field should display: its staged edit if any, otherwise the live synced value. */
  const effectiveValue = (path: readonly string[]) => {
    const edit = pendingEdits().get(pathKey(path));
    if (edit) return edit.op === "set" ? edit.value : undefined;
    return getAtPath(config(), path);
  };

  /** Number of staged edits under any of the given top-level keys (section dirty badge). */
  const dirtyCountUnder = (rootKeys: readonly string[]) =>
    [...pendingEdits().values()].filter(edit => rootKeys.includes(edit.path[0])).length;

  const dirtyCount = createMemo(() => pendingEdits().size);

  /** Sends one patch per staged edit — sets before unsets, so a failure mid-batch can leave a
   * duplicate schedule row but never lose one. Partially applied batches self-heal: the effect
   * above drops whatever landed once the next config broadcast arrives. */
  const save = async (): Promise<boolean> => {
    const edits = [...untrack(pendingEdits).values()];
    const patches: ConfigPatch[] = [
      ...edits.filter(edit => edit.op === "set"),
      ...edits.filter(edit => edit.op === "unset").map(({ path }) => ({ path, op: "unset" as const })),
    ];
    if (!patches.length) return true;
    setSaving(true);
    try {
      const ok = await sendPatches(patches);
      if (ok) discardAll();
      return ok;
    } finally {
      setSaving(false);
    }
  };

  return {
    config,
    pendingEdits,
    pendingFor,
    pendingUnder,
    effectiveValue,
    stageSet,
    stageUnset,
    unstage,
    discardAll,
    dirtyCount,
    dirtyCountUnder,
    save,
    saving,
  };
}
