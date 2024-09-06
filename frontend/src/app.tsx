import { MetaProvider, Title } from "@solidjs/meta";
import { A, Router, useLocation } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Show, Suspense } from "solid-js";
import "./app-dark.scss";
import "./app-light.scss";
import { WebSocketProvider } from "~/components/WebSocketProvider";

export default function App() {
  return (
    <Router
      root={props => {
        const location = useLocation();
        return (
          <MetaProvider>
            <WebSocketProvider>
              <Title>SolidStart - Basic</Title>
              <Suspense>
                <Show when={location.pathname !== "/"}>
                  <A href="/">Back</A>
                  <br />
                </Show>
                {props.children}
              </Suspense>
            </WebSocketProvider>
          </MetaProvider>
        );
      }}
    >
      <FileRoutes />
    </Router>
  );
}
