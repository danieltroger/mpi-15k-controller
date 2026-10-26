import { type Accessor, onCleanup, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import type { InverterOperatingStatus } from "../inverterComms/inverterStatus.types.ts";
import type { AlertManager } from "./alertManager.ts";
import { errorLog, logLog, warnLog } from "../utilities/logging.ts";
import {
  faultModeP1Open,
  type InverterEpisodePaging,
  type InverterFaultAlert,
  type InverterFaultAlertState,
  persistableFaultAlerts,
  restoreFaultAlerts,
  stepInverterFaultAlerts,
} from "./inverterFaultAlertPolicy.ts";
import { loadFaultAlertState, saveFaultAlertState } from "./inverterFaultEpisodeStore.ts";

const EVALUATION_INTERVAL_MS = 15_000;

/**
 * Live wiring for the inverter's self-reported faults: snapshots the tracked MOD/CFS/WS status
 * every 15 s, runs the pure policy (inverterFaultAlertPolicy.ts), raises what it decides and keeps
 * the open episodes on disk (inverterFaultEpisodeStore.ts), so a restart neither pages again nor
 * loses the "Resolved".
 *
 * No startup grace here, unlike the staleness rules: these only ever act on actual readings, and
 * an inverter already in Fault mode when the controller boots is exactly what must page.
 */
export function startInverterFaultAlerts(ctx: {
  config: Accessor<Config>;
  manager: AlertManager;
  inverterStatus: Accessor<InverterOperatingStatus>;
  mqttValues: ReturnType<typeof useFromMqttProvider>["mqttValues"];
  paging: InverterEpisodePaging;
}) {
  let state = restoreFaultAlerts(loadFaultAlertState());
  if (state.faultMode || state.bypass) {
    logLog("Inverter fault: resuming the episode(s) open before the restart", persistableFaultAlerts(state));
  }
  ctx.paging.faultModeP1Open = faultModeP1Open(state);
  const evaluationTimer = setInterval(() => {
    // A throw out of a timer callback is an uncaught exception, i.e. a controller restart
    try {
      state = evaluationTick(ctx, state);
      ctx.paging.faultModeP1Open = faultModeP1Open(state);
      saveFaultAlertState(persistableFaultAlerts(state));
    } catch (error) {
      errorLog("Inverter fault alert evaluation failed, retrying next tick", error);
    }
  }, EVALUATION_INTERVAL_MS);
  onCleanup(() => clearInterval(evaluationTimer));
}

function evaluationTick(
  ctx: Parameters<typeof startInverterFaultAlerts>[0],
  previous: InverterFaultAlertState
): InverterFaultAlertState {
  const settings = untrack(ctx.config).alerting;
  const { state, alerts } = stepInverterFaultAlerts(
    previous,
    {
      nowMs: Date.now(),
      status: untrack(ctx.inverterStatus),
      gridVoltage: untrack(() => ctx.mqttValues.ac_input_voltage_r),
      stuckP1Open: ctx.paging.stuckP1Open,
    },
    settings
  );
  logNewFaultDecisions(previous, state, alerts, settings.inverter_fault_code_p2);
  for (const alert of alerts) raise(ctx.manager, alert);
  return state;
}

function raise(manager: AlertManager, alert: InverterFaultAlert): void {
  logLog(`Inverter fault: raising ${alert.severity} ${alert.key}: ${alert.title}`);
  void manager
    .raise(alert)
    .then(record => {
      // The policy now believes the family knows; say so loudly in the log if they don't
      if (alert.severity !== "P3" && (record.delivery === "cooldown" || record.delivery === "rate_capped")) {
        warnLog(
          `Inverter fault: the ${alert.severity} on ${alert.key} was not pushed (${record.delivery}): ${alert.title}`
        );
      }
    })
    .catch(error => errorLog(`Inverter fault: raising the ${alert.severity} ${alert.key} failed`, error));
}

/** A new fault code that is held back for the P1, or not sent because the page names it, deserves a log line */
function logNewFaultDecisions(
  previous: InverterFaultAlertState,
  state: InverterFaultAlertState,
  alerts: readonly InverterFaultAlert[],
  newFaultCodeAlertsEnabled: boolean
): void {
  const before = previous.lastSeenLatestFault;
  const after = state.lastSeenLatestFault;
  const codeChanged = !!before && !!after && (before.code !== after.code || before.recordId !== after.recordId);
  if (codeChanged && state.pendingNewFault) {
    logLog(
      `Inverter fault: new fault code ${state.pendingNewFault.text}; holding its P2 until a working-mode reading says whether the Fault-mode P1 covers it`
    );
  }
  const settled = (codeChanged || previous.pendingNewFault) && !state.pendingNewFault;
  const newFaultAlertRaised = alerts.some(alert => alert.key.startsWith("inverter-fault-code:"));
  if (settled && !newFaultAlertRaised && newFaultCodeAlertsEnabled && state.faultMode?.alertedSeverity) {
    logLog(
      `Inverter fault: the latest fault code F${String(after?.code).padStart(2, "0")} is named by the Fault-mode page, no separate P2`
    );
  }
}
