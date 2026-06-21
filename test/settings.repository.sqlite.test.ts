import { beforeEach, describe, expect, test, vi } from "vitest";
import { getRuntimeSqliteCoreDatabase } from "../src/db/sqlite/runtime.js";
import {
  findSettingsRowSqlite,
  listSettingsRowsSqlite,
  upsertSettingsRowSqlite,
  deleteSettingsRowSqlite,
} from "../src/modules/settings/settings.repository.sqlite.js";

vi.mock("../src/db/sqlite/runtime.js", () => {
  const mockDb = {
    query: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
  };
  return {
    getRuntimeSqliteCoreDatabase: vi.fn(() =>
      Promise.resolve({
        db: mockDb,
        path: "/dummy/sqlite.db",
      }),
    ),
  };
});

describe("settings.repository.sqlite", () => {
  let mockDb: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDb = (await getRuntimeSqliteCoreDatabase()).db;
  });

  const dummySettingsRow = {
    id: "uuid-1",
    namespace: "test-ns",
    key: "test-key",
    value: '{"a":1}',
    value_kind: "json",
    secret_ref: null,
    is_secret: 0,
    description: "test description",
    schema_version: 1,
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-20T00:00:00.000Z",
    updated_by: "test-user",
  };

  test("findSettingsRowSqlite returns mapped setting row or null", async () => {
    mockDb.query.mockImplementation(() => ({
      get: vi.fn().mockReturnValue(dummySettingsRow),
    }) as any);

    const result = await findSettingsRowSqlite("test-ns", "test-key");
    expect(result).not.toBeNull();
    expect(result?.namespace).toBe("test-ns");
    expect(result?.value).toEqual({ a: 1 });
    expect(result?.isSecret).toBe(false);

    mockDb.query.mockImplementation(() => ({
      get: vi.fn().mockReturnValue(null),
    }) as any);

    const nullResult = await findSettingsRowSqlite("test-ns", "test-key");
    expect(nullResult).toBeNull();
  });

  test("listSettingsRowsSqlite returns all settings or scoped settings", async () => {
    mockDb.query.mockImplementation(() => ({
      all: vi.fn().mockReturnValue([dummySettingsRow]),
    }) as any);

    // with namespace
    const results = await listSettingsRowsSqlite("test-ns");
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("test-key");

    // without namespace
    const allResults = await listSettingsRowsSqlite();
    expect(allResults).toHaveLength(1);
  });

  test("upsertSettingsRowSqlite inserts/updates row", async () => {
    mockDb.query.mockImplementation(() => ({
      run: vi.fn().mockReturnValue({ changes: 1 }),
      get: vi.fn().mockReturnValue(dummySettingsRow),
    }) as any);

    const result = await upsertSettingsRowSqlite({
      namespace: "test-ns",
      key: "test-key",
      value: { a: 1 },
      valueKind: "json",
      secretRef: null,
      isSecret: false,
      description: "test description",
      schemaVersion: 1,
      updatedBy: "test-user",
    });

    expect(result.namespace).toBe("test-ns");
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO settings"));
  });

  test("upsertSettingsRowSqlite throws error if select after upsert returns null", async () => {
    mockDb.query.mockImplementation(() => ({
      run: vi.fn(),
      get: vi.fn().mockReturnValue(null), // select returns null
    }) as any);

    await expect(
      upsertSettingsRowSqlite({
        namespace: "test-ns",
        key: "test-key",
        value: { a: 1 },
        schemaVersion: 1,
      }),
    ).rejects.toThrow("failed to upsert setting");
  });

  test("deleteSettingsRowSqlite deletes row", async () => {
    mockDb.query.mockImplementation(() => ({
      run: vi.fn(),
    }) as any);

    await deleteSettingsRowSqlite("test-ns", "test-key");
    expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM settings"));
  });
});
