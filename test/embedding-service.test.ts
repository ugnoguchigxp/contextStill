import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import { embedOne, embeddingHealth } from "../src/modules/embedding/embedding.service.js";

// Mock config
vi.mock("../src/config.js", () => ({
  groupedConfig: {
    embedding: {
      dimension: 384,
      provider: "auto",
      daemonUrl: "http://localhost:44512",
      accessToken: "test-token",
      timeoutMs: 1000,
    },
    localLlm: {
      embeddingPython: "/bin/python",
      embeddingRoot: "/root",
      embeddingModelDir: "/models",
    },
  },
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = Object.assign(mockFetch, { preconnect: vi.fn() }) as unknown as typeof fetch;

// Mock child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
}));

describe("embedding service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupedConfig.embedding.provider = "auto";
  });

  describe("embedOne", () => {
    test("calls daemon provider if available and provider is auto", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          embeddings: [new Array(384).fill(0.1)],
          dimension: 384,
        }),
      });

      const result = await embedOne("test text", "query");

      expect(result).toHaveLength(384);
      expect(result[0]).toBe(0.1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/embed"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
    });

    test("falls back to cli provider if daemon fails and provider is auto", async () => {
      mockFetch.mockRejectedValue(new Error("Connection refused"));

      const mockExecFile = execFile as unknown as any;
      mockExecFile.mockImplementation(
        (
          file: string,
          args: string[],
          options: { timeout?: number; maxBuffer?: number },
          callback: (error: Error | null, result: { stdout: string }) => void,
        ) => {
          void file;
          void args;
          void options;
          callback(null, {
            stdout: JSON.stringify([{ embedding: new Array(384).fill(0.2), dimension: 384 }]),
          });
          return undefined;
        },
      );

      const result = await embedOne("test text", "query");

      expect(result).toHaveLength(384);
      expect(result[0]).toBe(0.2);
      expect(mockExecFile).toHaveBeenCalled();
    });

    test("throws error if provider is disabled", async () => {
      groupedConfig.embedding.provider = "disabled";
      await expect(embedOne("test", "query")).rejects.toThrow("embedding provider is disabled");
    });

    test("throws error if response shape is invalid", async () => {
      groupedConfig.embedding.provider = "daemon";
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          embeddings: "not an array",
        }),
      });

      await expect(embedOne("test", "query")).rejects.toThrow(
        "daemon embedding response did not include an array",
      );
    });
  });

  describe("embeddingHealth", () => {
    test("returns reachable true if daemon health check succeeds", async () => {
      mockFetch.mockResolvedValue({ ok: true });
      (access as any).mockResolvedValue(undefined);

      const health = await embeddingHealth();

      expect(health.configured).toBe(true);
      expect(health.daemon.reachable).toBe(true);
      expect(health.cli.usable).toBe(true);
    });

    test("returns reachable false and error if daemon health check fails", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      (access as any).mockRejectedValue(new Error("File not found"));

      const health = await embeddingHealth();

      expect(health.daemon.reachable).toBe(false);
      expect(health.daemon.error).toBe("HTTP 500");
      expect(health.cli.usable).toBe(false);
      expect(health.cli.error).toBe("File not found");
    });
  });
});
