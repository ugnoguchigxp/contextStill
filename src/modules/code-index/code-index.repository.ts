import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { codeSymbols } from "../../db/schema.js";

export type CodeSymbolSeed = {
  repoPath: string;
  filePath: string;
  symbolName: string;
  symbolKind: string;
  signature?: string;
  startLine?: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
};

export type CodeSymbolSearchResult = {
  id: string;
  repoPath: string;
  filePath: string;
  symbolName: string;
  symbolKind: string;
  signature: string | null;
  startLine: number | null;
  endLine: number | null;
  score: number;
};

function finiteOrZero(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export async function upsertCodeSymbols(symbols: CodeSymbolSeed[]): Promise<number> {
  if (symbols.length === 0) return 0;
  let affected = 0;

  for (const symbol of symbols) {
    const existing = await db.query.codeSymbols.findFirst({
      where: and(
        eq(codeSymbols.repoPath, symbol.repoPath),
        eq(codeSymbols.filePath, symbol.filePath),
        eq(codeSymbols.symbolName, symbol.symbolName),
        eq(codeSymbols.symbolKind, symbol.symbolKind),
      ),
    });

    if (existing) {
      await db
        .update(codeSymbols)
        .set({
          signature: symbol.signature ?? existing.signature,
          startLine: symbol.startLine ?? existing.startLine,
          endLine: symbol.endLine ?? existing.endLine,
          metadata: symbol.metadata ?? existing.metadata,
          active: true,
          updatedAt: new Date(),
        })
        .where(eq(codeSymbols.id, existing.id));
      affected += 1;
      continue;
    }

    await db.insert(codeSymbols).values({
      repoPath: symbol.repoPath,
      filePath: symbol.filePath,
      symbolName: symbol.symbolName,
      symbolKind: symbol.symbolKind,
      signature: symbol.signature ?? null,
      startLine: symbol.startLine ?? null,
      endLine: symbol.endLine ?? null,
      metadata: symbol.metadata ?? {},
      active: true,
    });
    affected += 1;
  }

  return affected;
}

export async function searchCodeSymbols(params: {
  query: string;
  limit: number;
  repoPath?: string;
  files?: string[];
}): Promise<CodeSymbolSearchResult[]> {
  const conditions = [eq(codeSymbols.active, true)];
  if (params.repoPath) {
    conditions.push(eq(codeSymbols.repoPath, params.repoPath));
  }
  if (params.files && params.files.length > 0) {
    conditions.push(inArray(codeSymbols.filePath, params.files));
  }

  const query = params.query.trim();
  const scoreExpr = sql<number>`
    (case when ${codeSymbols.symbolName} ilike ${`%${query}%`} then 1 else 0 end)
    + (case when ${codeSymbols.filePath} ilike ${`%${query}%`} then 0.6 else 0 end)
    + (case when ${codeSymbols.symbolKind} ilike ${`%${query}%`} then 0.3 else 0 end)
  `;

  if (query.length > 0) {
    conditions.push(
      sql`(${codeSymbols.symbolName} ilike ${`%${query}%`}
      or ${codeSymbols.filePath} ilike ${`%${query}%`}
      or ${codeSymbols.symbolKind} ilike ${`%${query}%`})`,
    );
  }

  const rows = await db
    .select({
      id: codeSymbols.id,
      repoPath: codeSymbols.repoPath,
      filePath: codeSymbols.filePath,
      symbolName: codeSymbols.symbolName,
      symbolKind: codeSymbols.symbolKind,
      signature: codeSymbols.signature,
      startLine: codeSymbols.startLine,
      endLine: codeSymbols.endLine,
      score: scoreExpr,
    })
    .from(codeSymbols)
    .where(and(...conditions))
    .orderBy(desc(scoreExpr), desc(codeSymbols.updatedAt))
    .limit(params.limit);

  return rows.map((row) => ({
    ...row,
    score: finiteOrZero(row.score),
  }));
}
