import { expect, test } from "vitest";
// @ts-expect-error Node policy module exercised without a runtime shim.
import * as policy from "../scripts/testing/coverage-policy.mjs";
const { checkCoverage, lcovLines, summarizeLines, changedLines, summarizeChangedLines } = policy;
test("coverage rejects missing, empty and below-baseline reports and merges repeated line hits", () => {
  const files = lcovLines(
    "SF:src/a.ts\nDA:1,0\nDA:2,1\nend_of_record\nSF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n",
  );
  const report = summarizeLines(files);
  expect(report.src).toEqual({ covered: 2, total: 2, percent: 100 });
  expect(checkCoverage({ vitest: report }, { vitest: { src: 99 } })).toEqual([]);
  expect(checkCoverage({}, { vitest: { src: 1 } })).toHaveLength(1);
  expect(
    checkCoverage({ vitest: { src: { total: 0, percent: 100 } } }, { vitest: { src: 1 } }),
  ).toHaveLength(1);
  expect(
    checkCoverage({ vitest: { src: { total: 100, percent: 49 } } }, { vitest: { src: 50 } }),
  ).toHaveLength(1);
});

test("changed-line coverage counts additions and replacements, never deleted lines", () => {
  const changes = changedLines(
    "+++ b/src/a.ts\n@@ -2,3 +2,2 @@\n+x\n+y\n@@ -8 +7,0 @@\n-z\n+++ /dev/null\n@@ -1 +0,0 @@",
  );
  const files = lcovLines("SF:src/a.ts\nDA:1,1\nDA:2,0\nDA:3,1\nDA:8,1\n");
  expect(summarizeChangedLines(files, changes).src).toEqual({ covered: 1, total: 2, percent: 50 });
});
