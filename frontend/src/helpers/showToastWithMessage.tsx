import { type Accessor, type Owner, runWithOwner, type JSX as solid_JSX } from "solid-js";

/**
 * Minimal self-styled toast (styles in theme.scss) — replaced @depict-ai/ui's show_toast so the
 * plp-styling CSS base could be dropped. Solid's client JSX compiles straight to DOM nodes, so the
 * toast is plain JSX appended to a host element; the message renders under the caller's owner so
 * reactive content keeps working.
 */
export async function showToastWithMessage(owner: Owner, statement: Accessor<solid_JSX.Element>) {
  const close = () => {
    clearTimeout(autoCloseTimer);
    toast.remove();
  };
  const toast = (
    <div class="toast">
      <div class="toast__message">{runWithOwner(owner, statement)}</div>
      <button class="toast__ok" type="button" onClick={close}>
        OK
      </button>
    </div>
  ) as HTMLElement;
  const autoCloseTimer = setTimeout(close, 10_000);
  getToastHost().append(toast);
}

function getToastHost(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(".toast-host");
  if (existing) return existing;
  const host = document.createElement("div");
  host.className = "toast-host";
  document.body.append(host);
  return host;
}
