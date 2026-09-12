import { readFile } from "node:fs/promises";
import { inspectBoundary } from "./testing/import-boundary.mjs";
const report = inspectBoundary(process.cwd());
const baseline = JSON.parse(
  await readFile(new URL("./testing/import-cycle-baseline.json", import.meta.url), "utf8"),
);
const allowed = new Set(baseline.exceptions.map((e) => e.edge));
const invalid = baseline.exceptions.filter((e) => !e.reason || !e.owner || !e.resolution);
const newCycles = report.cycles.filter((edge) => !allowed.has(edge));
if (report.violations.length || newCycles.length || invalid.length) {
  console.error(JSON.stringify({ violations: report.violations, newCycles, invalid }, null, 2));
  process.exit(1);
}
console.log(
  JSON.stringify({
    edges: report.edges.length,
    reverseDependencies: 0,
    existingCycleEdges: report.cycles.length,
  }),
);
