import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type SetupCheck,
  detectDockerComposeRunner,
  runSetupChecks,
} from "../../cli/onboarding/checks.js";
import { type SetupCommandResult, runSetupCommand } from "../../cli/onboarding/command-runner.js";
import { ensureEnvFile, parseEnvValues } from "../../cli/onboarding/env-file.js";
import { buildMcpConfigSnippet } from "../../cli/onboarding/mcp-config.js";
import { type SupportedLocale, resolveLocale } from "../../shared/locales/locale.js";

export type SetupOptions = {
  dryRun: boolean;
  json: boolean;
  startDb: boolean;
  noMigrate: boolean;
  skipInit: boolean;
  wikiRoot: string;
  lang: SupportedLocale;
  langExplicit: boolean;
};

export type SetupSummary = {
  ok: boolean;
  mode: "dry-run" | "apply";
  lang: SupportedLocale;
  env: {
    path: string;
    created: boolean;
    appendedKeys: string[];
  };
  checks: SetupCheck[];
  commands: SetupCommandResult[];
  mcpConfigSnippet: string;
  nextActions: string[];
};

export type SetupLocaleText = {
  envCheckOk: string;
  envCheckCreated: string;
  envCheckMissing: string;
  nextRunApply: string;
  nextRunDoctor: string;
  nextRunMcpRegister: string;
  nextRunStartDb: string;
  nextFixDatabaseUrl: string;
  nextFixMigrate: string;
};

export const setupLocaleText: Record<SupportedLocale, SetupLocaleText> = {
  ja: {
    envCheckOk: ".env を確認済み",
    envCheckCreated: ".env を .env.example から作成した",
    envCheckMissing: ".env の確認に失敗した",
    nextRunApply: "dry-run の内容を確認後、bun run setup で実行する",
    nextRunDoctor: "bun run doctor でシステム健全性を確認する",
    nextRunMcpRegister: "必要なら bun run mcp:register -- --client <client> --dry-run を実行する",
    nextRunStartDb: "DB が未起動なら bun run setup -- --start-db を実行する",
    nextFixDatabaseUrl: ".env の DATABASE_URL を設定して再実行する",
    nextFixMigrate: "db:migrate が失敗しているため、DB 接続と migration エラーを修正して再実行する",
  },
  en: {
    envCheckOk: "Validated .env",
    envCheckCreated: "Created .env from .env.example",
    envCheckMissing: "Failed to validate .env",
    nextRunApply: "After reviewing dry-run, execute bun run setup",
    nextRunDoctor: "Run bun run doctor to verify system health",
    nextRunMcpRegister: "If needed, run bun run mcp:register -- --client <client> --dry-run",
    nextRunStartDb: "If DB is not running, execute bun run setup -- --start-db",
    nextFixDatabaseUrl: "Set DATABASE_URL in .env and run setup again",
    nextFixMigrate: "db:migrate failed. Fix DB connectivity/migration errors and retry",
  },
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function parseExplicitLocale(value: string): SupportedLocale {
  const normalized = value.trim().toLowerCase();
  if (normalized === "en") return "en";
  if (normalized === "ja") return "ja";
  throw new Error("--lang currently supports only: en, ja");
}

export function parseSetupArgs(args: string[], env: NodeJS.ProcessEnv = process.env): SetupOptions {
  const options: SetupOptions = {
    dryRun: false,
    json: false,
    startDb: false,
    noMigrate: false,
    skipInit: false,
    wikiRoot: path.resolve(process.cwd(), "wiki/pages"),
    lang: resolveLocale(env.MEMORY_ROUTER_LANG),
    langExplicit: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--start-db") {
      options.startDb = true;
    } else if (arg === "--no-migrate") {
      options.noMigrate = true;
    } else if (arg === "--skip-init") {
      options.skipInit = true;
    } else if (arg === "--wiki-root" || arg.startsWith("--wiki-root=")) {
      const value = readArgValue(args, index, "--wiki-root");
      if (arg === "--wiki-root") index += 1;
      options.wikiRoot = path.resolve(value);
    } else if (arg === "--lang" || arg.startsWith("--lang=")) {
      const value = readArgValue(args, index, "--lang");
      if (arg === "--lang") index += 1;
      options.lang = parseExplicitLocale(value);
      options.langExplicit = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export async function buildSetupSummary(options: SetupOptions): Promise<SetupSummary> {
  const cwd = path.resolve(process.cwd());
  const envPath = path.resolve(cwd, ".env");
  const envExamplePath = path.resolve(cwd, ".env.example");
  const localeText = setupLocaleText[options.lang];

  const envResult = await ensureEnvFile({
    envPath,
    envExamplePath,
    preferredLocale: options.langExplicit ? options.lang : undefined,
  });
  const envContent = await readFile(envPath, "utf8");
  const envValues = parseEnvValues(envContent);
  const commandEnv = { ...process.env, ...envValues };

  const checks = await runSetupChecks({
    cwd,
    env: commandEnv,
    envValues,
    requireDockerCompose: options.startDb,
  });
  const dockerComposeRunner = await detectDockerComposeRunner(cwd, commandEnv);
  checks.unshift({
    name: "env-file",
    ok: true,
    message: envResult.created ? localeText.envCheckCreated : localeText.envCheckOk,
  });

  const commands: SetupCommandResult[] = [];

  commands.push(
    await runSetupCommand({
      command: dockerComposeRunner?.command ?? "docker",
      args: [...(dockerComposeRunner?.argsPrefix ?? ["compose"]), "ps"],
      cwd,
      env: commandEnv,
      dryRun: options.dryRun,
      skipReason: dockerComposeRunner ? undefined : "docker compose is not available",
    }),
  );

  commands.push(
    await runSetupCommand({
      command: dockerComposeRunner?.command ?? "docker",
      args: [...(dockerComposeRunner?.argsPrefix ?? ["compose"]), "up", "-d"],
      cwd,
      env: commandEnv,
      dryRun: options.dryRun,
      skipReason: options.startDb
        ? dockerComposeRunner
          ? undefined
          : "docker compose is not available"
        : "--start-db is not set",
    }),
  );

  const migrateResult = await runSetupCommand({
    command: "bun",
    args: ["run", "db:migrate"],
    cwd,
    env: commandEnv,
    dryRun: options.dryRun,
    skipReason: options.noMigrate ? "--no-migrate is set" : undefined,
  });
  commands.push(migrateResult);

  const shouldSkipInit =
    options.skipInit ||
    (!options.dryRun && migrateResult.status === "failed") ||
    (!options.dryRun && migrateResult.status === "skipped" && !options.noMigrate);
  commands.push(
    await runSetupCommand({
      command: "bun",
      args: [
        "run",
        "init:project",
        "--",
        "--json",
        "--wiki-root",
        options.wikiRoot,
        "--lang",
        options.lang,
      ],
      cwd,
      env: commandEnv,
      dryRun: options.dryRun,
      skipReason: shouldSkipInit
        ? options.skipInit
          ? "--skip-init is set"
          : "db:migrate failed"
        : undefined,
    }),
  );

  const okChecks = checks.every((item) => item.ok);
  const failedCommands = commands.some((item) => item.status === "failed");
  const ok = okChecks && !failedCommands;

  const nextActions: string[] = [];
  if (options.dryRun) nextActions.push(localeText.nextRunApply);
  if (!envValues.DATABASE_URL?.trim()) nextActions.push(localeText.nextFixDatabaseUrl);
  if (!options.startDb) nextActions.push(localeText.nextRunStartDb);
  if (migrateResult.status === "failed") nextActions.push(localeText.nextFixMigrate);
  nextActions.push(localeText.nextRunDoctor);
  nextActions.push(localeText.nextRunMcpRegister);

  return {
    ok,
    mode: options.dryRun ? "dry-run" : "apply",
    lang: options.lang,
    env: envResult,
    checks,
    commands,
    mcpConfigSnippet: buildMcpConfigSnippet(cwd),
    nextActions,
  };
}
