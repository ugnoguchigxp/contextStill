import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import {
  checkCoverage,
  lcovLines,
  summarizeLines,
  changedLines,
  summarizeChangedLines,
} from "./testing/coverage-policy.mjs";
async function read(path) {
  return readFile(path, "utf8");
}
const reportRoot = process.env.CONTEXT_STILL_COVERAGE_DIR ?? "artifacts/coverage";
const vitestFiles = lcovLines(await read(`${reportRoot}/vitest/lcov.info`));
const rustFiles = lcovLines(await read(`${reportRoot}/rust/lcov.info`));
const vitest = summarizeLines(vitestFiles);
const rust = summarizeLines(rustFiles);
const bunFiles = new Map();
const manifest = JSON.parse(await read("scripts/testing/sqlite-test-manifest.json"));
const expected = manifest.tests.map((name) =>
  name
    .split("/")
    .pop()
    .replace(/\.bun\.ts$/, ""),
);
const available = await readdir(`${reportRoot}/bun`);
if (expected.some((name) => !available.includes(name)))
  throw new Error("Bun coverage file missing from manifest");
for (const dir of expected) {
  for (const [name, lines] of lcovLines(await read(`${reportRoot}/bun/${dir}/lcov.info`))) {
    if (!bunFiles.has(name)) bunFiles.set(name, new Map());
    const target = bunFiles.get(name);
    for (const [line, count] of lines) target.set(line, Math.max(count, target.get(line) ?? 0));
  }
}
const actual = { vitest, bun: summarizeLines(bunFiles), rust };
await writeFile(`${reportRoot}/summary.json`, `${JSON.stringify(actual, null, 2)}\n`);
console.log(JSON.stringify(actual, null, 2));
const baseline = JSON.parse(await read("scripts/testing/coverage-baseline.json"));
const failures = checkCoverage(actual, baseline);
if (failures.length) throw new Error(failures.join("\n"));

const base = process.env.CONTEXT_STILL_COVERAGE_DIFF_BASE || "HEAD";
const diff = execFileSync(
  "git",
  ["diff", "--no-ext-diff", "--unified=0", base, "--", "src", "api", "web", "crates"],
  { encoding: "utf8" },
);
const changes = changedLines(diff);
// Local working-tree measurements also include new implementation files.
for (const file of execFileSync(
  "git",
  ["ls-files", "--others", "--exclude-standard", "--", "src", "api", "web", "crates"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean)) {
  if (!/\.(ts|tsx|rs)$/.test(file)) continue;
  changes.set(file, new Set((await read(file)).split("\n").map((_, index) => index + 1)));
}
const changed = {
  base,
  mode: "report-only",
  note: "Executable changed lines per runtime; no cross-runtime averaging or unmeasured-line success inference",
  vitest: summarizeChangedLines(vitestFiles, changes),
  bun: summarizeChangedLines(bunFiles, changes),
  rust: summarizeChangedLines(rustFiles, changes),
};
await writeFile(`${reportRoot}/changed-lines.json`, `${JSON.stringify(changed, null, 2)}\n`);
