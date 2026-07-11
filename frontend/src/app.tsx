import { MetaProvider, Title } from "@solidjs/meta";
import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import "./styles/theme.scss";
import { WebSocketProvider } from "~/components/WebSocketProvider";
import { TopNav } from "~/components/TopNav";
import { ConnectionBanner } from "~/components/ConnectionBanner";

export default function App() {
  return (
    <Router
      root={props => (
        <MetaProvider>
          <WebSocketProvider>
            <Title>Kraftverket</Title>
            <TopNav />
            <ConnectionBanner />
            <Suspense>{props.children}</Suspense>
            <footer class="app-footer">
              Free software under the{" "}
              <a href="https://github.com/danieltroger/mpi-15k-controller" target="_blank" rel="noopener noreferrer">
                AGPL-3.0 — source code
              </a>
              .
            </footer>
          </WebSocketProvider>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
