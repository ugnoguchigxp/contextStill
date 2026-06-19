import { createHash } from "node:crypto";
import type { SqliteCoreDatabase } from "./client.js";

export type SqliteKnowledgeItemInput = {
  id: string;
  type: string;
  status: string;
  scope?: string;
  polarity?: string;
  intentTags?: unknown[];
  title: string;
  body: string;
  appliesTo?: unknown;
  confidence?: number;
  importance?: number;
  metadata?: unknown;
  embedding?: number[] | null;
  createdAt?: string;
  updatedAt?: string;
};

export type SqliteSourceInput = {
  id: string;
  sourceKind: string;
  uri: string;
  title?: string | null;
  body: string;
  metadata?: unknown;
  createdAt?: string;
  updatedAt?: string;
  lastIndexedAt?: string | null;
};

export type SqliteSourceFragmentInput = {
  id: string;
  sourceId: string;
  locator: string;
  heading?: string | null;
  content: string;
  metadata?: unknown;
  embedding?: number[] | null;
  createdAt?: string;
};

export type SqliteKnowledgeVectorHit = {
  id: string;
  title: string;
  body: string;
  score: number;
};

export type SqliteSourceVectorHit = {
  id: string;
  sourceId: string;
  sourceUri: string;
  locator: string;
  heading: string | null;
  content: string;
  score: number;
};

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function jsonArray(value: unknown[] | undefined): string {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function nowIso(): string {
  return new Date().toISOString();
}

function contentHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

function normalizeVector(vector: number[] | null | undefined): number[] | null {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const values = vector.map((entry) => Number(entry));
  return values.every(Number.isFinite) ? values : null;
}

function vectorJson(vector: number[]): string {
  return JSON.stringify(vector);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm <= 0 || rightNorm <= 0) return 0;
  const score = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

export class SqliteCoreRepository {
  constructor(private readonly database: SqliteCoreDatabase) {}

  upsertKnowledgeItem(input: SqliteKnowledgeItemInput): void {
    const updatedAt = input.updatedAt ?? nowIso();
    this.database.db
      .query(`
INSERT INTO knowledge_items (
  id, type, status, scope, polarity, intent_tags, title, body, applies_to,
  confidence, importance, metadata, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  type = excluded.type,
  status = excluded.status,
  scope = excluded.scope,
  polarity = excluded.polarity,
  intent_tags = excluded.intent_tags,
  title = excluded.title,
  body = excluded.body,
  applies_to = excluded.applies_to,
  confidence = excluded.confidence,
  importance = excluded.importance,
  metadata = excluded.metadata,
  updated_at = excluded.updated_at;
`)
      .run(
        input.id,
        input.type,
        input.status,
        input.scope ?? "repo",
        input.polarity ?? "positive",
        jsonArray(input.intentTags),
        input.title,
        input.body,
        json(input.appliesTo),
        input.confidence ?? 70,
        input.importance ?? 70,
        json(input.metadata),
        input.createdAt ?? updatedAt,
        updatedAt,
      );

    this.refreshKnowledgeItemFts(input.id);

    const vector = normalizeVector(input.embedding);
    if (vector) this.upsertKnowledgeVector(input.id, vector, contentHash(input.title, input.body));
  }

  upsertSource(input: SqliteSourceInput): void {
    const updatedAt = input.updatedAt ?? nowIso();
    this.database.db
      .query(`
INSERT INTO sources (
  id, source_kind, uri, title, body, metadata, created_at, updated_at, last_indexed_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  source_kind = excluded.source_kind,
  uri = excluded.uri,
  title = excluded.title,
  body = excluded.body,
  metadata = excluded.metadata,
  updated_at = excluded.updated_at,
  last_indexed_at = excluded.last_indexed_at;
`)
      .run(
        input.id,
        input.sourceKind,
        input.uri,
        input.title ?? null,
        input.body,
        json(input.metadata),
        input.createdAt ?? updatedAt,
        updatedAt,
        input.lastIndexedAt ?? null,
      );
    this.refreshSourceFts(input.id);
  }

  upsertSourceFragment(input: SqliteSourceFragmentInput): void {
    const createdAt = input.createdAt ?? nowIso();
    this.database.db
      .query(`
INSERT INTO source_fragments (id, source_id, locator, heading, content, metadata, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  source_id = excluded.source_id,
  locator = excluded.locator,
  heading = excluded.heading,
  content = excluded.content,
  metadata = excluded.metadata;
`)
      .run(
        input.id,
        input.sourceId,
        input.locator,
        input.heading ?? null,
        input.content,
        json(input.metadata),
        createdAt,
      );
    this.refreshSourceFragmentFts(input.id);

    const vector = normalizeVector(input.embedding);
    if (vector) this.upsertSourceFragmentVector(input.id, vector, contentHash(input.content));
  }

  rebuildKnowledgeVectors(
    rows: Array<{ id: string; title: string; body: string; embedding: number[] | null }>,
  ): number {
    let count = 0;
    let dimension = 0;
    const tx = this.database.db.query("BEGIN IMMEDIATE;");
    tx.run();
    try {
      this.database.db.query("DELETE FROM knowledge_items_vec_fallback;").run();
      if (this.database.vector.available) {
        this.database.db.query("DELETE FROM knowledge_items_vec;").run();
        this.database.db.query("DELETE FROM knowledge_items_vec_map;").run();
      }
      for (const row of rows) {
        const vector = normalizeVector(row.embedding);
        if (!vector) continue;
        dimension ||= vector.length;
        this.upsertKnowledgeVector(row.id, vector, contentHash(row.title, row.body));
        count += 1;
      }
      this.updateVectorMetadata("knowledge_items", count, dimension);
      this.database.db.query("COMMIT;").run();
      return count;
    } catch (error) {
      this.database.db.query("ROLLBACK;").run();
      throw error;
    }
  }

  rebuildSourceFragmentVectors(
    rows: Array<{ id: string; content: string; embedding: number[] | null }>,
  ): number {
    let count = 0;
    let dimension = 0;
    this.database.db.query("BEGIN IMMEDIATE;").run();
    try {
      this.database.db.query("DELETE FROM source_fragments_vec_fallback;").run();
      if (this.database.vector.available) {
        this.database.db.query("DELETE FROM source_fragments_vec;").run();
        this.database.db.query("DELETE FROM source_fragments_vec_map;").run();
      }
      for (const row of rows) {
        const vector = normalizeVector(row.embedding);
        if (!vector) continue;
        dimension ||= vector.length;
        this.upsertSourceFragmentVector(row.id, vector, contentHash(row.content));
        count += 1;
      }
      this.updateVectorMetadata("source_fragments", count, dimension);
      this.database.db.query("COMMIT;").run();
      return count;
    } catch (error) {
      this.database.db.query("ROLLBACK;").run();
      throw error;
    }
  }

  vectorSearchKnowledge(embedding: number[], limit: number): SqliteKnowledgeVectorHit[] {
    const queryVector = normalizeVector(embedding);
    if (!queryVector) return [];
    if (this.database.vector.available) {
      const hits = this.vectorSearchKnowledgeWithSqliteVec(queryVector, limit);
      if (hits.length > 0) return hits;
    }
    const rows = this.database.db
      .query<{
        knowledge_id: string;
        embedding_json: string;
        title: string;
        body: string;
      }>(`
SELECT v.knowledge_id, v.embedding_json, k.title, k.body
FROM knowledge_items_vec_fallback v
JOIN knowledge_items k ON k.id = v.knowledge_id
WHERE k.status = 'active';
`)
      .all();

    return rows
      .map((row) => ({
        id: row.knowledge_id,
        title: row.title,
        body: row.body,
        score: cosineSimilarity(JSON.parse(row.embedding_json) as number[], queryVector),
      }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.trunc(limit)));
  }

  vectorSearchSourceFragments(embedding: number[], limit: number): SqliteSourceVectorHit[] {
    const queryVector = normalizeVector(embedding);
    if (!queryVector) return [];
    if (this.database.vector.available) {
      const hits = this.vectorSearchSourceFragmentsWithSqliteVec(queryVector, limit);
      if (hits.length > 0) return hits;
    }
    const rows = this.database.db
      .query<{
        source_fragment_id: string;
        embedding_json: string;
        source_id: string;
        source_uri: string;
        locator: string;
        heading: string | null;
        content: string;
      }>(`
SELECT
  v.source_fragment_id,
  v.embedding_json,
  f.source_id,
  s.uri AS source_uri,
  f.locator,
  f.heading,
  f.content
FROM source_fragments_vec_fallback v
JOIN source_fragments f ON f.id = v.source_fragment_id
JOIN sources s ON s.id = f.source_id;
`)
      .all();

    return rows
      .map((row) => ({
        id: row.source_fragment_id,
        sourceId: row.source_id,
        sourceUri: row.source_uri,
        locator: row.locator,
        heading: row.heading,
        content: row.content,
        score: cosineSimilarity(JSON.parse(row.embedding_json) as number[], queryVector),
      }))
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.trunc(limit)));
  }

  close(): void {
    this.database.db.close();
  }

  private upsertKnowledgeVector(knowledgeId: string, embedding: number[], hash: string): void {
    this.database.db
      .query(`
INSERT INTO knowledge_items_vec_fallback (
  knowledge_id, embedding_json, embedding_dimension, content_hash, updated_at
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(knowledge_id) DO UPDATE SET
  embedding_json = excluded.embedding_json,
  embedding_dimension = excluded.embedding_dimension,
  content_hash = excluded.content_hash,
  updated_at = excluded.updated_at;
`)
      .run(knowledgeId, JSON.stringify(embedding), embedding.length, hash, nowIso());
    if (this.database.vector.available) {
      this.upsertKnowledgeVectorIndex(knowledgeId, embedding);
    }
  }

  private upsertSourceFragmentVector(
    sourceFragmentId: string,
    embedding: number[],
    hash: string,
  ): void {
    this.database.db
      .query(`
INSERT INTO source_fragments_vec_fallback (
  source_fragment_id, embedding_json, embedding_dimension, content_hash, updated_at
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(source_fragment_id) DO UPDATE SET
  embedding_json = excluded.embedding_json,
  embedding_dimension = excluded.embedding_dimension,
  content_hash = excluded.content_hash,
  updated_at = excluded.updated_at;
`)
      .run(sourceFragmentId, JSON.stringify(embedding), embedding.length, hash, nowIso());
    if (this.database.vector.available) {
      this.upsertSourceFragmentVectorIndex(sourceFragmentId, embedding);
    }
  }

  private upsertKnowledgeVectorIndex(knowledgeId: string, embedding: number[]): void {
    this.database.db
      .query(
        "INSERT INTO knowledge_items_vec_map(knowledge_id) VALUES (?) ON CONFLICT(knowledge_id) DO NOTHING;",
      )
      .run(knowledgeId);
    const row = this.database.db
      .query<{ vec_rowid: number }, [string]>(
        "SELECT vec_rowid FROM knowledge_items_vec_map WHERE knowledge_id = ?;",
      )
      .get(knowledgeId);
    if (!row) return;
    this.database.db.query("DELETE FROM knowledge_items_vec WHERE rowid = ?;").run(row.vec_rowid);
    this.database.db
      .query("INSERT INTO knowledge_items_vec(rowid, embedding) VALUES (?, ?);")
      .run(row.vec_rowid, vectorJson(embedding));
  }

  private upsertSourceFragmentVectorIndex(sourceFragmentId: string, embedding: number[]): void {
    this.database.db
      .query(
        "INSERT INTO source_fragments_vec_map(source_fragment_id) VALUES (?) ON CONFLICT(source_fragment_id) DO NOTHING;",
      )
      .run(sourceFragmentId);
    const row = this.database.db
      .query<{ vec_rowid: number }, [string]>(
        "SELECT vec_rowid FROM source_fragments_vec_map WHERE source_fragment_id = ?;",
      )
      .get(sourceFragmentId);
    if (!row) return;
    this.database.db.query("DELETE FROM source_fragments_vec WHERE rowid = ?;").run(row.vec_rowid);
    this.database.db
      .query("INSERT INTO source_fragments_vec(rowid, embedding) VALUES (?, ?);")
      .run(row.vec_rowid, vectorJson(embedding));
  }

  private vectorSearchKnowledgeWithSqliteVec(
    embedding: number[],
    limit: number,
  ): SqliteKnowledgeVectorHit[] {
    try {
      const rows = this.database.db
        .query<
          {
            id: string;
            title: string;
            body: string;
            distance: number;
          },
          [string, number]
        >(`
SELECT ki.id, ki.title, ki.body, v.distance
FROM knowledge_items_vec v
JOIN knowledge_items_vec_map m ON m.vec_rowid = v.rowid
JOIN knowledge_items ki ON ki.id = m.knowledge_id
WHERE v.embedding MATCH ?
  AND v.k = ?
  AND ki.status = 'active'
ORDER BY v.distance;
`)
        .all(vectorJson(embedding), Math.max(1, Math.trunc(limit)));
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        score: 1 / (1 + row.distance),
      }));
    } catch {
      return [];
    }
  }

  private vectorSearchSourceFragmentsWithSqliteVec(
    embedding: number[],
    limit: number,
  ): SqliteSourceVectorHit[] {
    try {
      const rows = this.database.db
        .query<
          {
            id: string;
            source_id: string;
            source_uri: string;
            locator: string;
            heading: string | null;
            content: string;
            distance: number;
          },
          [string, number]
        >(`
SELECT
  f.id,
  f.source_id,
  s.uri AS source_uri,
  f.locator,
  f.heading,
  f.content,
  v.distance
FROM source_fragments_vec v
JOIN source_fragments_vec_map m ON m.vec_rowid = v.rowid
JOIN source_fragments f ON f.id = m.source_fragment_id
JOIN sources s ON s.id = f.source_id
WHERE v.embedding MATCH ?
  AND v.k = ?
ORDER BY v.distance;
`)
        .all(vectorJson(embedding), Math.max(1, Math.trunc(limit)));
      return rows.map((row) => ({
        id: row.id,
        sourceId: row.source_id,
        sourceUri: row.source_uri,
        locator: row.locator,
        heading: row.heading,
        content: row.content,
        score: 1 / (1 + row.distance),
      }));
    } catch {
      return [];
    }
  }

  private refreshKnowledgeItemFts(id: string): void {
    this.database.db.query("DELETE FROM knowledge_items_fts WHERE id = ?;").run(id);
    this.database.db
      .query(
        "INSERT INTO knowledge_items_fts(id, title, body) SELECT id, title, body FROM knowledge_items WHERE id = ?;",
      )
      .run(id);
  }

  private refreshSourceFts(id: string): void {
    this.database.db.query("DELETE FROM sources_fts WHERE id = ?;").run(id);
    this.database.db
      .query(
        "INSERT INTO sources_fts(id, title, uri, body) SELECT id, title, uri, body FROM sources WHERE id = ?;",
      )
      .run(id);
  }

  private refreshSourceFragmentFts(id: string): void {
    this.database.db.query("DELETE FROM source_fragments_fts WHERE id = ?;").run(id);
    this.database.db
      .query(
        "INSERT INTO source_fragments_fts(id, heading, content) SELECT id, heading, content FROM source_fragments WHERE id = ?;",
      )
      .run(id);
  }

  private updateVectorMetadata(name: string, rowCount: number, dimension: number): void {
    this.database.db
      .query(`
INSERT INTO core_vector_metadata (name, dimension, rebuilt_at, row_count, uses_sqlite_vec)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(name) DO UPDATE SET
  dimension = excluded.dimension,
  rebuilt_at = excluded.rebuilt_at,
  row_count = excluded.row_count,
  uses_sqlite_vec = excluded.uses_sqlite_vec;
`)
      .run(name, dimension, nowIso(), rowCount, this.database.vector.available ? 1 : 0);
  }
}
