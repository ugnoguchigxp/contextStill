import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
// @ts-expect-error Node script exercised directly as a compiler boundary contract.
import { inspectBoundary } from "../scripts/testing/import-boundary.mjs";
test("resolves alias, exports and dynamic imports, and excludes type-only cycles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boundary-test-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "api"));
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { noLib: true, types: [], baseUrl: ".", paths: { "@api/*": ["api/*"] } },
        include: ["src/**/*.ts", "api/**/*.ts"],
      }),
    );
    await writeFile(
      path.join(root, "src/a.ts"),
      'import type { B } from "./b"; export { value } from "@api/c"; export const load=()=>import("@api/c"); export type A=string;',
    );
    await writeFile(path.join(root, "src/b.ts"), 'import type { A } from "./a"; export type B=A;');
    await writeFile(path.join(root, "api/c.ts"), "export const value=1;");
    let result = inspectBoundary(root);
    expect(result.violations).toHaveLength(2);
    expect(result.cycles).toHaveLength(0);
    await writeFile(
      path.join(root, "api/c.ts"),
      'import { load } from "../src/a"; export const value=load;',
    );
    result = inspectBoundary(root);
    expect(result.cycles.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
