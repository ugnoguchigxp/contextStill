import { desc, eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { codeSymbols } from "../../../src/db/schema.js";
import { embedOne } from "../../../src/modules/embedding/embedding.service.js";

export type CodeSymbolWriteInput = {
  repoPath: string;
  filePath: string;
  symbolName: string;
  symbolKind: string;
  signature?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  active: boolean;
  metadata?: Record<string, unknown>;
};

export async function listCodeSymbols(limit: number) {
  return db
    .select({
      id: codeSymbols.id,
      repoPath: codeSymbols.repoPath,
      filePath: codeSymbols.filePath,
      symbolName: codeSymbols.symbolName,
      symbolKind: codeSymbols.symbolKind,
      signature: codeSymbols.signature,
      startLine: codeSymbols.startLine,
      endLine: codeSymbols.endLine,
      active: codeSymbols.active,
      metadata: codeSymbols.metadata,
      updatedAt: codeSymbols.updatedAt,
    })
    .from(codeSymbols)
    .orderBy(desc(codeSymbols.updatedAt))
    .limit(limit);
}

async function tryEmbedSymbol(input: CodeSymbolWriteInput): Promise<number[] | undefined> {
  try {
    return await embedOne(
      `${input.repoPath}\n${input.filePath}\n${input.symbolKind} ${input.symbolName}\n${input.signature ?? ""}`,
      "passage",
    );
  } catch {
    return undefined;
  }
}

export async function createCodeSymbol(input: CodeSymbolWriteInput) {
  const embedding = await tryEmbedSymbol(input);
  const [inserted] = await db
    .insert(codeSymbols)
    .values({
      repoPath: input.repoPath,
      filePath: input.filePath,
      symbolName: input.symbolName,
      symbolKind: input.symbolKind,
      signature: input.signature ?? null,
      startLine: input.startLine ?? null,
      endLine: input.endLine ?? null,
      active: input.active,
      metadata: input.metadata ?? {},
      embedding,
    })
    .returning({ id: codeSymbols.id });
  return inserted;
}

export async function updateCodeSymbol(id: string, input: CodeSymbolWriteInput) {
  const embedding = await tryEmbedSymbol(input);
  const [updated] = await db
    .update(codeSymbols)
    .set({
      repoPath: input.repoPath,
      filePath: input.filePath,
      symbolName: input.symbolName,
      symbolKind: input.symbolKind,
      signature: input.signature ?? null,
      startLine: input.startLine ?? null,
      endLine: input.endLine ?? null,
      active: input.active,
      metadata: input.metadata ?? {},
      embedding,
      updatedAt: new Date(),
    })
    .where(eq(codeSymbols.id, id))
    .returning({ id: codeSymbols.id });
  return updated ?? null;
}

export async function deleteCodeSymbol(id: string) {
  const [deleted] = await db
    .delete(codeSymbols)
    .where(eq(codeSymbols.id, id))
    .returning({ id: codeSymbols.id });
  return deleted ?? null;
}
