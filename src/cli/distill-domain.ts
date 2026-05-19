import { closeDbPool } from "../db/index.js";
import { runDistillationDomainSmoke } from "../modules/distillation-domain-smoke.service.js";
import type { DistillationDomainName } from "../modules/distillation-domain.types.js";

type CliOptions = {
  domain: DistillationDomainName;
  input: Record<string, unknown>;
};

const allowedDomains: DistillationDomainName[] = [
  "findCandidate",
  "coverEvidence",
  "finalizeDistille",
];

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function parseInputJson(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--input-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseArgs(args: string[]): CliOptions {
  let domain: DistillationDomainName | undefined;
  let input: Record<string, unknown> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--domain" || arg.startsWith("--domain=")) {
      const value = readArgValue(args, index, "--domain").trim();
      if (arg === "--domain") index += 1;
      if (!allowedDomains.includes(value as DistillationDomainName)) {
        throw new Error(`--domain must be one of: ${allowedDomains.join(", ")}`);
      }
      domain = value as DistillationDomainName;
    } else if (arg === "--input-json" || arg.startsWith("--input-json=")) {
      const value = readArgValue(args, index, "--input-json").trim();
      if (arg === "--input-json") index += 1;
      input = parseInputJson(value);
    } else if (arg === "--json") {
      // JSON is the only output format.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!domain) {
    throw new Error(`--domain is required (${allowedDomains.join(", ")})`);
  }

  return { domain, input };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runDistillationDomainSmoke({
    domain: options.domain,
    input: options.input,
  });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
