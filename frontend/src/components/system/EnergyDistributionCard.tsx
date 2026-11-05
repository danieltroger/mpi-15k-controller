import { For, Show } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { formatRelativeTime, useNowMs } from "~/helpers/format";
import type {
  EnergyDistributionFieldState,
  EnergyDistributionStatus,
} from "../../../../backend/src/energyDistribution/energyDistribution.types";
import { ENERGY_DISTRIBUTION_FIELD_LABELS } from "../../../../backend/src/energyDistribution/energyDistributionProfile";
import { describeMachineModel } from "../../../../backend/src/inverterComms/machineModel";
import { DiagRow } from "./DiagRow";
import "./EnergyDistributionCard.scss";

/**
 * The inverter's HECS energy-distribution settings against the config profile of the machine model it
 * reads (config inverter_energy_distribution): what is wanted, what the inverter has, and whether the
 * controller is still writing a difference.
 */
export function EnergyDistributionCard() {
  // silentReadErrors: a backend from before this card doesn't expose the key yet
  const [energyDistribution] = getBackendSyncedSignal("energyDistribution", undefined, true, true);
  const now = useNowMs(5000);
  return (
    <section class="card energy-distribution-card" aria-label="Energy settings">
      <div class="card-head">
        <span class="eyebrow">Energy settings (HECS)</span>
        <Show when={energyDistribution()?.hecs_read_at}>
          {readAt => <span class="card-meta">read {formatRelativeTime(now(), readAt())}</span>}
        </Show>
      </div>
      <Show when={energyDistribution()} fallback={<p class="diag__reason">Not read yet.</p>}>
        {status => <EnergyDistributionRows status={status()} nowMs={now()} />}
      </Show>
    </section>
  );
}

function EnergyDistributionRows(props: { status: EnergyDistributionStatus; nowMs: number }) {
  return (
    <>
      <DiagRow
        label="Profile in force"
        value={
          props.status.profile_name
            ? `${props.status.profile_name} (inverter reads ${describeMachineModel(props.status.machine_model)})`
            : `none — ${describeMachineModel(props.status.machine_model)}`
        }
        title="config inverter_energy_distribution: one profile per machine model, picked by the DM readback. Nothing is written without a fresh DM readback of 050 or 151."
      />
      <div class="energy-distribution-card__fields">
        <span class="energy-distribution-card__heading">Setting</span>
        <span class="energy-distribution-card__heading">Config</span>
        <span class="energy-distribution-card__heading">Inverter</span>
        <For each={props.status.fields}>{field => <FieldRow field={field} />}</For>
      </div>
      <Show when={props.status.divergence}>
        {divergence => (
          <p class="diag__reason">
            <b>{divergence().p2_raised ? "Still differs, a P2 went out" : "Enforcing"}</b> (since{" "}
            {formatRelativeTime(props.nowMs, divergence().since)}, {divergence().send_rounds} round(s) written
            {divergence().fallback_only ? "; change-triggered retries used up, only the 10-min fallback now" : ""})
            {props.status.waiting_reason ? `: ${props.status.waiting_reason}` : ""}.
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

function FieldRow(props: { field: EnergyDistributionFieldState }) {
  const managed = () => props.field.desired !== "unmanaged";
  const differs = () => managed() && props.field.inverter !== props.field.desired;
  return (
    <>
      <span class="energy-distribution-card__label">{ENERGY_DISTRIBUTION_FIELD_LABELS[props.field.field]}</span>
      <span class={`energy-distribution-card__value${managed() ? "" : " energy-distribution-card__value--unmanaged"}`}>
        {props.field.desired}
      </span>
      <span class={`energy-distribution-card__value${differs() ? " energy-distribution-card__value--differs" : ""}`}>
        {props.field.inverter ?? "not read"}
      </span>
    </>
  );
}
