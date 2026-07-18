/**
 * Standalone FAKE backend for frontend development: speaks the ws message protocol on :9321 with
 * default_config as its state and the REAL applyConfigPatch semantics. It never touches hardware,
 * MQTT, Influx or a real config.json — safe to run anywhere, unlike index.ts (which must never be
 * started next to the live controller).
 *
 * Run:  cd backend && yarn node src/websocketBackend/mockConfigServer.ts
 * A production frontend build served on localhost derives ws://localhost:9321 automatically.
 */
import { WebSocket, WebSocketServer } from "ws";
import { applyConfigPatch } from "../config/configPatch.ts";
import { default_config } from "../config/config.ts";
import type { Config } from "../config/config.types.ts";
import type { ConfigPatch } from "../wsContract.types.ts";

const port = 9321;
let config: Config = seedConfig();

const connections = new Set<WebSocket>();
const wss = new WebSocketServer({ port });

wss.on("connection", ws => {
  connections.add(ws);
  ws.on("close", () => connections.delete(ws));
  ws.on("error", error => console.error("connection error", error));
  ws.on("message", data => {
    const msg = JSON.parse(data.toString());
    const { id, command, key, path, op, value } = msg;
    ws.send(JSON.stringify({ id, status: "ack" }));
    const reply = (payload: Record<string, unknown>) => ws.send(JSON.stringify({ id, ...payload }));

    if (command === "read") {
      // Non-config keys reply ok-without-value so unrelated widgets show their waiting states
      reply(key === "config" ? { status: "ok", value: config } : { status: "ok" });
    } else if (command === "patch") {
      if (key !== "config") {
        reply({ status: "not-ok", message: `Only the config key supports patch, got: ${key}` });
        return;
      }
      const result = applyConfigPatch(config, { path, op, value } as ConfigPatch);
      if ("error" in result) {
        console.log("patch REJECTED:", result.error);
        reply({ status: "not-ok", message: result.error });
        return;
      }
      config = result.patched;
      console.log("patch applied:", JSON.stringify({ path, op, value }));
      reply({ status: "ok" });
      const broadcast = JSON.stringify({ id: Math.random() + "", type: "change", key: "config", value: config });
      for (const connection of connections) connection.send(broadcast);
    } else if (command === "write") {
      reply({ status: "not-ok", message: "The whole-object write command no longer exists — patch instead" });
    } else if (command === "action") {
      reply({ status: "ok", value: "mock backend: action ignored" });
    } else {
      reply({ status: "not-ok", message: "Command not recognized: " + command });
    }
  });
});

console.log(`Mock config backend on ws://localhost:${port} — Ctrl-C to stop`);

/** Default config plus enough seeded content that every editor widget has something to show. */
function seedConfig(): Config {
  const seeded: Config = structuredClone(default_config);
  const inTwoHours = new Date();
  inTwoHours.setMinutes(120, 0, 0);
  const sellEnd = new Date(+inTwoHours + 2 * 3600_000);
  seeded.scheduled_power_selling.schedule[inTwoHours.toISOString()] = {
    end_time: sellEnd.toISOString(),
    power_watts: 12000,
  };
  seeded.thermometers = {
    "28-00000e8d0b6a": "Battery cell 3",
    "28-00000e8ddf12": "Cooling outlet left",
  };
  return seeded;
}
