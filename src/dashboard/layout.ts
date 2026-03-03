import blessed from "blessed";
import * as contrib from "blessed-contrib";
import { theme } from "./theme.js";
import type { LineChartWidget, LogWidget, TableWidget } from "./widget-types.js";

export interface DashboardLayout {
  screen: blessed.Widgets.Screen;
  grid: contrib.Grid;
  costBox: blessed.Widgets.BoxElement;
  trendLine: LineChartWidget;
  modelTable: TableWidget;
  notificationLog: LogWidget;
  statusBar: blessed.Widgets.BoxElement;
}

export function createLayout(): DashboardLayout {
  // Create Program explicitly to disable extended terminfo parsing.
  const program = blessed.program({ extended: false } as Parameters<typeof blessed.program>[0]);

  const screen = blessed.screen({
    program,
    smartCSR: true,
    title: "Claude Code Eye",
    warnings: false,
  });

  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  const costBox = grid.set<blessed.Widgets.BoxElement>(0, 0, 6, 6, blessed.box, {
    label: " Cost Progress ",
    border: { type: "line" },
    style: { border: { fg: theme.colors.border } },
    tags: true,
  });

  const trendLine = grid.set<LineChartWidget>(0, 6, 6, 6, contrib.line, {
    label: " Hourly Trend ",
    border: { type: "line" },
    style: { border: { fg: theme.colors.border } },
    showLegend: false,
  });

  const modelTable = grid.set<TableWidget>(6, 0, 5, 6, contrib.table, {
    label: " Breakdown ",
    border: { type: "line" },
    style: { border: { fg: theme.colors.border } },
    columnSpacing: 2,
    columnWidth: [22, 10, 6],
  });

  const notificationLog = grid.set<LogWidget>(6, 6, 5, 6, contrib.log, {
    label: " Recent Notifications ",
    border: { type: "line" },
    style: { border: { fg: theme.colors.border } },
  });

  const statusBar = grid.set<blessed.Widgets.BoxElement>(11, 0, 1, 12, blessed.box, {
    style: { bg: theme.colors.statusBar, fg: "white" },
    tags: false,
  });

  return {
    screen,
    grid,
    costBox,
    trendLine,
    modelTable,
    notificationLog,
    statusBar,
  };
}
