import { describe, expect, test } from "vitest";
import {
  toPostgresLiteral,
  writePostgresInsert,
} from "../src/modules/knowledge-portability/sql-writer.js";
import {
  buildPostgresInsertOnlyStatements,
  parsePostgresDataSql,
} from "../src/modules/knowledge-portability/sql-reader.js";

describe("portable SQL writer", () => {
  test("escapes text and emits jsonb casts", () => {
    expect(toPostgresLiteral("can't", "text")).toBe("'can''t'");
    expect(toPostgresLiteral({ token: "secret" }, "jsonb")).toBe(`'{"token":"secret"}'::jsonb`);
  });

  test("omits empty inserts and writes deterministic column order", () => {
    expect(
      writePostgresInsert(
        {
          name: "knowledge_items",
          columns: [
            { name: "id", kind: "text" },
            { name: "metadata", kind: "jsonb" },
          ],
        },
        [],
      ),
    ).toBe("");

    expect(
      writePostgresInsert(
        {
          name: "knowledge_items",
          columns: [
            { name: "id", kind: "text" },
            { name: "metadata", kind: "jsonb" },
          ],
        },
        [{ id: "k1", metadata: { a: 1 } }],
      ),
    ).toContain(
      `INSERT INTO "knowledge_items" ("id", "metadata") VALUES\n('k1', '{"a":1}'::jsonb)`,
    );
  });

  test("builds insert-only statements from export SQL", () => {
    const statements = buildPostgresInsertOnlyStatements(
      [
        "-- context-still portable export",
        "BEGIN;",
        `INSERT INTO "knowledge_items" ("id") VALUES`,
        "('k1')",
        "ON CONFLICT DO NOTHING;",
        "COMMIT;",
        "",
      ].join("\n"),
    );

    expect(statements).toEqual([`INSERT INTO "knowledge_items" ("id") VALUES ('k1');`]);
  });

  test("rejects extra SQL inside values blocks", () => {
    expect(() =>
      parsePostgresDataSql(
        [
          `INSERT INTO "knowledge_items" ("id") VALUES`,
          "('k1'); drop table knowledge_items",
          "ON CONFLICT DO NOTHING;",
        ].join("\n"),
      ),
    ).toThrow("Unexpected token in SQL VALUES block");
  });
});
