import { DepictAPIWS } from "@depict-ai/utilishared/latest";
import { createContext, JSX, useContext } from "solid-js";
import { getRequestEvent, isServer } from "solid-js/web";

const WebSocketContext = createContext<DepictAPIWS>();

export function WebSocketProvider(props: { children?: JSX.Element }) {
  let origin: string;
  if (isServer) {
    const event = getRequestEvent();
    origin = new URL(event!.request.url).origin;
  } else {
    ({ origin } = location);
  }
  const u_o = new URL(origin);
  u_o.protocol = u_o.protocol === "https:" ? "wss:" : "ws:";
  u_o.port = "9321";

  const socket = new DepictAPIWS(u_o.toString());

  return <WebSocketContext.Provider value={socket}>{props.children}</WebSocketContext.Provider>;
}

export function useWebSocket() {
  return useContext(WebSocketContext);
}
