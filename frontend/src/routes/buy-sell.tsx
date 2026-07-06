import { Title } from "@solidjs/meta";
import { BuySellConfigForm } from "~/components/BuySellConfigForm";
import { AutoTraderPanel } from "~/components/AutoTraderPanel";

export default function BuySell() {
  return (
    <main class="buy-sell-page">
      <Title>Buy / sell power</Title>
      <h1>Buy / sell power</h1>
      <AutoTraderPanel />
      <BuySellConfigForm />
    </main>
  );
}
