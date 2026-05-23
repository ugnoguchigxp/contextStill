import { closeDbPool } from "../db/index.js";
import { runDoctor } from "../modules/doctor/doctor.service.js";

type CliOptions = {
  strict: boolean;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { strict: false };
  for (const arg of args) {
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--json") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runDoctor({ strict: options.strict });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "failed") {
    process.exitCode = 1;
  }
}

main().finally(async () => {
  await closeDbPool();
});
