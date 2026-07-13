import type { Config } from "./config/config.types.ts";
import type { AutoTraderStatus } from "./autoTrading/autoTraderState.types.ts";
import type { FetchedPrices } from "./autoTrading/priceService.types.ts";
import type { AlertRecord } from "./alerting/alerting.types.ts";
import type {
  CurrentBatteryPowerBroadcast,
  ElpatronDisplayState,
  MqttValue,
  MqttValueKey,
  TemperatureReadingBroadcast,
} from "./sharedTypes.ts";

/**
 * THE ws wire contract: every key the backend exposes mapped to the value it carries. Both sides
 * derive from this one map — wsMessaging types its accessor/action parameters with it (so the
 * backend cannot expose a mismatch) and the frontend's getBackendSyncedSignal infers its value
 * type from the key (so a typo'd key or a wrongly assumed shape is a compile error, not a runtime
 * surprise). Values are the PRESENT types; "hasn't arrived yet" undefined is added by the signal
 * layer. Pure types only — the frontend imports this file directly.
 */
export type WsExposedSignals = {
  /** The whole runtime config; the only writable key */
  config: Config;
  temperatures: Record<string, TemperatureReadingBroadcast>;
  autoTraderStatus: AutoTraderStatus;
  spotPrices: FetchedPrices;
  recentAlerts: AlertRecord[];
  elpatronState: ElpatronDisplayState;
  currentBatteryPower: CurrentBatteryPowerBroadcast;
  /** Clamped to [0,100] — the SOC the trading logic runs on */
  averageSOC: number;
  /** Shadow Ah ledger, unclamped — diagnostics only */
  socAh: number;
  socSinceEmpty: number;
  socSinceFull: number;
  /** Wh */
  assumedCapacity: number;
  /** W */
  assumedParasiticConsumption: number;
  /** Wh until full again */
  energyRemovedSinceFull: number;
  /** Wh until empty again */
  energyAddedSinceEmpty: number;
  /** ISO timestamp */
  totalLastFull: string;
  /** ms epoch */
  totalLastEmpty: number;
  isCharging: boolean;
  lastFeedWhenNoSolarReason: { what: string; when: number };
  lastChangingFeedWhenNoSolarReason: { what: string; when: number };
  /** Hall sensor 1, raw millivolts */
  voltageSagMillivoltsRaw: { value: number; time: number };
  voltageSagMillivoltsAveraged: number;
  /** Hall sensor 2 (positive pole) */
  voltageSagMillivoltsRaw2: { value: number; time: number };
  voltageSagMillivoltsAveraged2: number;
} & { [K in MqttValueKey]: MqttValue };

export type WsSignalKey = keyof WsExposedSignals;

/** Keys the frontend may write; everything else is read-only over the ws. */
export type WsWritableSignalKey = "config";

export type WsAction = "generate_trading_plan" | "clear_trading_vetoes" | "send_test_alert";

/**
 * What index.ts must hand wsMessaging: an accessor per contract key, except `config` and
 * `temperatures`, which wsMessaging wires itself. Accessors may yield undefined before their
 * subsystem has produced a value.
 */
export type WsExposedAccessorMap = {
  [K in Exclude<WsSignalKey, "config" | "temperatures">]: () => WsExposedSignals[K] | undefined;
};
