import path from "node:path";
import { closeDbPool } from "../db/index.js";
import { importMarkdownDirectory } from "../modules/sources/markdown-importer.service.js";

async function main(): Promise<void> {
  const argPath = process.argv[2] || process.cwd();
  const rootPath = path.resolve(argPath);
  const result = await importMarkdownDirectory(rootPath);

  console.log(
    JSON.stringify(
      {
        rootPath,
        importedFiles: result.importedFiles,
        importedFragments: result.importedFragments,
        importedKnowledge: result.importedKnowledge,
        skippedFiles: result.skippedFiles,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error("[import-markdown] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
