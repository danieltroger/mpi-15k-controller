import { Title } from "@solidjs/meta";
import { BatteryCard } from "~/components/dashboard/BatteryCard";
import { PowerFlowCard } from "~/components/dashboard/PowerFlowCard";
import { NextUpCard } from "~/components/dashboard/NextUpCard";
import { TemperatureChips } from "~/components/dashboard/TemperatureChips";
import { WaterHeaterCard } from "~/components/dashboard/WaterHeaterCard";
import { PricePlanChart } from "~/components/PricePlanChart";
import "~/components/dashboard/dashboard.scss";

export default function Home() {
  return (
    <main class="dashboard">
      <Title>Kraftverket</Title>
      <div class="dashboard__hero">
        <BatteryCard />
        <PowerFlowCard />
        <NextUpCard />
      </div>
      <PricePlanChart />
      <div class="dashboard__row">
        <WaterHeaterCard />
        <TemperatureChips />
      </div>
    </main>
  );
}
