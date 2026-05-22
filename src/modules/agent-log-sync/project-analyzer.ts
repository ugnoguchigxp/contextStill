import path from "node:path";
import { fileURLToPath } from "node:url";

export type ProjectContext = {
  cwd?: string;
  projectRoot?: string;
  projectName?: string;
  sessionStartedAt?: string;
};

const AGENT_TASK_LOG_BASENAME_RE = /^task-\d+\.log$/i;

export function decodeFileUrl(fileUrl: string): string | null {
  try {
    return fileURLToPath(fileUrl);
  } catch {
    return fileUrl.replace(/^file:\/\//, "");
  }
}

export function isAgentTaskLogPath(rawPath: string | undefined): boolean {
  if (!rawPath) return false;
  const decodedPath = rawPath.startsWith("file://") ? decodeFileUrl(rawPath) : rawPath;
  const normalizedPath = decodedPath?.replace(/^["'`]+|["'`]+$/g, "").trim();
  return normalizedPath ? AGENT_TASK_LOG_BASENAME_RE.test(path.basename(normalizedPath)) : false;
}

export function deriveProjectFromPath(rawPath: string | undefined): ProjectContext {
  if (!rawPath) return {};
  const decodedPath = rawPath.startsWith("file://") ? decodeFileUrl(rawPath) : rawPath;
  const normalizedPath = decodedPath?.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!normalizedPath) return {};
  if (isAgentTaskLogPath(normalizedPath)) return {};

  const parts = normalizedPath.split(path.sep).filter(Boolean);
  const codeIndex = parts.lastIndexOf("Code");
  if (codeIndex >= 0 && parts[codeIndex + 1]) {
    const projectRoot = `${path.sep}${parts.slice(0, codeIndex + 2).join(path.sep)}`;
    return {
      projectRoot,
      projectName: parts[codeIndex + 1],
    };
  }

  if (path.isAbsolute(normalizedPath)) {
    return {
      projectRoot: normalizedPath,
      projectName: path.basename(normalizedPath),
    };
  }

  return {};
}

export function extractPathCandidates(text: string | undefined): string[] {
  if (!text) return [];
  const candidates = new Set<string>();
  for (const match of text.matchAll(/file:\/\/[^\s`"'<>),]+/g)) {
    if (match[0]) candidates.add(match[0]);
  }
  for (const match of text.matchAll(/\/Users\/[^\s`"'<>),]+\/Code\/[^\s`"'<>),]+/g)) {
    if (match[0]) candidates.add(match[0]);
  }
  return [...candidates];
}

export function deriveProjectContextFromValues(values: Array<string | undefined>): ProjectContext {
  for (const value of values) {
    for (const candidate of extractPathCandidates(value)) {
      const context = deriveProjectFromPath(candidate);
      if (context.projectName) return context;
    }

    const context = deriveProjectFromPath(value);
    if (context.projectName) return context;
  }

  return {};
}
