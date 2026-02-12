declare module "blessed-contrib" {
  import type { Widgets } from "blessed";

  export interface GridOptions {
    rows: number;
    cols: number;
    screen: Widgets.Screen;
  }

  export interface Grid {
    set<T>(
      row: number,
      col: number,
      rowSpan: number,
      colSpan: number,
      widget: unknown,
      options?: unknown
    ): T;
  }

  export class grid implements Grid {
    constructor(options: GridOptions);
    set<T>(
      row: number,
      col: number,
      rowSpan: number,
      colSpan: number,
      widget: unknown,
      options?: unknown
    ): T;
  }

  export const line: unknown;
  export const table: unknown;
  export const log: unknown;
}
