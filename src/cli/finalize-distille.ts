import { closeDbPool } from "../db/index.js";
import { runFinalizeDistille } from "../modules/finalizeDistille/domain.js";

type CliOptions = {
  id: string;
  write: boolean;
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
  let write = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--id" || arg.startsWith("--id=")) {
      id = readArgValue(args, index, "--id").trim();
      if (arg === "--id") index += 1;
    } else if (arg === "--write") {
      write = true;
    } else if (arg === "--text") {
      write = false;
    } else if (arg === "--json") {
      // JSON is the only output format.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!id) {
    throw new Error("--id is required");
  }

  return { id, write };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runFinalizeDistille({
    coverEvidenceResultId: options.id,
    write: options.write,
  });

  if (result.status === "rejected") {
    process.exitCode = 1;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
