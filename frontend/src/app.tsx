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
              <footer style={{ "margin-top": "2rem", "font-size": "0.8rem", opacity: "0.7" }}>
                Free software under the{" "}
                <a href="https://github.com/danieltroger/mpi-15k-controller" target="_blank" rel="noopener noreferrer">
                  AGPL-3.0 — source code
                </a>
                .
              </footer>
            </WebSocketProvider>
          </MetaProvider>
        );
      }}
    >
      <FileRoutes />
    </Router>
  );
}
