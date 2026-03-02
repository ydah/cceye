import fs from "fs";
import os from "os";
import path from "path";

const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
const PROJECTS_DIR_NAME = "projects";

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function normalize(value: string): string {
  return path.resolve(expandHome(value));
}

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function toProjectsPath(value: string): string {
  const normalized = normalize(value);
  if (path.basename(normalized) === PROJECTS_DIR_NAME) {
    return normalized;
  }
  return path.join(normalized, PROJECTS_DIR_NAME);
}

function parseEnvConfigDirs(raw: string): string[] {
  const roots = raw
    .split(",")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
    .map(toProjectsPath)
    .filter(isDirectory);
  return Array.from(new Set(roots));
}

export function resolveClaudeDataRoots(configuredPath: string): string[] {
  const envRaw = (process.env[CLAUDE_CONFIG_DIR_ENV] ?? "").trim();
  if (envRaw.length > 0) {
    const fromEnv = parseEnvConfigDirs(envRaw);
    if (fromEnv.length > 0) {
      return fromEnv;
    }
    throw new Error(
      `no valid Claude data directories found in ${CLAUDE_CONFIG_DIR_ENV}; expected an existing '${PROJECTS_DIR_NAME}' directory or a parent directory containing an existing '${PROJECTS_DIR_NAME}' subdirectory`
    );
  }

  const configured = normalize(configuredPath);
  const defaults = [normalize("~/.config/claude/projects"), normalize("~/.claude/projects")];
  const result = [configured];

  for (const candidate of defaults) {
    if (candidate === configured) {
      continue;
    }
    if (isDirectory(candidate)) {
      result.push(candidate);
    }
  }

  return result;
}
