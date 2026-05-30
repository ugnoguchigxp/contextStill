import { parseSetupArgs, buildSetupSummary } from "../modules/onboarding/setup.service.js";

async function main(): Promise<void> {
  const options = parseSetupArgs(process.argv.slice(2));
  const summary = await buildSetupSummary(options);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
