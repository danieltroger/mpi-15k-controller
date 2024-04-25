import { MetaProvider, Title } from "@solidjs/meta";
import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import "./app.scss";
import { WebSocketProvider } from "~/components/WebSocketProvider";

export default function App() {
  return (
    <Router
      root={props => (
        <MetaProvider>
          <WebSocketProvider>
            <Title>SolidStart - Basic</Title>
            <Suspense>{props.children}</Suspense>
          </WebSocketProvider>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
