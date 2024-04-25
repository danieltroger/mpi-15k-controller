import { WebSocket, WebSocketServer, Server } from "ws";
import { error, log, warn } from "./logging";
import { IncomingMessage } from "http";
import { catchify } from "@depict-ai/utilishared/latest";

const max_connection_age = 1000 * 60 * 60; //ms
const ping_interval = 1000 * 5; // ms
const port = 9321;
const connections = new Set<WebSocket>();

export async function startWsServer<T extends { id: string; [key: string]: any }>(
  handle_message: (message: T) => Promise<string>
) {
  let wss: Server<typeof WebSocket, typeof IncomingMessage>;
  const start_server = () => {
    wss = new WebSocketServer({ port });
    wss.on(
      "error",
      catchify(async (e: Error) => {
        error("WS server had an error", e, "restarting it in 5s");
        wss.close();
        await new Promise(r => setTimeout(r, 5000));
        start_server();
      })
    );

    wss.on(
      "connection",
      catchify(async ws => {
        connections.add(ws);
        let last_movement = +new Date();
        ws.on("close", () => (last_movement = 0));
        ws.on("error", m => {
          log("Connection had error, killing it", m);
          last_movement = 0;
        });
        ws.on("pong", () => (last_movement = +new Date()));
        ws.on(
          "message",
          catchify(async data => {
            const decoded = JSON.parse(data.toString());
            if (!decoded.id) {
              warn("Cannot handle message", decoded, data, "because it doesn't have an id");
              return;
            }
            ws.send(
              JSON.stringify({
                id: decoded.id,
                status: "ack",
              })
            );
            const response = await handle_message(decoded);
            if (response) {
              ws.send(response);
            }
          })
        );
        while (+new Date() - last_movement < max_connection_age) {
          ws.ping(Math.random() + "");
          await new Promise(r => setTimeout(r, ping_interval));
        }
        ws.close();
        connections.delete(ws);
      })
    );

    log("Started websocket server");
  };

  start_server();
  const broadcast = (msg: string) => {
    for (const connection of connections) {
      connection.send(msg);
    }
  };
  return { broadcast };
}
