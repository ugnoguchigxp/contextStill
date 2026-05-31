export const projectIdentity = {
  displayName: "contextStill",
  packageName: "context-still",
  legacyPackageName: "memory-router",
  typePrefix: "ContextStill",
  legacyTypePrefix: "MemoryRouter",
  envPrefix: "CONTEXT_STILL",
  legacyEnvPrefix: "MEMORY_ROUTER",
  mcpUriScheme: "context-still",
  legacyMcpUriScheme: "memory-router",
  databaseName: "context_still",
  legacyDatabaseName: "memory_router",
  apiServiceName: "context-still-api",
  adminRealm: "context-still-admin",
} as const;

export function projectEnvKey(key: string): string {
  return `${projectIdentity.envPrefix}_${key}`;
}

export function legacyProjectEnvKey(key: string): string {
  return `${projectIdentity.legacyEnvPrefix}_${key}`;
}

export function readProjectEnv(key: string): string | undefined {
  return process.env[projectEnvKey(key)] ?? process.env[legacyProjectEnvKey(key)];
}

export function readProjectEnvFrom(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return env[projectEnvKey(key)] ?? env[legacyProjectEnvKey(key)];
}

export function readProjectEnvWithFallback(
  key: string,
  fallbackKeys: readonly string[] = [],
): string | undefined {
  return (
    readProjectEnv(key) ?? fallbackKeys.map((fallbackKey) => process.env[fallbackKey]).find(Boolean)
  );
}

export function normalizeMcpResourceUri(uri: string): string {
  const legacyPrefix = `${projectIdentity.legacyMcpUriScheme}://`;
  if (uri.startsWith(legacyPrefix)) {
    return `${projectIdentity.mcpUriScheme}://${uri.slice(legacyPrefix.length)}`;
  }
  return uri;
}

export function mcpResourceUri(path: string): string {
  return `${projectIdentity.mcpUriScheme}://${path.replace(/^\/+/, "")}`;
}
