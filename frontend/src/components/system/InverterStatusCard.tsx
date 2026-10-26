import { For, Show } from "solid-js";
import { getBackendSyncedSignal } from "~/helpers/getBackendSyncedSignal";
import { formatDurationMs, formatRelativeTime, useNowMs } from "~/helpers/format";
import type { InverterOperatingStatus } from "../../../../backend/src/inverterComms/inverterStatus.types";
import { describeFaultRecordValues } from "../../../../backend/src/inverterComms/inverterFaultRecordText";
import { DiagRow } from "./DiagRow";

/**
 * What the inverter reports about itself (PI17 MOD / CFS / WS / HFS, polled about once a minute):
 * the place to check whether it is in Fault mode, and which fault code it latched.
 */
export function InverterStatusCard() {
  // silentReadErrors: a backend from before this card doesn't expose the key yet
  const [inverterStatus] = getBackendSyncedSignal("inverterStatus", undefined, true, true);
  const now = useNowMs(5000);

  return (
    <section class="card">
      <div class="card-head">
        <span class="eyebrow">Inverter status</span>
        <Show when={inverterStatus()?.working_mode}>
          {mode => <span class="card-meta">read {formatRelativeTime(now(), mode().time)}</span>}
        </Show>
      </div>
      <Show when={inverterStatus()} fallback={<p class="diag__reason">Not read yet.</p>}>
        {status => <InverterStatusRows status={status()} nowMs={now()} />}
      </Show>
    </section>
  );
}

function InverterStatusRows(props: { status: InverterOperatingStatus; nowMs: number }) {
  return (
    <>
      <DiagRow
        label="Working mode"
        value={
          props.status.working_mode
            ? `${props.status.working_mode.text} (${props.status.working_mode.code}), for ${props.status.working_mode.since_is_onset ? "" : "at least "}${formatDurationMs(props.nowMs - props.status.working_mode.since)}`
            : "—"
        }
        title="Fault mode (04) is the latched-fault state: battery and PV off, no backup"
      />
      <DiagRow
        label="Latest recorded fault"
        value={
          props.status.latest_fault
            ? `${props.status.latest_fault.text} (slot ${String(props.status.latest_fault.record_id).padStart(2, "0")})`
            : "—"
        }
        title="Sticky: the last fault the inverter recorded, active or long over — the working mode says which"
      />
      <DiagRow
        label="Warning flags"
        value={props.status.warnings ? props.status.warnings.active.join(", ") || "none" : "—"}
      />
      <Show when={props.status.fault_records.length}>
        <div
          class="diag__subhead"
          title="The firmware stores no readable time; the values follow the record layout inferred for this firmware"
        >
          Fault records in flash
        </div>
        <For each={props.status.fault_records}>
          {record => (
            <>
              <DiagRow
                label={`Slot ${String(record.record_id).padStart(2, "0")}`}
                value={record.fault_text}
                title={`Unidentified tokens: ${record.unidentified}`}
              />
              <Show when={record.values}>
                {values => <p class="diag__reason">At the fault: {describeFaultRecordValues(values())}</p>}
              </Show>
            </>
          )}
        </For>
      </Show>
    </>
  );
}
