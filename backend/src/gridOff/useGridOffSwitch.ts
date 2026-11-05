/**
 * The grid-off switch's live wiring: the page asks for Off-Grid III (machine model 151, the grid relay open
 * on battery) or normal hybrid (050); the guards switch back to 050 on a low SOC, an upcoming buy or sell
 * window, stale readings or a 151 that never applied; a clean stop switches back (gridOffShutdown.ts); and a
 * 151 read while 050 is wanted, at startup above all, is switched back too, with resends backing off and a
 * P1 once it stays stuck (gridOffStuckAlert.ts). Nothing here writes on its own initiative except DM050, and
 * only while the inverter reads 151. Decisions: gridOffDecisions.ts.
 */
import { type Accessor, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import type { DecodedRound } from "../inverterComms/pi17Protocol.types.ts";
import type { SetterQueueItem } from "../inverterComms/inverterComms.types.ts";
import type { AlertManager } from "../alerting/alertManager.ts";
import { useInverterComms } from "../inverterComms/InverterCommsProvider.ts";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import { useBatteryValuesProvider } from "../battery/BatteryValuesProvider.ts";
import { errorLog, logLog } from "../utilities/logging.ts";
import { NORMAL_HYBRID_MODEL, OFF_GRID_III_MODEL } from "../inverterComms/machineModel.ts";
import { NO_SWITCH_BACK_SENDS, NOT_STUCK_OFF_GRID, type StuckOffGridTracking } from "./gridOffDecisions.ts";
import type { GridOffEvent, GridOffStatus } from "./gridOff.types.ts";
import { holdGridOffThroughShutdown } from "./gridOffShutdown.ts";
import {
  correctedGridOffSettings,
  evaluateGuards,
  type GridOffContext,
  isLoggedSettingsQuery,
  type MachineModelReadback,
  queueMachineModel,
  recordMachineModelReadback,
  requestNormal,
  requestOffGrid,
  type RequestedModel,
} from "./gridOffActions.ts";

/** How often the time-based guards (SOC, windows, staleness, the confirm deadline, stuck) are re-judged */
const GUARD_TICK_INTERVAL_MS = 10_000;

export function useGridOffSwitch({ config, raise }: { config: Accessor<Config>; raise: AlertManager["raise"] }) {
  const { queueSetter, lastDecodedRound } = useInverterComms();
  const { mqttValues } = useFromMqttProvider();
  const { clampedSocAh } = useBatteryValuesProvider();
  return createGridOffSwitch({
    config,
    queueSetter,
    lastDecodedRound,
    mqttValues,
    soc: clampedSocAh,
    raise,
    wallClockNowMs: () => Date.now(),
  });
}

/** Everything the switch reads and writes, as plain accessors so a selftest can build the graph */
export type GridOffEnvironment = {
  config: Accessor<Config>;
  queueSetter: (item: SetterQueueItem) => void;
  /** DM rounds give the readback; GPMP/HECS/BATS rounds are kept whole for the before/after log */
  lastDecodedRound: Accessor<DecodedRound | undefined>;
  /** Only GS's battery_voltage and PS's ac_output_total_active_power are read, for freshness */
  mqttValues: GridOffContext["mqttValues"];
  /** THE SOC (clampedSocAh) */
  soc: Accessor<number | undefined>;
  raise: AlertManager["raise"];
  /** Date.now() in production */
  wallClockNowMs: () => number;
};

export function createGridOffSwitch(environment: GridOffEnvironment) {
  const { config, queueSetter, lastDecodedRound, mqttValues, soc, raise, wallClockNowMs } = environment;
  // Never persisted: every controller start wants 050, which is what makes a 151 at startup switch back
  const [requested, setRequested] = createSignal<RequestedModel>({ model: NORMAL_HYBRID_MODEL, atMs: undefined });
  const [readback, setReadback] = createSignal<MachineModelReadback | undefined>(undefined);
  const [lastEvent, setLastEvent] = createSignal<GridOffEvent | undefined>(undefined);
  const [stuckTracking, setStuckTracking] = createSignal<StuckOffGridTracking>(NOT_STUCK_OFF_GRID, {
    equals: (previous, next) => previous.conditionSinceMs === next.conditionSinceMs && previous.stuck === next.stuck,
  });
  const settings = createMemo(() => correctedGridOffSettings(config().grid_off));
  const context: GridOffContext = {
    config,
    settings,
    queueSetter,
    mqttValues,
    soc,
    raise,
    wallClockNowMs,
    requested,
    setRequested,
    readback,
    setLastEvent,
    stuckTracking,
    setStuckTracking,
    readbackCount: 0,
    lastReconciliationReason: undefined,
    latestSettingsFields: {},
    switchBackSends: NO_SWITCH_BACK_SENDS,
    lastSwitchAtMs: undefined,
  };

  createEffect(() => {
    const round = lastDecodedRound();
    if (!round || !isLoggedSettingsQuery(round.command)) return;
    context.latestSettingsFields[round.command] = round.fields;
    if (round.command === "DM") recordMachineModelReadback(context, round, setReadback);
  });

  // The shutdown switch-back needs the raw state: a stuck 151 is still a 151 worth one more DM050
  const inverterMayBeOffGrid = createMemo(
    () => requested().model === OFF_GRID_III_MODEL || readback()?.model === OFF_GRID_III_MODEL
  );
  // What everything else holds for: not once stuck, when buying and the held alerts must come back
  const gridOffInForce = createMemo(
    () =>
      requested().model === OFF_GRID_III_MODEL || (readback()?.model === OFF_GRID_III_MODEL && !stuckTracking().stuck)
  );
  createEffect(() =>
    logLog(
      gridOffInForce()
        ? "Grid off in force: the night feed and buy windows hold their inverter writes, the grid alerts stand down"
        : inverterMayBeOffGrid()
          ? "Grid off stuck: the inverter reads 151 while 050 is wanted — feeding, buying and the grid alerts run normally again"
          : "Grid off not in force: feeding, buying and the grid alerts run normally"
    )
  );

  // Reactive on what can trip a guard at once (a SOC update, a window added that is already running); the
  // tick covers the passing of time
  createEffect(() => {
    requested();
    readback();
    soc();
    config();
    untrack(() => evaluateGuards(context));
  });
  const guardTimer = setInterval(() => {
    // A throw out of a timer callback is an uncaught exception, i.e. a controller restart
    try {
      evaluateGuards(context);
    } catch (error) {
      errorLog("Grid off: evaluating the guards failed, retrying next tick", error);
    }
  }, GUARD_TICK_INTERVAL_MS);
  onCleanup(() => clearInterval(guardTimer));

  holdGridOffThroughShutdown({
    inverterMayBeOffGrid,
    settings,
    sendNormalHybrid: onResult => queueMachineModel(context, NORMAL_HYBRID_MODEL, onResult),
  });

  const requestedMachineModel = createMemo(() => requested().model);

  const status = createMemo<GridOffStatus>(() => ({
    requested_model: requested().model,
    requested_at: requested().atMs,
    readback_model: readback()?.model,
    readback_at: readback()?.atMs,
    grid_off_in_force: gridOffInForce(),
    stuck_off_grid: stuckTracking().stuck,
    last_event: lastEvent(),
  }));

  return {
    /** 151 requested, or read back and not stuck: feeding/buying writes hold, the grid alerts stand down */
    gridOffInForce,
    /** The model asked for: until the DM readback shows it, the energy-distribution enforcement holds its writes */
    requestedMachineModel,
    status,
    /** The page's "open the grid relay" (DM151): refused, with the reason thrown, unless every precondition holds */
    requestOffGrid: async () => requestOffGrid(context),
    /** The page's "back to normal" (DM050): always allowed */
    requestNormal: async () => requestNormal(context),
  };
}
