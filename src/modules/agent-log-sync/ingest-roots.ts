import os from "node:os";
import path from "node:path";
import { groupedConfig } from "../../config.js";

export type RootBuildOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  codexSessionDir?: string;
  codexArchivedSessionDir?: string;
  antigravityLogDir?: string;
};

function parseAdditionalRoots(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function uniqueNonEmptyPaths(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function windowsCodexFallbackRoots(options?: RootBuildOptions): {
  sessionRoots: string[];
  archivedRoots: string[];
} {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  if (platform !== "win32") {
    return { sessionRoots: [], archivedRoots: [] };
  }

  const appDataRoots = [env.APPDATA, env.LOCALAPPDATA]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  const sessionRoots = appDataRoots.flatMap((base) => [
    path.join(base, "codex", "sessions"),
    path.join(base, "openai", "codex", "sessions"),
    path.join(base, "OpenAI", "Codex", "sessions"),
  ]);
  const archivedRoots = appDataRoots.flatMap((base) => [
    path.join(base, "codex", "archived_sessions"),
    path.join(base, "openai", "codex", "archived_sessions"),
    path.join(base, "OpenAI", "Codex", "archived_sessions"),
  ]);
  return { sessionRoots, archivedRoots };
}

function windowsAntigravityFallbackRoots(options?: RootBuildOptions): string[] {
  const platform = options?.platform ?? process.platform;
  const env = options?.env ?? process.env;
  if (platform !== "win32") return [];
  const appDataRoots = [env.APPDATA, env.LOCALAPPDATA]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());

  return appDataRoots.flatMap((base) => [
    path.join(base, "gemini", "antigravity-cli", "brain"),
    path.join(base, "gemini", "antigravity-ide", "brain"),
    path.join(base, "gemini", "antigravity", "brain"),
    path.join(base, "Google", "Gemini", "antigravity-cli", "brain"),
    path.join(base, "Google", "Gemini", "antigravity-ide", "brain"),
    path.join(base, "Google", "Gemini", "antigravity", "brain"),
  ]);
}

export function buildCodexIngestRoots(options?: RootBuildOptions): string[] {
  const env = options?.env ?? process.env;
  const windowsFallback = windowsCodexFallbackRoots(options);
  const codexSessionDir = options?.codexSessionDir ?? groupedConfig.codex.sessionDir;
  const codexArchivedSessionDir =
    options?.codexArchivedSessionDir ?? groupedConfig.codex.archivedSessionDir;

  return uniqueNonEmptyPaths([
    codexSessionDir,
    codexArchivedSessionDir,
    ...windowsFallback.sessionRoots,
    ...windowsFallback.archivedRoots,
    ...parseAdditionalRoots(env.MEMORY_ROUTER_CODEX_SESSION_DIRS),
    ...parseAdditionalRoots(env.MEMORY_ROUTER_CODEX_ARCHIVED_SESSION_DIRS),
  ]);
}

export function buildAntigravityIngestRoots(options?: RootBuildOptions): string[] {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const homeGeminiDir = path.join(homeDir, ".gemini");
  const antigravityLogDir = options?.antigravityLogDir ?? groupedConfig.antigravity.logDir;

  return uniqueNonEmptyPaths([
    antigravityLogDir,
    path.join(homeGeminiDir, "antigravity-cli", "brain"),
    path.join(homeGeminiDir, "antigravity-ide", "brain"),
    path.join(homeGeminiDir, "antigravity", "brain"),
    ...windowsAntigravityFallbackRoots(options),
    ...parseAdditionalRoots(env.MEMORY_ROUTER_ANTIGRAVITY_LOG_DIRS),
  ]);
}

export function decodeClaudeProjectPath(encoded: string): {
  projectName: string;
  projectRoot: string;
} {
  const normalized = encoded.startsWith("-") ? encoded : `-${encoded}`;
  const decoded = normalized.replace(/-/g, "/");
  const parts = decoded.split("/");
  const projectName = parts[parts.length - 1] || "Unknown";
  return { projectName, projectRoot: decoded };
}

export function buildClaudeIngestRoots(options?: RootBuildOptions): string[] {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const claudeProjectsDir = path.join(homeDir, ".claude", "projects");

  return uniqueNonEmptyPaths([
    claudeProjectsDir,
    ...parseAdditionalRoots(env.MEMORY_ROUTER_CLAUDE_LOG_DIRS),
  ]);
}
