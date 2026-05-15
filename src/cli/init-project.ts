import crypto from "node:crypto";
import path from "node:path";
import { closeDbPool } from "../db/index.js";
import { compileContextPack } from "../modules/context-compiler/context-compiler.service.js";
import { upsertKnowledgeFromSource } from "../modules/knowledge/knowledge.repository.js";
import { distillSources } from "../modules/sources/distillation.service.js";
import { importMarkdownDirectory } from "../modules/sources/markdown-importer.service.js";

type CliOptions = {
  wikiRoot: string;
  runImport: boolean;
  seedPreset: boolean;
  presetName: "typescript-react";
  runDistillSources: boolean;
  distillApply: boolean;
  distillLimit?: number;
  runSmokeCompile: boolean;
  smokeGoal: string;
  repoPath: string;
};

type PresetKnowledge = {
  id: string;
  type: "rule" | "procedure";
  title: string;
  body: string;
  confidence: number;
  importance: number;
};

type InitProjectSummary = {
  ok: boolean;
  options: {
    wikiRoot: string;
    runImport: boolean;
    seedPreset: boolean;
    presetName: string;
    runDistillSources: boolean;
    distillApply: boolean;
    distillLimit: number | null;
    runSmokeCompile: boolean;
    smokeGoal: string;
    repoPath: string;
  };
  steps: {
    import?: {
      rootPath: string;
      importedFiles: number;
      importedSources: number;
      importedKnowledge: number;
      skippedFiles: number;
      removedSources: number;
    };
    globalPreset?: {
      presetName: string;
      insertedOrUpdated: number;
      knowledgeIds: string[];
      scope: "global";
    };
    distillSources?: {
      ok: boolean;
      apply: boolean;
      processed: number;
      skipped: number;
      failed: number;
      knowledgeCount: number;
    };
    smokeCompile?: {
      ok: boolean;
      status: "ok" | "degraded" | "failed";
      runId: string;
      relevantKnowledgeCount: number;
      degradedReasons: string[];
      suggestedNext: string[];
    };
  };
  nextActions: string[];
};

const presetKnowledgeByName: Record<CliOptions["presetName"], PresetKnowledge[]> = {
  "typescript-react": [
    {
      id: "rule-verify-before-merge",
      type: "rule",
      title: "変更後は verify を完了させてから判断する",
      body: "TypeScript/Bun プロジェクトでは、変更後に `bun run verify` を実行し、typecheck, lint, format, unit, build が全て通ることを確認してから次の判断に進む。",
      confidence: 90,
      importance: 90,
    },
    {
      id: "rule-minimize-scope",
      type: "rule",
      title: "変更スコープは機能単位で最小化する",
      body: "修正時は関連しない領域へ影響を広げず、対象機能に必要な最小変更で完了させる。追加変更が必要なら別タスクとして分離し、回帰リスクを局所化する。",
      confidence: 85,
      importance: 85,
    },
    {
      id: "procedure-implement-loop",
      type: "procedure",
      title: "実装時の基本ループ",
      body: "1) 対象コードを読み、失敗条件と受け入れ条件を明確化する。 2) 変更を実装する。 3) 関連テストと verify を実行する。 4) 失敗時は原因を特定し、再実装して再検証する。",
      confidence: 85,
      importance: 80,
    },
    {
      id: "procedure-review-draft-knowledge",
      type: "procedure",
      title: "draft knowledge を active 化する手順",
      body: "distillation 後は draft knowledge を一覧確認し、根拠となる source/vibe memory を確認してから active に更新する。根拠が弱い項目は deprecated にして誤学習を防ぐ。",
      confidence: 88,
      importance: 82,
    },
  ],
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

function parsePositiveInteger(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    wikiRoot: path.resolve(process.cwd(), "wiki/pages"),
    runImport: true,
    seedPreset: true,
    presetName: "typescript-react",
    runDistillSources: false,
    distillApply: false,
    runSmokeCompile: true,
    smokeGoal: "このリポジトリの初回セットアップ手順と検証手順を確認したい",
    repoPath: path.resolve(process.cwd()),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--wiki-root" || arg.startsWith("--wiki-root=")) {
      const value = readArgValue(args, index, "--wiki-root");
      if (arg === "--wiki-root") index += 1;
      options.wikiRoot = path.resolve(value);
    } else if (arg === "--skip-import") {
      options.runImport = false;
    } else if (arg === "--no-preset") {
      options.seedPreset = false;
    } else if (arg === "--preset" || arg.startsWith("--preset=")) {
      const value = readArgValue(args, index, "--preset").trim();
      if (arg === "--preset") index += 1;
      if (value !== "typescript-react") {
        throw new Error("--preset currently supports only: typescript-react");
      }
      options.presetName = value;
    } else if (arg === "--distill-sources") {
      options.runDistillSources = true;
      options.distillApply = false;
    } else if (arg === "--distill-sources-apply") {
      options.runDistillSources = true;
      options.distillApply = true;
    } else if (arg === "--distill-limit" || arg.startsWith("--distill-limit=")) {
      const value = readArgValue(args, index, "--distill-limit");
      if (arg === "--distill-limit") index += 1;
      options.distillLimit = parsePositiveInteger(value, "--distill-limit");
    } else if (arg === "--skip-smoke") {
      options.runSmokeCompile = false;
    } else if (arg === "--smoke-goal" || arg.startsWith("--smoke-goal=")) {
      const value = readArgValue(args, index, "--smoke-goal").trim();
      if (arg === "--smoke-goal") index += 1;
      if (!value) throw new Error("--smoke-goal must not be empty");
      options.smokeGoal = value;
    } else if (arg === "--repo-path" || arg.startsWith("--repo-path=")) {
      const value = readArgValue(args, index, "--repo-path").trim();
      if (arg === "--repo-path") index += 1;
      if (!value) throw new Error("--repo-path must not be empty");
      options.repoPath = path.resolve(value);
    } else if (arg === "--json") {
      // JSON is the only output format.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function seedGlobalPreset(presetName: CliOptions["presetName"]): Promise<{
  presetName: string;
  insertedOrUpdated: number;
  knowledgeIds: string[];
  scope: "global";
}> {
  const entries = presetKnowledgeByName[presetName];
  const knowledgeIds: string[] = [];

  for (const entry of entries) {
    const sourceUri = `preset://memory-router/${presetName}/${entry.id}`;
    const contentHash = sha256(`${entry.title}\n${entry.body}`);
    const knowledgeId = await upsertKnowledgeFromSource({
      sourceUri,
      contentHash,
      type: entry.type,
      status: "active",
      scope: "global",
      title: entry.title,
      body: entry.body,
      confidence: entry.confidence,
      importance: entry.importance,
      metadata: {
        sourceKind: "preset",
        presetName,
        presetVersion: "2026-05-15",
        language: "ja",
      },
    });
    knowledgeIds.push(knowledgeId);
  }

  return {
    presetName,
    insertedOrUpdated: knowledgeIds.length,
    knowledgeIds,
    scope: "global",
  };
}

async function runSmokeCompile(
  options: CliOptions,
): Promise<InitProjectSummary["steps"]["smokeCompile"]> {
  if (!options.runSmokeCompile) return undefined;

  const { pack } = await compileContextPack({
    goal: options.smokeGoal,
    intent: "plan",
    repoPath: options.repoPath,
    includeDraft: true,
  });

  const relevantKnowledgeCount = pack.rules.length + pack.procedures.length;
  const degradedReasons = [...pack.diagnostics.degradedReasons];
  const suggestedNext =
    relevantKnowledgeCount > 0
      ? []
      : [
          "bun run import:sources -- <wiki root>",
          "bun run distill:sources -- --apply",
          "Admin UI で draft knowledge を review して active に更新",
        ];

  return {
    ok: relevantKnowledgeCount > 0,
    status: pack.status,
    runId: pack.runId,
    relevantKnowledgeCount,
    degradedReasons,
    suggestedNext,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary: InitProjectSummary = {
    ok: true,
    options: {
      wikiRoot: options.wikiRoot,
      runImport: options.runImport,
      seedPreset: options.seedPreset,
      presetName: options.presetName,
      runDistillSources: options.runDistillSources,
      distillApply: options.distillApply,
      distillLimit: options.distillLimit ?? null,
      runSmokeCompile: options.runSmokeCompile,
      smokeGoal: options.smokeGoal,
      repoPath: options.repoPath,
    },
    steps: {},
    nextActions: [],
  };

  if (options.runImport) {
    const importResult = await importMarkdownDirectory(options.wikiRoot).catch((error) => {
      throw new Error(
        `[init-project/import] ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    summary.steps.import = {
      rootPath: options.wikiRoot,
      importedFiles: importResult.importedFiles,
      importedSources: importResult.importedSources,
      importedKnowledge: importResult.importedKnowledge,
      skippedFiles: importResult.skippedFiles,
      removedSources: importResult.removedSources,
    };
  }

  if (options.seedPreset) {
    summary.steps.globalPreset = await seedGlobalPreset(options.presetName).catch((error) => {
      throw new Error(
        `[init-project/seed-preset] ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  if (options.runDistillSources) {
    const distillSummary = await distillSources({
      apply: options.distillApply,
      limit: options.distillLimit,
      sourceKind: "wiki",
      includeProcessed: false,
    }).catch((error) => {
      throw new Error(
        `[init-project/distill-sources] ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    summary.steps.distillSources = {
      ok: distillSummary.ok,
      apply: distillSummary.apply,
      processed: distillSummary.processed,
      skipped: distillSummary.skipped,
      failed: distillSummary.failed,
      knowledgeCount: distillSummary.knowledgeCount,
    };

    if (!distillSummary.ok) {
      summary.ok = false;
    }
  }

  summary.steps.smokeCompile = await runSmokeCompile(options);
  if (summary.steps.smokeCompile && !summary.steps.smokeCompile.ok) {
    summary.ok = false;
  }

  if (!options.runSmokeCompile) {
    summary.nextActions = [
      '必要なら bun run compile --goal "<your task>" --intent edit --json で smoke を実行する',
      "Admin UI で新規 draft knowledge を review し、必要なものだけ active に昇格する",
    ];
  } else if (summary.steps.smokeCompile?.ok) {
    summary.nextActions = [
      "Admin UI で新規 draft knowledge を review し、必要なものだけ active に昇格する",
      "通常運用では import:sources と distill:sources を定期実行する",
    ];
  } else {
    summary.nextActions = [
      "bun run import:sources -- <wiki root>",
      "bun run distill:sources -- --apply",
      "Admin UI で draft knowledge の根拠を確認して active/deprecated を整理する",
      'bun run compile --goal "<your task>" --intent edit --json',
    ];
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
