import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { groupedConfig } from "../src/config.js";
import { embedOne, embeddingHealth } from "../src/modules/embedding/embedding.service.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
}));

const originalEmbeddingConfig = {
  provider: groupedConfig.embedding.provider,
  daemonUrl: groupedConfig.embedding.daemonUrl,
  accessToken: groupedConfig.embedding.accessToken,
  timeoutMs: groupedConfig.embedding.timeoutMs,
  dimension: groupedConfig.embedding.dimension,
};

const originalLocalLlmEmbeddingConfig = {
  embeddingPython: groupedConfig.localLlm.embeddingPython,
  embeddingRoot: groupedConfig.localLlm.embeddingRoot,
  embeddingModelDir: groupedConfig.localLlm.embeddingModelDir,
};

describe("Embedding Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());

    groupedConfig.embedding.provider = "auto";
    groupedConfig.embedding.daemonUrl = "http://daemon";
    groupedConfig.embedding.accessToken = "key";
    groupedConfig.embedding.timeoutMs = 1000;
    groupedConfig.embedding.dimension = 3;

    groupedConfig.localLlm.embeddingPython = "/usr/bin/python";
    groupedConfig.localLlm.embeddingRoot = "/root";
    groupedConfig.localLlm.embeddingModelDir = "/models";
  });

  afterEach(() => {
    groupedConfig.embedding.provider = originalEmbeddingConfig.provider;
    groupedConfig.embedding.daemonUrl = originalEmbeddingConfig.daemonUrl;
    groupedConfig.embedding.accessToken = originalEmbeddingConfig.accessToken;
    groupedConfig.embedding.timeoutMs = originalEmbeddingConfig.timeoutMs;
    groupedConfig.embedding.dimension = originalEmbeddingConfig.dimension;

    groupedConfig.localLlm.embeddingPython = originalLocalLlmEmbeddingConfig.embeddingPython;
    groupedConfig.localLlm.embeddingRoot = originalLocalLlmEmbeddingConfig.embeddingRoot;
    groupedConfig.localLlm.embeddingModelDir = originalLocalLlmEmbeddingConfig.embeddingModelDir;

    vi.unstubAllGlobals();
  });

  test("embedOne uses daemon if available", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          embeddings: [[0.1, 0.2, 0.3]],
          dimension: 3,
        }),
    } as never);

    const result = await embedOne("hello", "query");
    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/embed"), expect.any(Object));
  });

  test("embedOne falls back to cli if daemon fails", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as never);

    vi.mocked(execFile).mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs.at(-1);
      if (typeof cb === "function") {
        cb(null, {
          stdout: JSON.stringify([{ embedding: [0.4, 0.5, 0.6], dimension: 3 }]),
          stderr: "",
        });
      }
      return {} as never;
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

  test("embedOne throws when provider is disabled", async () => {
    groupedConfig.embedding.provider = "disabled";
    await expect(embedOne("hello", "query")).rejects.toThrow("embedding provider is disabled");
  });

  test("validateEmbeddingShape throws on dimension mismatch", async () => {
    groupedConfig.embedding.provider = "daemon";
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          embeddings: [[0.1, 0.2]],
          dimension: 2,
        }),
    } as never);

    await expect(embedOne("hello", "query")).rejects.toThrow("dimension mismatch");
  });

  test("embeddingHealth checks both daemon and cli", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as never);
    vi.mocked(access).mockResolvedValue(undefined as never);

    const health = await embeddingHealth();
    expect(health.daemon.reachable).toBe(true);
    expect(health.cli.usable).toBe(true);
  });

  test("embedOne includes daemon/cli failures when auto fallback exhausts", async () => {
    groupedConfig.embedding.provider = "auto";
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as never);
    vi.mocked(execFile).mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs.at(-1);
      if (typeof cb === "function") {
        cb(new Error("CLI unavailable"));
      }
      return {} as never;
    });

    await expect(embedOne("hello", "query")).rejects.toThrow(/daemon: HTTP 503; cli:/);
  });
});
