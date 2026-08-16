import type { ModelCost } from "../../data-store.js";
import type { TableWidget } from "../widget-types.js";

export function updateModelBreakdown(
  table: TableWidget,
  items: ModelCost[],
  primaryColumn: "Model" | "Project" = "Model"
): void {
  const total = items.reduce((sum, item) => sum + (item.cost ?? 0), 0);
  const rows = [...items]
    .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
    .map((item) => {
      const percent = item.cost === null || total <= 0 ? 0 : (item.cost / total) * 100;
      return [sanitizeLabel(item.model), item.cost === null ? "UNPRICED" : `$${item.cost.toFixed(2)}`, `${percent.toFixed(0)}%`];
    });
  table.setData({
    headers: [primaryColumn, "Cost", "%"],
    data: rows,
  });
}

function sanitizeLabel(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127;
    })
    .join("")
    .slice(0, 200);
}
