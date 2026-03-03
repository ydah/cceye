export interface LineSeries {
  title: string;
  x: string[];
  y: number[];
  style?: {
    line?: string;
  };
}

export interface LineChartWidget {
  focus(): void;
  setData(data: LineSeries[]): void;
}

export interface TableWidget {
  focus(): void;
  setLabel?(label: string): void;
  setData(data: {
    headers: string[];
    data: string[][];
  }): void;
}

export interface LogWidget {
  focus(): void;
  setContent(value: string): void;
  log(value: string): void;
  scroll(offset: number): void;
}
