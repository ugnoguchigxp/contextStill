import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectIdentity } from "../project-identity.js";

type JsonObject = Record<string, unknown>;

type Options = {
  dryRun: boolean;
  codexConfig: string;
  antigravityConfigs: string[];
  antigravityPermissionConfigs: string[];
  cwd: string;
  command: string;
  databaseUrl: string;
};

const defaultDatabaseUrl = `postgres://postgres:postgres@localhost:7889/${projectIdentity.databaseName}`;

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function readEnvFileValue(envPath: string, key: string): string | undefined {
  if (!fs.existsSync(envPath)) return undefined;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || match[1] !== key) continue;
    const value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

function findBunCommand(): string {
  const candidates = [
    process.env.BUN_PATH,
    process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, "bin", "bun") : undefined,
    path.join(os.homedir(), ".bun/bin/bun"),
    "bun",
  ].filter((item): item is string => Boolean(item));

  return candidates.find((candidate) => candidate === "bun" || fs.existsSync(candidate)) ?? "bun";
}

function defaultOptions(): Options {
  const cwd = process.cwd();
  return {
    dryRun: false,
    codexConfig: path.join(os.homedir(), ".codex/config.toml"),
    antigravityConfigs: [
      path.join(os.homedir(), ".gemini/config/mcp_config.json"),
      path.join(os.homedir(), ".gemini/antigravity/mcp_config.json"),
      path.join(os.homedir(), ".gemini/antigravity-ide/mcp_config.json"),
    ],
    antigravityPermissionConfigs: [path.join(os.homedir(), ".gemini/config/config.json")],
    cwd,
    command: findBunCommand(),
    databaseUrl:
      process.env.DATABASE_URL ??
      readEnvFileValue(path.join(cwd, ".env"), "DATABASE_URL") ??
      defaultDatabaseUrl,
  };
}

function parseArgs(argv: string[]): Options {
  const options = defaultOptions();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      return expandHome(value);
    };

    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--cwd") {
      options.cwd = path.resolve(next());
    } else if (arg === "--command") {
      options.command = next();
    } else if (arg === "--database-url") {
      options.databaseUrl = next();
    } else if (arg === "--codex-config") {
      options.codexConfig = next();
    } else if (arg === "--antigravity-config") {
      options.antigravityConfigs.push(next());
    } else if (arg === "--antigravity-permission-config") {
      options.antigravityPermissionConfigs.push(next());
    } else if (arg === "--no-default-antigravity-configs") {
      options.antigravityConfigs = [];
    } else if (arg === "--no-antigravity-permissions") {
      options.antigravityPermissionConfigs = [];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: bun run setup:mcp-config [options]

Updates Codex and Antigravity MCP configuration for ${projectIdentity.packageName}.

Options:
  --dry-run                              Print planned changes without writing files
  --cwd <path>                           Project cwd for the MCP server
  --command <path>                       Bun command path
  --database-url <url>                   DATABASE_URL passed to the MCP server
  --codex-config <path>                  Codex config.toml path
  --antigravity-config <path>            Additional Antigravity mcp_config.json path
  --antigravity-permission-config <path> Additional Antigravity config.json permission path
  --no-default-antigravity-configs       Do not update default Antigravity config paths
  --no-antigravity-permissions           Do not rewrite legacy Antigravity MCP permission grants`);
}

function backupFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  const backupPath = `${filePath}.bak-context-still-mcp-${stamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function writeFileWithBackup(filePath: string, content: string, dryRun: boolean): string | null {
  if (dryRun) return null;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const backupPath = backupFile(filePath);
  fs.writeFileSync(filePath, content);
  return backupPath;
}

function escapeTomlString(value: string): string {
  return JSON.stringify(value);
}

function removeTomlTable(source: string, tableName: string): string {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\n?\\[${escaped}\\][\\s\\S]*?(?=\\n\\[[^\\]]+\\]|$)`, "g");
  return source
    .replace(pattern, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

function upsertCodexConfig(content: string, options: Options): string {
  let next = content.trimEnd();
  next = removeTomlTable(next, `mcp_servers.${projectIdentity.packageName}`);
  next = removeTomlTable(next, `mcp_servers.${projectIdentity.packageName}.env`);

  const legacyEnabledPattern = new RegExp(
    `(\\[mcp_servers\\.${projectIdentity.legacyPackageName}\\][\\s\\S]*?\\nenabled\\s*=\\s*)true(?=\\n|$)`,
  );
  if (legacyEnabledPattern.test(next)) {
    next = next.replace(legacyEnabledPattern, "$1false");
  }

  const block = [
    "",
    `[mcp_servers.${projectIdentity.packageName}]`,
    `command = ${escapeTomlString(options.command)}`,
    'args = [ "run", "src/index.ts" ]',
    `cwd = ${escapeTomlString(options.cwd)}`,
    "enabled = true",
    "",
    `[mcp_servers.${projectIdentity.packageName}.env]`,
    `DATABASE_URL = ${escapeTomlString(options.databaseUrl)}`,
    "",
  ].join("\n");

  return `${next}${block}`;
}

function readJsonObject(filePath: string): JsonObject {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return parsed as JsonObject;
}

function upsertAntigravityMcpConfig(config: JsonObject, options: Options): JsonObject {
  const mcpServers =
    config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? ({ ...(config.mcpServers as JsonObject) } as JsonObject)
      : {};

  delete mcpServers[projectIdentity.legacyPackageName];
  mcpServers[projectIdentity.packageName] = {
    command: options.command,
    args: ["run", "src/index.ts"],
    cwd: options.cwd,
    env: {
      DATABASE_URL: options.databaseUrl,
    },
  };

  return {
    ...config,
    mcpServers,
  };
}

function rewriteLegacyMcpPermissionGrants(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const next = value.replaceAll(
      `mcp(${projectIdentity.legacyPackageName}/`,
      `mcp(${projectIdentity.packageName}/`,
    );
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = rewriteLegacyMcpPermissionGrants(item);
      changed ||= result.changed;
      return result.value;
    });
    return { value: next, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: JsonObject = {};
    for (const [key, item] of Object.entries(value as JsonObject)) {
      const result = rewriteLegacyMcpPermissionGrants(item);
      changed ||= result.changed;
      next[key] = result.value;
    }
    return { value: next, changed };
  }
  return { value, changed: false };
}

function updateCodex(options: Options): { path: string; backupPath: string | null } {
  const current = fs.existsSync(options.codexConfig)
    ? fs.readFileSync(options.codexConfig, "utf8")
    : "";
  const next = upsertCodexConfig(current, options);
  const backupPath =
    current === next ? null : writeFileWithBackup(options.codexConfig, next, options.dryRun);
  return { path: options.codexConfig, backupPath };
}

function updateAntigravityConfig(
  filePath: string,
  options: Options,
): { path: string; backupPath: string | null; skipped: boolean } {
  if (!fs.existsSync(filePath)) return { path: filePath, backupPath: null, skipped: true };
  const current = readJsonObject(filePath);
  const next = `${JSON.stringify(upsertAntigravityMcpConfig(current, options), null, 2)}\n`;
  const raw = fs.readFileSync(filePath, "utf8");
  const backupPath = raw === next ? null : writeFileWithBackup(filePath, next, options.dryRun);
  return { path: filePath, backupPath, skipped: false };
}

function updateAntigravityPermissionConfig(
  filePath: string,
  options: Options,
): { path: string; backupPath: string | null; skipped: boolean } {
  if (!fs.existsSync(filePath)) return { path: filePath, backupPath: null, skipped: true };
  const current = readJsonObject(filePath);
  const result = rewriteLegacyMcpPermissionGrants(current);
  if (!result.changed) return { path: filePath, backupPath: null, skipped: false };
  const next = `${JSON.stringify(result.value, null, 2)}\n`;
  const backupPath = writeFileWithBackup(filePath, next, options.dryRun);
  return { path: filePath, backupPath, skipped: false };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const codex = updateCodex(options);
  const antigravity = options.antigravityConfigs.map((configPath) =>
    updateAntigravityConfig(configPath, options),
  );
  const antigravityPermissions = options.antigravityPermissionConfigs.map((configPath) =>
    updateAntigravityPermissionConfig(configPath, options),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: options.dryRun,
        server: {
          name: projectIdentity.packageName,
          command: options.command,
          args: ["run", "src/index.ts"],
          cwd: options.cwd,
          databaseUrl: options.databaseUrl,
        },
        codex,
        antigravity,
        antigravityPermissions,
      },
      null,
      2,
    ),
  );
}

main();
