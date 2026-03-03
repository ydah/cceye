import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClaudeDataRoots } from "../src/claude-data-paths.ts";

describe("resolveClaudeDataRoots", () => {
  const originalEnv = process.env.CLAUDE_CONFIG_DIR;
  let tempRoot = "";
  let tempHome = "";

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-paths-"));
    tempHome = path.join(tempRoot, "home");
    fs.mkdirSync(tempHome, { recursive: true });
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses CLAUDE_CONFIG_DIR entries exclusively when set", () => {
    const dirA = path.join(tempRoot, "a");
    const dirBProjects = path.join(tempRoot, "b", "projects");
    fs.mkdirSync(path.join(dirA, "projects"), { recursive: true });
    fs.mkdirSync(dirBProjects, { recursive: true });

    process.env.CLAUDE_CONFIG_DIR = `${dirA},${dirBProjects}`;
    const roots = resolveClaudeDataRoots("~/ignored/projects");

    expect(roots).toEqual([path.join(dirA, "projects"), dirBProjects]);
  });

  it("throws when CLAUDE_CONFIG_DIR is set but invalid", () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(tempRoot, "missing");
    expect(() => resolveClaudeDataRoots("~/ignored/projects")).toThrow(
      "no valid Claude data directories found in CLAUDE_CONFIG_DIR"
    );
  });

  it("returns configured path first and appends discovered defaults", () => {
    const configured = path.join(tempRoot, "custom", "projects");
    const xdgDefault = path.join(tempHome, ".config", "claude", "projects");
    const legacyDefault = path.join(tempHome, ".claude", "projects");
    fs.mkdirSync(xdgDefault, { recursive: true });
    fs.mkdirSync(legacyDefault, { recursive: true });

    const roots = resolveClaudeDataRoots(configured);

    expect(roots).toEqual([configured, xdgDefault, legacyDefault]);
  });
});
