import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  getDefaultDbSession,
  withDbSession,
  withDbTransaction,
  withWriteSession,
} from "../src/db/session.js";
import { db } from "../src/db/index.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    transaction: vi.fn(),
  },
}));

describe("db session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns the default read session", () => {
    const session = getDefaultDbSession();
    expect(session.mode).toBe("read");
    expect(session.db).toBe(db);
    expect(session.backend).toBe("postgres");
  });

  test("withDbSession passes a read session", async () => {
    const result = await withDbSession(async (session) => {
      expect(session.mode).toBe("read");
      expect(session.db).toBe(db);
      return "ok";
    });

    expect(result).toBe("ok");
  });

  test("withWriteSession passes a write session", async () => {
    const result = await withWriteSession(async (session) => {
      expect(session.mode).toBe("write");
      expect(session.db).toBe(db);
      return "ok";
    });

    expect(result).toBe("ok");
  });

  test("withDbTransaction passes the transaction client as a write session", async () => {
    const txClient = { select: vi.fn() };
    vi.mocked(db.transaction).mockImplementation(async (callback: any) => callback(txClient));

    const result = await withDbTransaction(async (session) => {
      expect(session.mode).toBe("write");
      expect(session.db).toBe(txClient);
      return "tx-ok";
    });

    expect(result).toBe("tx-ok");
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
