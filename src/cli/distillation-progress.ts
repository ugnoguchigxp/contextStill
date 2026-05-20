import { config as loadEnv } from "dotenv";
import pg from "pg";
import { APP_CONSTANTS } from "../constants.js";

type CliOptions = {
  version: string;
};

loadEnv({ quiet: true });

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    version: APP_CONSTANTS.distillationTargetVersion,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--version" || arg.startsWith("--version=")) {
      options.version = readArgValue(args, index, "--version").trim();
      if (arg === "--version") index += 1;
      if (!options.version) {
        throw new Error("--version must not be empty");
      }
    } else if (arg === "--json") {
      // JSON is the only output format.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function normalizeDatabaseUrlForCli(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
      return parsed.toString();
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

function isRetryableConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("ECONNREFUSED") ||
    message.includes("ETIMEDOUT") ||
    message.includes("EAI_AGAIN")
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type ProgressCountsRow = {
  candidate_count: number;
  knowledge_count: number;
  failed_count: number;
  skipped_count: number;
};

async function collectProgressCounts(
  databaseUrl: string,
  version: string,
): Promise<ProgressCountsRow> {
  const client = new pg.Client({
    connectionString: databaseUrl,
  });
  try {
    await client.connect();
    const result = await client.query<ProgressCountsRow>(
      `
      select
        (
          select count(*)::int
          from find_candidate_results f
          inner join distillation_target_states t on t.id = f.target_state_id
          where t.distillation_version = $1
            and f.status = 'selected'
        ) as candidate_count,
        (
          select coalesce(sum(jsonb_array_length(t.knowledge_ids)), 0)::int
          from distillation_target_states t
          where t.distillation_version = $1
            and t.status = 'completed'
        ) as knowledge_count,
        (select count(*)::int from distillation_target_states where distillation_version = $1 and status = 'failed') as failed_count,
        (select count(*)::int from distillation_target_states where distillation_version = $1 and status = 'skipped') as skipped_count
      `,
      [version],
    );
    return (
      result.rows[0] ?? {
        candidate_count: 0,
        knowledge_count: 0,
        failed_count: 0,
        skipped_count: 0,
      }
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = normalizeDatabaseUrlForCli(
    process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:7889/memory_router",
  );
  let row: ProgressCountsRow | undefined;
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      row = await collectProgressCounts(databaseUrl, options.version);
      break;
    } catch (error) {
      if (!isRetryableConnectionError(error) || attempt >= maxAttempts) {
        throw error;
      }
      await sleep(250 * attempt);
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        version: options.version,
        candidateCount: Number(row?.candidate_count ?? 0),
        knowledgeCount: Number(row?.knowledge_count ?? 0),
        failedCount: Number(row?.failed_count ?? 0),
        skippedCount: Number(row?.skipped_count ?? 0),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  if (error instanceof Error && error.message.trim().length > 0) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
