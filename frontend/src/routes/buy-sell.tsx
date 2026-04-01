import { Title } from "@solidjs/meta";
import { BuySellConfigForm } from "~/components/BuySellConfigForm";

export default function BuySell() {
  return (
    <main class="buy-sell-page">
      <Title>Buy / sell power</Title>
      <h1>Buy / sell power</h1>
      <BuySellConfigForm />
    </main>
  );
}
