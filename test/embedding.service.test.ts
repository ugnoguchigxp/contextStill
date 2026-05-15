import { describe, expect, test, vi, beforeEach } from "vitest";
import { embedOne, embeddingHealth } from "../src/modules/embedding/embedding.service.js";
import { config } from "../src/config.js";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
}));
vi.mock("../src/config.js", () => ({
  config: {
    embeddingProvider: "auto",
    embeddingDaemonUrl: "http://daemon",
    embeddingDimension: 3,
    embeddingTimeoutMs: 1000,
    embeddingAccessToken: "key",
    localLlmEmbeddingPython: "/usr/bin/python",
    localLlmEmbeddingRoot: "/root",
    localLlmEmbeddingModelDir: "/models",
  },
}));

describe("Embedding Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    config.embeddingProvider = "auto";
  });

  test("embedOne uses daemon if available", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          embeddings: [[0.1, 0.2, 0.3]],
          dimension: 3,
        }),
    } as any);

    const result = await embedOne("hello", "query");
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/embed"), expect.any(Object));
  });

  test("embedOne falls back to cli if daemon fails", async () => {
    // Daemon fails
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as any);

    // CLI succeeds
    vi.mocked(execFile).mockImplementation((cmd, args, opts, cb) => {
      if (cb) (cb as any)(null, JSON.stringify([{ embedding: [0.4, 0.5, 0.6], dimension: 3 }]), "");

      return {} as any;
    });

    const result = await embedOne("hello", "query");
    expect(result).toEqual([0.4, 0.5, 0.6]);
    expect(execFile).toHaveBeenCalled();
  });

  test("embedOne throws if input is empty", async () => {
    await expect(embedOne("  ", "query")).rejects.toThrow(
      "embedding input must include at least one non-empty text",
    );
  });

  test("validateEmbeddingShape throws on dimension mismatch", async () => {
    config.embeddingProvider = "daemon";
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          embeddings: [[0.1, 0.2]], // only 2 dims, expected 3
          dimension: 2,
        }),
    } as any);

    await expect(embedOne("hello", "query")).rejects.toThrow("dimension mismatch");
  });

  test("embeddingHealth checks both daemon and cli", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as any);
    vi.mocked(access).mockResolvedValue(undefined);

    const health = await embeddingHealth();
    expect(health.daemon.reachable).toBe(true);
    expect(health.cli.usable).toBe(true);
  });
});
