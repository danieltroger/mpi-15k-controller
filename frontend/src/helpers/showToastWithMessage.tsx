import { type Accessor, type Owner, runWithOwner, type JSX as solid_JSX } from "solid-js";

/**
 * Minimal self-styled toast (styles in theme.scss) — replaced @depict-ai/ui's show_toast so the
 * plp-styling CSS base could be dropped. Same signature as before; statement JSX is resolved under
 * the caller's owner so reactive content keeps working.
 */
export async function showToastWithMessage(owner: Owner, statement: Accessor<solid_JSX.Element>) {
  const host = getToastHost();
  const toast = document.createElement("div");
  toast.className = "toast";

  const message = document.createElement("div");
  message.className = "toast__message";
  appendJsx(message, runWithOwner(owner, statement));

  const okButton = document.createElement("button");
  okButton.className = "toast__ok";
  okButton.type = "button";
  okButton.textContent = "OK";

  const close = () => {
    clearTimeout(autoCloseTimer);
    toast.remove();
  };
  okButton.addEventListener("click", close);
  const autoCloseTimer = setTimeout(close, 10_000);

  toast.append(message, okButton);
  host.append(toast);
}

function getToastHost(): HTMLElement {
  const existing = document.querySelector<HTMLElement>(".toast-host");
  if (existing) return existing;
  const host = document.createElement("div");
  host.className = "toast-host";
  document.body.append(host);
  return host;
}

/** Solid client JSX resolves to DOM nodes / strings / arrays / lazy functions — flatten them all in. */
function appendJsx(target: HTMLElement, element: solid_JSX.Element) {
  if (element === undefined || element === null || element === false || element === true) return;
  if (Array.isArray(element)) {
    for (const child of element) appendJsx(target, child);
    return;
  }
  if (typeof element === "function") {
    appendJsx(target, (element as () => solid_JSX.Element)());
    return;
  }
  target.append(element instanceof Node ? element : String(element));
}
