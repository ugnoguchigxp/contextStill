import { compileContextPack } from "../../../src/modules/context-compiler/context-compiler.service.js";
import {
  getCompileRunDetail,
  listRecentCompileRuns,
  type CompileRunSummary,
} from "../../../src/modules/context-compiler/context-compiler.repository.js";
import type { CompileInput } from "../../../src/shared/schemas/compile.schema.js";
import type { CompileRunDetail } from "../../../src/shared/schemas/compile-run.schema.js";
import type { ContextPack } from "../../../src/shared/schemas/context-pack.schema.js";

export async function compilePack(input: CompileInput): Promise<{
  pack: ContextPack;
  markdown: string;
}> {
  return compileContextPack(input, { source: "ui" });
}

export async function listRuns(limit: number): Promise<CompileRunSummary[]> {
  return listRecentCompileRuns(limit);
}

export async function getRunDetail(runId: string): Promise<CompileRunDetail | null> {
  return getCompileRunDetail(runId);
}
