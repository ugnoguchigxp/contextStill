import { compileContextPack } from "../../../src/modules/context-compiler/context-compiler.service.js";
import {
  listRecentCompileRuns,
  type CompileRunSummary,
} from "../../../src/modules/context-compiler/context-compiler.repository.js";
import type { CompileInput } from "../../../src/shared/schemas/compile.schema.js";
import type { ContextPack } from "../../../src/shared/schemas/context-pack.schema.js";

export async function compilePack(input: CompileInput): Promise<{
  pack: ContextPack;
  markdown: string;
}> {
  return compileContextPack(input);
}

export async function listRuns(limit: number): Promise<CompileRunSummary[]> {
  return listRecentCompileRuns(limit);
}
