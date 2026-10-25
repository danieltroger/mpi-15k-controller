import { type Accessor, createEffect, untrack } from "solid-js";
import type { Config } from "../config/config.types.ts";
import { useFromMqttProvider } from "../mqttValues/MQTTValuesProvider.ts";
import { warnLog } from "../utilities/logging.ts";

/** Publishes the Ah ledger's SOC UNclamped (so the drift shows in Grafana) whenever it is known. */
export function publishSocAh({ config, socAh }: { config: Accessor<Config>; socAh: Accessor<number | undefined> }) {
  const { mqttClient } = useFromMqttProvider();
  createEffect(() => {
    const client = mqttClient();
    if (!client) return;
    createEffect(() => {
      const value = socAh();
      // Never NaN/±Infinity (that would corrupt the line-protocol point), and nothing while it's unknown.
      if (value == undefined || !isFinite(value)) return;
      const table = untrack(() => config().soc_calculations.table);
      const line = `${table} soc_ah=${value}`;
      if (client.connected) {
        client.publish(table, line).catch(error => warnLog("Failed to publish soc_ah", error));
      }
    });
  });
}
