import { Title } from "@solidjs/meta";
import { LiveReadings } from "~/components/system/LiveReadings";
import { DiagnosticsCards } from "~/components/system/DiagnosticsCards";
import { AlertsCard } from "~/components/system/AlertsCard";
import "./system.scss";

/** Live data + diagnostics merged: raw sensor truth on top, controller internals below. */
export default function System() {
  return (
    <main class="system">
      <Title>System — Kraftverket</Title>
      <h1>System</h1>
      <h2 class="system__heading">Alerts</h2>
      <AlertsCard />
      <h2 class="system__heading">Live readings</h2>
      <LiveReadings />
      <h2 class="system__heading">Controller internals</h2>
      <DiagnosticsCards />
    </main>
  );
}
