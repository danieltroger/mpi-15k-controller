import { Title } from "@solidjs/meta";
import { BuySellConfigForm } from "~/components/BuySellConfigForm";
import { AutoTraderPanel } from "~/components/AutoTraderPanel";
import { PricePlanChart } from "~/components/PricePlanChart";

export default function BuySell() {
  return (
    <main class="buy-sell-page">
      <Title>Trading — Kraftverket</Title>
      <h1>Trading</h1>
      <PricePlanChart />
      <AutoTraderPanel />
      <BuySellConfigForm />
    </main>
  );
}
