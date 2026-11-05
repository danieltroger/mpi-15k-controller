import { createSignal, For, getOwner, Show } from "solid-js";
import { getBackendSyncedSignal, sendBackendAction } from "~/helpers/getBackendSyncedSignal";
import { showToastWithMessage } from "~/helpers/showToastWithMessage";
import { useWebSocket } from "~/components/WebSocketProvider";
import { formatRelativeTime, useNowMs } from "~/helpers/format";
import type { EnergyDistributionStatus, GridOffStatus } from "../../../../backend/src/gridOff/gridOff.types";
import type { GridOffConfig } from "../../../../backend/src/config/config.types";
import type { MachineModelCode } from "../../../../backend/src/inverterComms/pi17Protocol.types";
import { describeMachineModel, MACHINE_MODEL_DESCRIPTIONS } from "../../../../backend/src/inverterComms/machineModel";
import { ENERGY_DISTRIBUTION_FIELD_LABELS } from "../../../../backend/src/gridOff/energyDistributionProfile";
import type { WsAction } from "../../../../backend/src/wsContract.types";
import { DiagRow } from "./DiagRow";
import "./GridOffCard.scss";

/** What the confirmation step is asking about: a DM switch, or the settings restore */
type PendingConfirmation = MachineModelCode | "restore";

/**
 * The grid-off switch: puts the inverter into Off-Grid III (machine model 151, the grid relay open on
 * battery) and back to normal hybrid (050). Shows what the inverter reads back next to what the
 * controller asked for, and the energy-distribution settings a DM change resets against the profile the
 * controller restores; each switch, and a manual restore, needs a second, in-page confirmation.
 */
export function GridOffCard() {
  // silentReadErrors: a backend from before this card doesn't expose the key yet
  const [gridOff] = getBackendSyncedSignal("gridOff", undefined, true, true);
  const [config] = getBackendSyncedSignal("config", undefined, false);
  const socket = useWebSocket();
  const owner = getOwner()!;
  const now = useNowMs(5000);
  const [confirming, setConfirming] = createSignal<PendingConfirmation | undefined>(undefined);
  const [sending, setSending] = createSignal(false);

  const sendConfirmed = async (pending: PendingConfirmation) => {
    setSending(true);
    const label = pending === "restore" ? "Normal settings" : "Grid relay";
    try {
      const result = await sendBackendAction(socket, actionFor(pending));
      await showToastWithMessage(owner, () => `${label} — ${result}`);
    } catch (error) {
      await showToastWithMessage(owner, () => `${label} — ${error instanceof Error ? error.message : error}`);
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
      <Show when={config()?.grid_off}>
        {gridOffConfig => <p class="diag__reason">{describeGuards(gridOffConfig())}</p>}
      </Show>
      <Show when={gridOff()?.energy_distribution}>
        {energyDistribution => <EnergyDistributionRows status={energyDistribution()} nowMs={now()} />}
      </Show>

      <Show
        when={confirming()}
        fallback={
          <div class="grid-off-card__actions">
            <button
              type="button"
              class="grid-off-card__btn"
              disabled={sending() || !gridOff()}
              onClick={() => setConfirming("151")}
            >
              Open grid relay (151)
            </button>
            <button
              type="button"
              class="grid-off-card__btn"
              disabled={sending() || !gridOff()}
              onClick={() => setConfirming("050")}
            >
              Back to normal (050)
            </button>
            <button
              type="button"
              class="grid-off-card__btn"
              disabled={sending() || !gridOff()?.energy_distribution}
              onClick={() => setConfirming("restore")}
            >
              Restore normal settings
            </button>
          </div>
        }
      >
        {pending => (
          <div class="grid-off-card__confirm">
            <p class="grid-off-card__question">{confirmationQuestion(pending(), gridOff()?.energy_distribution)}</p>
            <div class="grid-off-card__actions">
              <button
                type="button"
                class={`grid-off-card__btn${pending() === "151" ? " grid-off-card__btn--danger" : ""}`}
                disabled={sending()}
                onClick={() => void sendConfirmed(pending())}
              >
                {sending() ? "Sending…" : pending() === "restore" ? "Yes, restore" : `Yes, send DM${pending()}`}
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

/** The HECS settings a DM change resets, against the profile the controller restores */
function EnergyDistributionRows(props: { status: EnergyDistributionStatus; nowMs: number }) {
  const profileSource = () =>
    props.status.profile_source === "snapshot" && props.status.snapshot_taken_at !== undefined
      ? `the snapshot from before DM151 (${formatRelativeTime(props.nowMs, props.status.snapshot_taken_at)})`
      : "the config page's normal settings";
  return (
    <>
      <DiagRow
        label="Energy settings"
        value={
          props.status.mismatches === undefined
            ? "not read yet"
            : props.status.mismatches.length
              ? `${props.status.mismatches.length} differ from normal`
              : "normal"
        }
        title={`The HECS readback against ${profileSource()}. A machine model change resets these to the factory defaults; the controller restores them after a switch back to 050.`}
      />
      <Show when={props.status.mismatches?.length}>
        <ul class="grid-off-card__mismatches">
          <For each={props.status.mismatches}>
            {mismatch => (
              <li>
                {`${ENERGY_DISTRIBUTION_FIELD_LABELS[mismatch.field]}: ${mismatch.live ?? "not read"}, normal ${mismatch.wanted}`}
              </li>
            )}
          </For>
        </ul>
        <Show when={!props.status.restore}>
          <p class="diag__reason">
            Normal is {profileSource()}. Nothing is written without a machine model change: restore them below.
          </p>
        </Show>
      </Show>
      <Show when={props.status.restore}>
        {restore => (
          <p class="diag__reason">
            <b>Restoring</b> ({restore().trigger === "manual" ? "from this page" : "after the switch back to 050"},{" "}
            {formatRelativeTime(props.nowMs, restore().since)}): {restore().send_rounds} round(s) sent
            {restore().p2_raised ? "; still not read back, a P2 went out" : ""}.
          </p>
        )}
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

function actionFor(pending: PendingConfirmation): WsAction {
  if (pending === "restore") return "grid_off_restore_settings";
  return pending === "151" ? "grid_off_open_relay" : "grid_off_normal";
}

function confirmationQuestion(
  pending: PendingConfirmation,
  energyDistribution: EnergyDistributionStatus | undefined
): string {
  if (pending === "restore") {
    const differing = energyDistribution?.mismatches?.length ?? 0;
    return `Restore the normal energy settings? The controller re-reads them and sends ${differing ? `the ${differing} that differ` : "whatever differs"} (solar priority, battery to the loads, solar charge, feed to utility). Refused during a buy, sell or hold window and while grid-off is in force.`;
  }
  return pending === "151"
    ? "Open the grid relay? The house then runs on PV and the battery alone, nothing is fed to the grid, and the grid only takes the house over by itself on an overload or a flat battery. Untested on this firmware: have someone at the inverter."
    : "Back to normal hybrid (050)? The inverter reconnects to the grid after its own grid check (~60 s).";
}

function describeGuards(settings: GridOffConfig): string {
  return `Switches back to 050 by itself below ${settings.min_soc_percent} % SOC, ${settings.reconnect_before_window_minutes} min before a buy or sell window, on stale inverter readings and on a controller stop. Switching off needs ${settings.min_soc_percent + settings.switch_on_soc_margin_percent} % SOC, no window within ${settings.reconnect_before_window_minutes} min and ${settings.min_seconds_between_switches} s since the last switch.`;
}
