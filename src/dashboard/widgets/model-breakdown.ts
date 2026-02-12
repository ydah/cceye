import type { ModelCost } from "../../data-store.js";
import type { TableWidget } from "../widget-types.js";

export function updateModelBreakdown(table: TableWidget, items: ModelCost[]): void {
  const total = items.reduce((sum, item) => sum + item.cost, 0);
  const rows = [...items]
    .sort((a, b) => b.cost - a.cost)
    .map((item) => {
      const percent = total > 0 ? (item.cost / total) * 100 : 0;
      return [item.model, `$${item.cost.toFixed(2)}`, `${percent.toFixed(0)}%`];
    });
  table.setData({
    headers: ["Model", "Cost", "%"],
    data: rows,
  });
}
