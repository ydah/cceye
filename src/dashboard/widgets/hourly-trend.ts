import type { TrendPoint } from "../../data-store.js";
import { theme } from "../theme.js";
import type { LineChartWidget } from "../widget-types.js";

export function updateHourlyTrend(chart: LineChartWidget, points: TrendPoint[]): void {
  if (!points.length) {
    chart.setData([{ title: "Cost", x: [""], y: [0], style: { line: theme.colors.trend } }]);
    return;
  }

  const x = points.map((point) => formatHour(point.hour));
  const y = points.map((point) => point.cost);
  chart.setData([
    {
      title: "Cost",
      x,
      y,
      style: { line: theme.colors.trend },
    },
  ]);
}

function formatHour(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return String(date.getHours()).padStart(2, "0");
}
