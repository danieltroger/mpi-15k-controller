import { DepictAPIWS } from "@depict-ai/utilishared/latest";
import { createContext, JSX, useContext } from "solid-js";
import { isServer } from "solid-js/web";

const WebSocketContext = createContext<DepictAPIWS>();

export function WebSocketProvider(props: { children?: JSX.Element }) {
  let socket: DepictAPIWS | undefined;

  if (!isServer) {
    const u_o = new URL(location.origin);
    u_o.protocol = u_o.protocol === "https:" ? "wss:" : "ws:";
    u_o.port = "9321";

    socket = new DepictAPIWS(u_o.toString());
  }

  return <WebSocketContext.Provider value={socket}>{props.children}</WebSocketContext.Provider>;
}

export function useWebSocket() {
  return useContext(WebSocketContext);
}
