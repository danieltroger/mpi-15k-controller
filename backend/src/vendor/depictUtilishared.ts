/**
 * Vendored subset of `@depict-ai/utilishared` (server/latest build, v2.4.7).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Importing anything from "@depict-ai/utilishared/latest" has a *module-level*
 * side effect: it eagerly constructs a `DepictAPIWS` singleton pointed at
 * "wss://ws.v2.depict.ai/ws/create-events" (the analytics transmission socket),
 * see depict-ui:
 *   browser-tags-v2/packages/utilishared/src/tracking/depict_transmission.ts
 * That endpoint is no longer reachable, so the singleton's auto-reconnect loop
 * spammed the controller log with
 *   "Somehow the websocket died ErrorEvent { ... } reconnecting in ~60000"
 * roughly once a minute, forever. (Note: `process.env.DEPICT === "false"` does
 * NOT help — it only gates the *send* helpers, not the socket construction.)
 *
 * Rather than `yarn patch` the published package, we copy just the handful of
 * helpers this backend actually uses. No tracking module is imported, so the
 * transmission singleton never exists and nothing connects to Depict.
 *
 * FIDELITY
 * --------
 * Ported logic-for-logic from the compiled 2.4.7 artifact so runtime behaviour
 * is unchanged, with three node-only simplifications that don't affect this
 * backend:
 *   1. `report()` no longer forwards to Sentry. With SENTRY=false (set by
 *      `yarn run-no-nodemon`) upstream already resolved Sentry to a no-op
 *      "fakesentry", so this is a behavioural no-op here. The console logging
 *      is preserved.
 *   2. The WebSocket implementation is imported directly from the "ws" package
 *      instead of being looked up on globalThis with an SSR fallback stub.
 *   3. The cross-browser / IE11 event-cloning branches in the socket are
 *      dropped; only the node path (the one that actually ran here) is kept.
 *
 * Public surface = exactly what the backend imports:
 *   wait, rand, random_string, catchify, deparallelize_no_drop, DepictAPIWS.
 */

import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// debug flag + logging (utilishared: src/logging/, src/debugging)
// ---------------------------------------------------------------------------

// In node, debug logging is on when DEBUG=true (or NODE_ENV=development),
// unless STRIP_DEBUG=true. (The browser-only branches are irrelevant here.)
const is_debug =
  process.env.STRIP_DEBUG === "true"
    ? false
    : process.env.DEBUG === "true" || process.env.NODE_ENV === "development";

function decorated_log(console_command: (...args: any[]) => void, ...args: any[]) {
  if (is_debug) console_command(new Date().toISOString(), ...args);
}

function dlog(...args: any[]) {
  decorated_log(console.log.bind(console), ...args);
}

function dwarn(...args: any[]) {
  decorated_log(console.warn.bind(console), ...args);
}

// ---------------------------------------------------------------------------
// error reporting + catchify (utilishared: src/error_tracking/catchify.ts)
// ---------------------------------------------------------------------------

/**
 * Logs an error. Upstream also forwarded to Sentry; omitted here because the
 * backend runs with SENTRY=false (upstream => no-op fakesentry).
 */
function report(msg: any, severity: string, input_data: Record<string, any> = {}) {
  const has_human_readable_name = Array.isArray(msg);
  if (is_debug)
    // eslint-disable-next-line no-console
    console.info(
      `[sentry-${severity}]:`,
      ...(has_human_readable_name ? [...msg].reverse() : [msg]),
      "\n",
      input_data
    );
}

/**
 * Wraps `fn` so any thrown error (sync) or rejected promise (async) is caught
 * and reported instead of crashing the surrounding context.
 */
// Signature matches upstream exactly so the contextual type flows from the
// call site (e.g. `wss.on("connection", catchify(async ws => ...))`) back into
// the wrapped callback's params — otherwise they'd trip noImplicitAny.
export function catchify<T extends any[], X>(
  fn: (...args: T) => X,
  message?: string,
  severity: string = "error"
): (...args: T) => X extends Promise<any> ? Promise<undefined | Awaited<X>> : X | undefined {
  return function (this: any, ...args: T) {
    const report_w_severity = (e: any) => report(message ? [e, message] : e, severity);
    try {
      const return_value = Reflect.apply(fn, this, args);
      if ((fn as any)?.constructor?.name === "AsyncFunction" || typeof (return_value as any)?.then === "function")
        return (return_value as any).catch(report_w_severity);
      return return_value;
    } catch (e) {
      report_w_severity(e);
    }
  } as any;
}

// ---------------------------------------------------------------------------
// small helpers (utilishared: src/rand.ts, src/wait.ts, src/random_string.ts)
// ---------------------------------------------------------------------------

/** Random integer between min and max (inclusive). */
export function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Resolves after `delay` ms. */
export const wait = (delay: number) => new Promise<void>(resolve => setTimeout(resolve, delay));

/** Random string of a-z, 0-9 and occasionally a dot. */
export function random_string() {
  return (Math.random() * 2e17).toString(36);
}

// ---------------------------------------------------------------------------
// deparallelize (utilishared: src/deparallelize.ts)
// ---------------------------------------------------------------------------

/**
 * Ensures only one invocation of `the_function` runs at a time; calls made
 * while busy return the in-flight promise (extra calls are dropped).
 */
function deparallelize<T extends (...args: any[]) => any>(the_function: T) {
  let busy: any = false;
  let current_promise: Promise<any> | undefined;
  return catchify(async (...args: Parameters<T>) => {
    // Double await: if `busy` is true it must still be true two ticks later.
    // Fix for the case where a promise that finalizes immediately is passed.
    // https://javascript.info/microtask-queue
    if (!busy || !((await await busy), busy)) {
      busy = true;
      const to_finally = catchify(the_function)(...args) as Promise<any>;
      current_promise = to_finally.finally(() => (busy = false));
    }
    return current_promise;
  });
}

/**
 * Like {@link deparallelize}, but instead of dropping calls made while busy it
 * remembers the most recent one and runs it once the current invocation
 * finishes (coalescing to the latest args).
 */
export function deparallelize_no_drop<T extends (...args: any[]) => any>(the_function: T) {
  let busy: any = false;
  let queued: Parameters<T> | undefined;
  let current_promise: Promise<any> | undefined;
  const wrapped_fn = catchify(async (...args: Parameters<T>) => {
    // Double await, see deparallelize above.
    if (!busy || !((await await busy), busy)) {
      busy = true;
      const to_finally = catchify(the_function)(...args) as Promise<any>;
      current_promise = to_finally.finally(() => {
        busy = false;
        if (queued) {
          const q_val = queued;
          queued = undefined;
          wrapped_fn(...q_val);
        }
      });
    } else queued = args;
    return current_promise;
  });
  return wrapped_fn;
}

// ---------------------------------------------------------------------------
// infinite promise (no skip) — used by DepictAPIWS for incoming messages
// (utilishared: src/infinite_promise.ts)
// ---------------------------------------------------------------------------

/**
 * An awaitable `.promise` that resolves once per pushed value, in order, never
 * skipping a value even if producers outpace consumers.
 */
class InfinitePromiseNoSkip {
  #values_to_resolve_with: any[] = [];
  #internal_resolve!: (value: any) => void;
  #previous_promise: Promise<any> = Promise.resolve();
  promise: Promise<any> = new Promise(r => (this.#internal_resolve = r));
  #work_queue_max_once = deparallelize(this.#work_queue.bind(this));
  resolve = (value: any) => {
    this.#values_to_resolve_with.push(value);
    this.#work_queue_max_once();
  };
  async #work_queue() {
    const vtrw = this.#values_to_resolve_with;
    for (let i = 0; i < vtrw.length; i++) {
      await this.#previous_promise;
      const oldresolve = this.#internal_resolve;
      this.#previous_promise = this.promise;
      this.promise = new Promise(r => (this.#internal_resolve = r));
      oldresolve(vtrw[i]);
    }
    while (vtrw.length) vtrw.pop();
  }
}

// ---------------------------------------------------------------------------
// reconnecting WebSocket clients (utilishared: src/tracking/DepictAPIWS.ts)
// ---------------------------------------------------------------------------

const ONE_MINUTE = 60000;

interface WSOptions {
  max_backoff_ms?: number;
  initial_retry_ms?: number;
}

/**
 * A WebSocket-like EventTarget that transparently reconnects (with exponential
 * backoff) when the underlying connection closes or errors. You can use it like
 * a normal WebSocket: `.onmessage`/`.addEventListener("message", ...)` keep
 * working across reconnects.
 */
export class AutoReconnectingWS extends EventTarget {
  #ws_constructor_options: [string, (string | string[] | undefined)?];
  #possible_events = ["close", "error", "message", "open"] as const;
  #ons: Record<string, ((e: any) => void) | undefined> = {};
  #try_again_in_ms = this.#initial_reconnect_delay;
  #fails = 0;
  #max_fails = 10;
  #max_backoff_ms = ONE_MINUTE;
  current_socket!: WebSocket;
  restart_ws!: (reason?: any) => void;

  get #initial_reconnect_delay() {
    return rand(1, 1000);
  }

  #connect() {
    this.current_socket = new WebSocket(...this.#ws_constructor_options);
    this.#possible_events.forEach(name => {
      (this.current_socket as any).addEventListener(
        name,
        catchify((original_event: any) => {
          // node: the "ws" package fires EventEmitter-style pseudo-events, not
          // real DOM Events, so rebuild a real Event we can dispatch ourselves.
          const fixed_event: any = new Event(name);
          delete original_event["target"];
          delete original_event["type"];
          Object.assign(fixed_event, original_event);
          fixed_event.data ||= original_event.data;
          this.dispatchEvent(fixed_event);
        })
      );
    });
  }

  // Makes `.onmessage`/`.onclose`/`.onopen`/`.onerror` work on this EventTarget.
  #setup_dot_on_event_support() {
    for (const ev of this.#possible_events) {
      Object.defineProperty(this, "on" + ev, {
        configurable: false,
        enumerable: true,
        get: () => this.#ons[ev],
        set: v => (this.#ons[ev] = v),
      });
      this.addEventListener(ev, e => {
        const on_fn = this.#ons[ev];
        if (typeof on_fn === "function") catchify(on_fn).call(ev, e);
      });
    }
  }

  async #ensure_connection() {
    while (true) {
      const error: any = await new Promise(resolve => {
        this.addEventListener("close", resolve);
        this.addEventListener("error", resolve);
        this.restart_ws = resolve as any;
      });
      this.removeEventListener("close", this.restart_ws as any);
      this.removeEventListener("error", this.restart_ws as any);
      // 4100 means server thinks this is a scraper bot that's ignoring robots.txt
      if (error?.code === 4100) {
        dlog("Websocket connection rejected by server, won't reconnect", error);
        return;
      }
      dlog(
        "Somehow the websocket died",
        error,
        "message:",
        error?.message,
        "code:",
        error?.code,
        "reason:",
        error?.reason,
        "reconnecting in",
        this.#try_again_in_ms
      );
      await new Promise<void>(r => {
        // "race" the timeout against a browser "online" event (no-op in node)
        const handler = catchify((ev: any) => {
          r();
          dlog("Retrying due to 'online' event", ev);
          clearTimeout(timeout);
        });
        (globalThis as any)?.addEventListener?.("online", handler, { once: true });
        const timeout = setTimeout(
          catchify(() => {
            this.#try_again_in_ms *= 1.5 + Math.random();
            if (this.#try_again_in_ms > this.#max_backoff_ms)
              this.#try_again_in_ms = this.#max_backoff_ms * (1 + Math.random() / 10);
            r();
            (globalThis as any)?.removeEventListener?.("online", handler);
          }),
          this.#try_again_in_ms
        );
      });
      this.#connect();
    }
  }

  increase_fails() {
    this.#fails++;
    if (this.#fails > this.#max_fails) {
      this.restart_ws();
      this.#fails = 0;
    }
  }

  async send(...args: any[]) {
    (this.current_socket as any).send(...args);
  }

  constructor(url: string, protocols?: string | string[], options: WSOptions = {}) {
    super();
    this.#ws_constructor_options = [url, protocols];
    const { max_backoff_ms } = options;
    if (max_backoff_ms) this.#max_backoff_ms = max_backoff_ms;
    this.#setup_dot_on_event_support();
    this.#connect();
    this.#ensure_connection().catch(e => report(e, "error"));
    this.addEventListener(
      "open",
      catchify(() => {
        dlog("Connection opened");
        this.#try_again_in_ms = this.#initial_reconnect_delay; // reset exponential backoff
      })
    );
  }
}

/**
 * AutoReconnectingWS plus an `ensure_sent` request/ack protocol: keeps resending
 * a payload (with backoff) until the server acknowledges it, surviving
 * reconnects. Used here to drive GPIO on the heating-element pi.
 */
export class DepictAPIWS extends AutoReconnectingWS {
  #msg_ipns = new InfinitePromiseNoSkip();
  #initial_retry_ms = 5000;
  #connection_last_active = 0;
  #reconnect_if_dead_for_ms = 20000;
  #messages_queued = 0;

  async #wait_for_open_and_send(msg: any) {
    while (this.current_socket.readyState !== 1)
      await new Promise(resolve => {
        this.addEventListener("open", resolve, { once: true });
      });
    this.send(msg);
  }

  // If we're trying to send but see no activity for a while, assume the
  // connection is dead and reconnect immediately (skip the exponential backoff).
  #start_reconnection_if_offline_process = deparallelize(async () => {
    await new Promise(r => setTimeout(r, this.#reconnect_if_dead_for_ms + rand(-2, 10)));
    if (this.#messages_queued === 0) return;
    const now = +new Date();
    if (now - this.#connection_last_active > this.#reconnect_if_dead_for_ms) {
      const reason = `No activity in ${this.#reconnect_if_dead_for_ms} ms`;
      dlog(reason, "reconnecting ws");
      this.restart_ws(reason);
    }
  });

  #periodic_send(msg: any) {
    let delay_to_next_send = this.#initial_retry_ms;
    let quit = false;
    this.#messages_queued++;
    (async () => {
      while (!quit) {
        this.#start_reconnection_if_offline_process();
        await this.#wait_for_open_and_send(msg);
        const waited = await new Promise(r => {
          const handler = () => {
            r(false);
            clearTimeout(resend_due_to_lost_message_timeout);
          };
          // wait the correct delay...
          const resend_due_to_lost_message_timeout = setTimeout(
            catchify(() => {
              r(true);
              this.removeEventListener("open", handler);
            }),
            delay_to_next_send
          );
          // ...but if a new socket opens (internet works) retry immediately
          this.addEventListener("open", handler, { once: true });
        });
        if (quit) break;
        delay_to_next_send *= 1.5 + Math.random();
        if (delay_to_next_send > ONE_MINUTE) delay_to_next_send = ONE_MINUTE * (Math.random() + 1);
        // don't count a resend triggered by reconnect as a fail
        if (waited) this.increase_fails();
      }
      this.#messages_queued--;
    })().catch(e => report(e, "error"));
    return () => (quit = true);
  }

  async ensure_sent(payload: any): Promise<[any, any]> {
    const json_payload = JSON.stringify(payload);
    const stop_sending = this.#periodic_send(json_payload);
    while (true) {
      const { data } = await this.#msg_ipns.promise;
      let reply: any;
      try {
        reply = JSON.parse(data);
      } catch (e) {
        const msg = "Got malformed message (ignoring, might cause memory leak)";
        dlog(msg, data, e);
        report([e, msg], "error", { data });
        continue;
      }
      if (reply.id == payload.id) {
        const { status } = reply;
        if (status == "ack") {
          stop_sending();
          continue;
        } else if (status == "not-ok") dwarn("Got reply not-ok reply from server for event!", payload, reply);
        else if (status == "ok") {
          if (process.env.BUILD_TARGET !== "node") dlog(`Successfully sent ${payload?.event?.type} (WS)`, payload, reply);
        } else dwarn("Strange reply from WSS server to", payload, ":", reply);
        stop_sending();
        return [reply, data];
      }
    }
  }

  constructor(...params: ConstructorParameters<typeof AutoReconnectingWS>) {
    super(...params);
    const option_retry_ms = params[2]?.initial_retry_ms;
    if (option_retry_ms) this.#initial_retry_ms = option_retry_ms;
    this.addEventListener("message", catchify(this.#msg_ipns.resolve as any));
    ["open", "error", "message"].forEach(event =>
      this.addEventListener(event, catchify(() => (this.#connection_last_active = +new Date())))
    );
  }
}
