import { closeDbPool } from "../db/index.js";
import { runCoverEvidence, type CoverEvidenceRunInput } from "../modules/coverEvidence/domain.js";

type CliOptions = {
  id: string;
  provider?: CoverEvidenceRunInput["provider"];
  write: boolean;
  forceRefreshEvidence: boolean;
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

function parseArgs(args: string[]): CliOptions {
  let id = "";
  let provider: CoverEvidenceRunInput["provider"];
  let write = false;
  let forceRefreshEvidence = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--id" || arg.startsWith("--id=")) {
      id = readArgValue(args, index, "--id").trim();
      if (arg === "--id") index += 1;
    } else if (arg === "--provider" || arg.startsWith("--provider=")) {
      const value = readArgValue(args, index, "--provider").trim();
      if (arg === "--provider") index += 1;
      if (
        value !== "local-llm" &&
        value !== "azure-openai" &&
        value !== "bedrock" &&
        value !== "auto"
      ) {
        throw new Error("--provider must be local-llm, azure-openai, bedrock, or auto");
      }
      provider = value;
    } else if (arg === "--write") {
      write = true;
    } else if (arg === "--text" || arg === "--json") {
      write = false;
    } else if (arg === "--force-refresh-evidence") {
      forceRefreshEvidence = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!id) {
    throw new Error("--id is required");
  }

  return {
    id,
    provider,
    write,
    forceRefreshEvidence,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runCoverEvidence({
    id: options.id,
    provider: options.provider,
    write: options.write,
    forceRefreshEvidence: options.forceRefreshEvidence,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        id: result.id,
        ...result.result,
      },
      null,
      2,
    )}\n`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
