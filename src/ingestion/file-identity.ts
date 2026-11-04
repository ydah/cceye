import fs from "fs";
import path from "path";
import type { FileIdentity } from "../storage/storage.js";

export const identifySourceFile = (filePath: string, sourceKind = "claude"): FileIdentity => {
  const canonicalPath = fs.realpathSync(filePath);
  const stat = fs.statSync(canonicalPath);
  const device = typeof stat.dev === "number" ? stat.dev : "unknown";
  const inode = typeof stat.ino === "number" && stat.ino > 0 ? stat.ino : "unknown";
  const birthtime = Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : 0;
  return {
    sourceKind,
    canonicalPath: path.normalize(canonicalPath),
    fileIdentity: `${device}:${inode}:${birthtime}`,
  };
};
