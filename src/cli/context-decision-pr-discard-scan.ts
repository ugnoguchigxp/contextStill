import { scanContextDecisionPrDiscards } from "../modules/context-decision/context-decision.pr-discard.service.js";

type ScanArgs = {
  apply: boolean;
  since?: string;
};

function parseArgs(argv: string[]): ScanArgs {
  const args: ScanArgs = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    if (arg === "--dry-run") args.apply = false;
    if (arg === "--since") args.since = argv[index + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await scanContextDecisionPrDiscards(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
