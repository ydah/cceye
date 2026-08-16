import fs from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { protectPrivateDirectory, protectPrivateFile } from "../src/file-permissions.ts";

describe("private file permissions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed when POSIX permission hardening fails", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("permission denied");
    });

    expect(() => protectPrivateDirectory("/private/config")).toThrow("could not secure directory permissions");
    expect(() => protectPrivateFile("/private/config/config.yaml")).toThrow("could not secure file permissions");
  });

  it("allows best-effort permission hardening on Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("permission denied");
    });

    expect(() => protectPrivateDirectory("C:\\config")).not.toThrow();
    expect(() => protectPrivateFile("C:\\config\\config.yaml")).not.toThrow();
  });
});
