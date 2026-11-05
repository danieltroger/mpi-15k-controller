import { createSignal, getOwner, Show } from "solid-js";
import { getBackendSyncedSignal, sendBackendAction } from "~/helpers/getBackendSyncedSignal";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { useWebSocket } from "~/components/WebSocketProvider";
import { formatClockTime, formatRelativeTime, useNowMs } from "~/helpers/format";
import type { AutoGridOffStatus, GridOffStatus } from "../../../../backend/src/gridOff/gridOff.types";
import type { GridOffConfig } from "../../../../backend/src/config/config.types";
import type { MachineModelCode } from "../../../../backend/src/inverterComms/pi17Protocol.types";
import { describeMachineModel, MACHINE_MODEL_DESCRIPTIONS } from "../../../../backend/src/inverterComms/machineModel";
import { DiagRow } from "./DiagRow";
import "./GridOffCard.scss";

/**
 * The grid-off switch: puts the inverter into Off-Grid III (machine model 151, the grid relay open on
 * battery) and back to normal hybrid (050). Shows what the inverter reads back next to what the
 * controller asked for, and what automatic grid-off wants and why; each switch by hand needs a second,
 * in-page confirmation, and the buttons are off while automatic grid-off drives the switch.
 */
export function GridOffCard() {
  // silentReadErrors: a backend from before this card (or before automatic grid-off) doesn't expose the key yet
  const [gridOff] = getBackendSyncedSignal("gridOff", undefined, true, true);
  const [autoGridOff] = getBackendSyncedSignal("gridOffAuto", undefined, true, true);
  const [config] = getBackendSyncedSignal("config", undefined, false);
  const socket = useWebSocket();
  const owner = getOwner()!;
  const now = useNowMs(5000);
  const [confirming, setConfirming] = createSignal<MachineModelCode | undefined>(undefined);
  const [sending, setSending] = createSignal(false);
  const autoEnabled = () => autoGridOff()?.enabled === true;

  const sendSwitch = async (model: MachineModelCode) => {
    setSending(true);
    try {
      const result = await sendBackendAction(socket, model === "151" ? "grid_off_open_relay" : "grid_off_normal");
      await showToastWithMessage(owner, () => `Grid relay — ${result}`);
    } catch (error) {
      await showToastWithMessage(owner, () => `Grid relay — ${error instanceof Error ? error.message : error}`);
    } finally {
      setSending(false);
      setConfirming(undefined);
    }
  };

  return (
    <section class="card grid-off-card" aria-label="Grid relay">
      <div class="card-head">
        <span class="eyebrow">Grid relay (Off-Grid III)</span>
        <Show when={gridOff()?.readback_at}>
          {readAt => <span class="card-meta">read {formatRelativeTime(now(), readAt())}</span>}
        </Show>
      </div>
      <Show when={gridOff()} fallback={<p class="diag__reason">Not read yet.</p>}>
        {status => <GridOffRows status={status()} nowMs={now()} />}
      </Show>
      <Show when={autoGridOff()}>{status => <AutoGridOffRows status={status()} nowMs={now()} />}</Show>
      {/* As the backend uses them: corrected to their bounds (an older backend sends the raw config only) */}
      <Show when={autoGridOff()?.settings ?? config()?.grid_off}>
        {gridOffConfig => <p class="diag__reason">{describeGuards(gridOffConfig())}</p>}
      </Show>

      <Show when={autoEnabled()}>
        <p class="diag__reason">
          Automatic grid-off switches the relay, so the buttons are off. To switch by hand, turn{" "}
          <b>Automatic grid-off</b> off on the <a href="/config">Config page</a> (Grid relay off); with the grid off,
          that switches back to normal (050) first.
        </p>
      </Show>
      <Show
        when={confirming()}
        fallback={
          <div class="grid-off-card__actions">
            <button
              type="button"
              class="grid-off-card__btn"
              disabled={sending() || !gridOff() || autoEnabled()}
              onClick={() => setConfirming("151")}
            >
              Open grid relay (151)
            </button>
            <button
              type="button"
              class="grid-off-card__btn"
              disabled={sending() || !gridOff() || autoEnabled()}
              onClick={() => setConfirming("050")}
            >
              Back to normal (050)
            </button>
          </div>
        }
      >
        {model => (
          <div class="grid-off-card__confirm">
            <p class="grid-off-card__question">{confirmationQuestion(model())}</p>
            <div class="grid-off-card__actions">
              <button
                type="button"
                class={`grid-off-card__btn${model() === "151" ? " grid-off-card__btn--danger" : ""}`}
                disabled={sending() || autoEnabled()}
                onClick={() => void sendSwitch(model())}
              >
                {sending() ? "Sending…" : `Yes, send DM${model()}`}
              </button>
              <button
                type="button"
                class="grid-off-card__btn"
                disabled={sending()}
                onClick={() => setConfirming(undefined)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}

function GridOffRows(props: { status: GridOffStatus; nowMs: number }) {
  return (
    <>
      <DiagRow
        label="Inverter reads"
        value={describeMachineModel(props.status.readback_model)}
        title="The PI17 DM readback, polled with the settings (every few minutes) and right after every switch"
      />
      <DiagRow
        label="Requested"
        value={`${MACHINE_MODEL_DESCRIPTIONS[props.status.requested_model]}${
          props.status.requested_at === undefined
            ? " (since the controller started)"
            : `, ${formatRelativeTime(props.nowMs, props.status.requested_at)}`
        }`}
        title="Never kept across a controller restart: every start wants 050"
      />
      <Show when={props.status.stuck_off_grid}>
        <p class="diag__reason">
          <b>Stuck on 151:</b> the inverter doesn't take 050 back. A P1 went out; DM050 is resent with back-off, and
          feeding, buying and the grid alerts run as if the relay were closed.
        </p>
      </Show>
      <Show when={props.status.grid_off_in_force}>
        <p class="diag__reason">
          <b>Grid-off in force:</b> the night feed and buy windows hold their inverter writes, the grid alerts stand
          down.
        </p>
      </Show>
      <Show when={props.status.last_event}>
        {event => (
          <p class="diag__reason">
            {event().what} — {formatRelativeTime(props.nowMs, event().when)}
          </p>
        )}
      </Show>
    </>
  );
}

function AutoGridOffRows(props: { status: AutoGridOffStatus; nowMs: number }) {
  return (
    <>
      <DiagRow
        label="Automatic"
        value={props.status.enabled ? describeDesire(props.status) : "Off"}
        title="grid_off.auto_enabled: off the grid unless a window, the battery or a guard keeps it on"
      />
      <Show when={props.status.enabled && props.status.reason}>{reason => <p class="diag__reason">{reason()}</p>}</Show>
      <Show when={props.status.enabled && props.status.next_switch}>
        {nextSwitch => (
          <DiagRow
            label="Next switch"
            value={`${nextSwitch().model === "151" ? "Off the grid" : "Back on the grid"} at ${formatClockTime(
              nextSwitch().at
            )} (${formatRelativeTime(props.nowMs, nextSwitch().at)}): ${nextSwitch().why}`}
            title="From the schedule as it stands; the battery can switch it sooner"
          />
        )}
      </Show>
    </>
  );
}

function describeDesire(status: AutoGridOffStatus): string {
  if (status.desired_model === undefined) return "On";
  return status.desired_model === "151" ? "On — off the grid (151)" : "On — on the grid (050)";
}

function confirmationQuestion(model: MachineModelCode): string {
  return model === "151"
    ? "Open the grid relay? The house then runs on PV and the battery alone, nothing is fed to the grid, and the grid only takes the house over by itself on an overload or a flat battery. Untested on this firmware: have someone at the inverter."
    : "Back to normal hybrid (050)? The inverter reconnects to the grid after its own grid check (~60 s).";
}

function describeGuards(settings: GridOffConfig): string {
  const guards = `Switches back to 050 by itself below ${settings.min_soc_percent} % SOC, ${settings.reconnect_before_window_minutes} min before a buy or sell window, on stale inverter or battery-current (SOC) readings and on a controller stop. Switching off needs ${settings.min_soc_percent + settings.switch_on_soc_margin_percent} % SOC, no window within ${settings.reconnect_before_window_minutes} min and ${settings.min_seconds_between_switches} s since the last switch.`;
  if (!settings.auto_enabled) return guards;
  return `${guards} Automatically it also goes back on the grid at ${settings.auto_full_soc_percent} % so the PV can export, and off again only below ${settings.auto_resume_soc_percent} %, with at least ${settings.auto_min_off_minutes} min before the next window's reconnect, and once the inverter's energy settings match.`;
}
