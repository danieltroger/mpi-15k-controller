import { catchify, DepictAPIWS } from "@depict-ai/utilishared/latest";
import { type Accessor, createContext, createSignal, type JSX, useContext } from "solid-js";
import { isServer } from "solid-js/web";

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

const WebSocketContext = createContext<DepictAPIWS>();

const ConnectionContext = createContext<{
  status: Accessor<ConnectionStatus>;
  lastMessageAt: Accessor<number | undefined>;
}>({ status: () => "connecting" as ConnectionStatus, lastMessageAt: () => undefined });

export function WebSocketProvider(props: { children?: JSX.Element }) {
  let socket: DepictAPIWS | undefined;
  const [status, setStatus] = createSignal<ConnectionStatus>("connecting");
  const [lastMessageAt, setLastMessageAt] = createSignal<number>();

  if (!isServer) {
    const { origin, hostname, protocol } = location;
    const isGöteborg = hostname.startsWith("192.168.0.") || process.env.NODE_ENV === "development";
    const isÖrebro = hostname.startsWith("192.168.1.");
    const u_o = new URL(isGöteborg ? "http://192.168.0.3" : isÖrebro ? "Http://192.168.1.106" : origin);
    u_o.protocol = protocol === "https:" ? "wss:" : "ws:";
    u_o.port = isGöteborg ? "7777" : "9321";

    socket = new DepictAPIWS(u_o.toString());
    // DepictAPIWS re-dispatches the underlying socket's events on itself across reconnects, so
    // these listeners survive connection churn. "close" also fires for failed connect attempts,
    // which is exactly when the UI must warn that the values on screen aren't live.
    if (socket.current_socket?.readyState === WebSocket.OPEN) setStatus("live");
    socket.addEventListener(
      "open",
      catchify(() => setStatus("live"))
    );
    socket.addEventListener(
      "close",
      catchify(() => setStatus("reconnecting"))
    );
    socket.addEventListener(
      "message",
      catchify(() => setLastMessageAt(Date.now()))
    );
  }

  return (
    <WebSocketContext.Provider value={socket}>
      <ConnectionContext.Provider value={{ status, lastMessageAt }}>{props.children}</ConnectionContext.Provider>
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  return useContext(WebSocketContext);
}

/** Live connection state for the nav dot + stale-data banner. */
export function useConnection() {
  return useContext(ConnectionContext);
}
