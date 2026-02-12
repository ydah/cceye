import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("dashboard layout", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates blessed-contrib layout widgets", async () => {
    const programMock = {};
    const screenMock = {
      key: vi.fn(),
      on: vi.fn(),
      render: vi.fn(),
      focused: null,
    };
    const setMock = vi
      .fn()
      .mockReturnValueOnce({ setContent: vi.fn(), focus: vi.fn() }) // costBox
      .mockReturnValueOnce({ setData: vi.fn(), focus: vi.fn() }) // trendLine
      .mockReturnValueOnce({ setData: vi.fn(), focus: vi.fn() }) // modelTable
      .mockReturnValueOnce({ setContent: vi.fn(), log: vi.fn(), scroll: vi.fn(), focus: vi.fn() }) // log
      .mockReturnValueOnce({ setContent: vi.fn() }); // status

    class GridMock {
      constructor(_: unknown) {}
      set = setMock;
    }
    const blessedMock = {
      program: vi.fn(() => programMock),
      screen: vi.fn(() => screenMock),
      box: {},
    };
    vi.doMock("blessed", () => ({ default: blessedMock }));
    vi.doMock("blessed-contrib", () => ({
      grid: GridMock,
      line: {},
      table: {},
      log: {},
    }));

    const { createLayout } = await import("../src/dashboard/layout.ts");
    const layout = createLayout();

    expect(blessedMock.program).toHaveBeenCalledWith(expect.objectContaining({ extended: false }));
    expect(blessedMock.screen).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Claude Code Eye", smartCSR: true, program: programMock })
    );
    expect(setMock).toHaveBeenCalledTimes(5);
    expect(layout.screen).toBe(screenMock);
  });
});
