import { type ReadFileDomainResult, readFileDomain } from "../modules/readFile/domain.js";

const targetPath = "best-practice/hono_backend.md";

function toFlatJson(result: ReadFileDomainResult): ReadFileDomainResult {
  return {
    content: result.content,
    totalTokens: result.totalTokens,
    from: result.from,
    toExclusive: result.toExclusive,
    returnedTokens: result.returnedTokens,
  };
}

async function main(): Promise<void> {
  const first = await readFileDomain({
    path: targetPath,
    minify: true,
  });
  process.stdout.write(`${JSON.stringify(toFlatJson(first), null, 2)}\n`);

  const second = await readFileDomain({
    path: targetPath,
    minify: false,
  });
  process.stdout.write(`${JSON.stringify(toFlatJson(second), null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
