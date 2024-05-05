import { DepictAPIWS } from "@depict-ai/utilishared/latest";
import { createContext, JSX, useContext } from "solid-js";
import { isServer } from "solid-js/web";

const WebSocketContext = createContext<DepictAPIWS>();

export function WebSocketProvider(props: { children?: JSX.Element }) {
  let socket: DepictAPIWS | undefined;

  if (!isServer) {
    const { origin, hostname, protocol } = location;
    const isGöteborg = hostname.startsWith("192.168.0.");
    const isÖrebro = hostname.startsWith("192.168.1.");
    const u_o = new URL(isGöteborg ? "http://192.168.0.3" : isÖrebro ? "Http://192.168.1.102" : origin);
    u_o.protocol = protocol === "https:" ? "wss:" : "ws:";
    u_o.port = isGöteborg ? "7777" : "9321";

    socket = new DepictAPIWS(u_o.toString());
  }

  return <WebSocketContext.Provider value={socket}>{props.children}</WebSocketContext.Provider>;
}

export function useWebSocket() {
  return useContext(WebSocketContext);
}
