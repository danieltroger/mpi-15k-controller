import type { Config } from "./config/config.types.ts";
import type { LedgerAnchor } from "./battery/ahLedger.types.ts";
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
  /** THE SOC everything runs on: the Ah ledger clamped to [0,100] */
  averageSOC: number;
  /** Raw unclamped Ah-ledger SOC — diagnostics only, may exceed [0,100] */
  socAh: number;
  /** Latest full/empty/soft-empty anchor — the "last full / last empty" source */
  latestAnchor: LedgerAnchor;
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
