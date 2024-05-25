import { Title as PageTitle } from "@solidjs/meta";
import "./soc-playground.scss";
import { onMount } from "solid-js";
import { Chart, Title, Tooltip, Legend, Colors } from "chart.js";
import { Line } from "solid-chartjs";

export default function SocPlayground() {
  /**
   * You must register optional elements before using the chart,
   * otherwise you will have the most primitive UI
   */
  onMount(() => {
    Chart.register(Title, Tooltip, Legend, Colors);
  });

  const chartData = {
    labels: ["January", "February", "March", "April", "May"],
    datasets: [
      {
        label: "Sales",
        data: [50, 60, 70, 80, 90],
      },
    ],
  };
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
  };

  return (
    <main class="soc-playground">
      <PageTitle>SOC playground</PageTitle>
      <h1>SOC playground</h1>
      <div>
        <Line data={chartData} options={chartOptions} width={500} height={500} />
      </div>
    </main>
  );
}
