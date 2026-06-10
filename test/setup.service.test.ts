import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildSetupSummary, parseSetupArgs } from "../src/modules/onboarding/setup.service.js";

// fs/promises モック
const mockReadFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...args: any[]) => mockReadFile(...args),
}));

// cli checks モック
const mockDetectDockerComposeRunner = vi.fn();
const mockRunSetupChecks = vi.fn();
vi.mock("../src/cli/onboarding/checks.js", () => ({
  detectDockerComposeRunner: (...args: any[]) => mockDetectDockerComposeRunner(...args),
  runSetupChecks: (...args: any[]) => mockRunSetupChecks(...args),
}));

// cli command runner モック
const mockRunSetupCommand = vi.fn();
vi.mock("../src/cli/onboarding/command-runner.js", () => ({
  runSetupCommand: (...args: any[]) => mockRunSetupCommand(...args),
}));

// cli env-file モック
const mockEnsureEnvFile = vi.fn();
const mockParseEnvValues = vi.fn();
vi.mock("../src/cli/onboarding/env-file.js", () => ({
  ensureEnvFile: (...args: any[]) => mockEnsureEnvFile(...args),
  parseEnvValues: (...args: any[]) => mockParseEnvValues(...args),
}));

// cli mcp-config モック
const mockBuildMcpConfigSnippet = vi.fn();
vi.mock("../src/cli/onboarding/mcp-config.js", () => ({
  buildMcpConfigSnippet: (...args: any[]) => mockBuildMcpConfigSnippet(...args),
}));

describe("setup.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseSetupArgs", () => {
    test("parses basic boolean flags correctly", () => {
      const options = parseSetupArgs([
        "--dry-run",
        "--json",
        "--start-db",
        "--no-migrate",
        "--skip-init",
      ]);
      expect(options.dryRun).toBe(true);
      expect(options.json).toBe(true);
      expect(options.startDb).toBe(true);
      expect(options.noMigrate).toBe(true);
      expect(options.skipInit).toBe(true);
    });

    test("parses --wiki-root and --lang flags correctly", () => {
      const options1 = parseSetupArgs(["--wiki-root", "/my/wiki", "--lang", "en"]);
      expect(options1.wikiRoot).toBe("/my/wiki");
      expect(options1.lang).toBe("en");
      expect(options1.langExplicit).toBe(true);

      const options2 = parseSetupArgs(["--wiki-root=/my/wiki2", "--lang=ja"]);
      expect(options2.wikiRoot).toBe("/my/wiki2");
      expect(options2.lang).toBe("ja");
      expect(options2.langExplicit).toBe(true);
    });

    test("throws error on unknown argument", () => {
      expect(() => parseSetupArgs(["--unknown-flag"])).toThrow("Unknown argument");
    });

    test("throws error if flag requires a value but none provided", () => {
      expect(() => parseSetupArgs(["--wiki-root"])).toThrow("--wiki-root requires a value");
      expect(() => parseSetupArgs(["--lang", "--dry-run"])).toThrow("--lang requires a value");
    });

    test("throws error on unsupported locale in --lang", () => {
      expect(() => parseSetupArgs(["--lang", "fr"])).toThrow(
        "--lang currently supports only: en, ja",
      );
    });
  });

  describe("buildSetupSummary", () => {
    const defaultOptions = {
      dryRun: true,
      json: false,
      startDb: true,
      noMigrate: false,
      skipInit: false,
      wikiRoot: "/mock/wiki",
      lang: "ja" as const,
      langExplicit: true,
    };

    beforeEach(() => {
      mockEnsureEnvFile.mockResolvedValue({
        path: "/mock/.env",
        created: false,
        appendedKeys: [],
      });
      mockReadFile.mockResolvedValue("DATABASE_URL=postgres://user:pass@localhost:5432/db");
      mockParseEnvValues.mockReturnValue({
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
      });
      mockRunSetupChecks.mockResolvedValue([{ name: "db-conn", ok: true, message: "DB OK" }]);
      mockDetectDockerComposeRunner.mockResolvedValue({
        command: "docker",
        argsPrefix: ["compose"],
      });
      mockRunSetupCommand.mockResolvedValue({
        command: "mock",
        args: [],
        status: "success",
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
      mockBuildMcpConfigSnippet.mockReturnValue("mcp snippet");
    });

    test("returns successful dry-run setup summary", async () => {
      const summary = await buildSetupSummary(defaultOptions);

      expect(summary.ok).toBe(true);
      expect(summary.mode).toBe("dry-run");
      expect(summary.lang).toBe("ja");
      expect(summary.env.created).toBe(false);
      expect(summary.checks[0].message).toBe(".env を確認済み"); // env-file message ja
      expect(summary.mcpConfigSnippet).toBe("mcp snippet");
      expect(summary.nextActions).toContain("dry-run の内容を確認後、bun run setup で実行する");
    });

    test("returns dry-run setup summary when .env was created", async () => {
      mockEnsureEnvFile.mockResolvedValue({
        path: "/mock/.env",
        created: true,
        appendedKeys: [],
      });

      const summary = await buildSetupSummary(defaultOptions);
      expect(summary.checks[0].message).toBe(".env を .env.example から作成した");
    });

    test("marks ok=false if any check fails or command fails", async () => {
      mockRunSetupChecks.mockResolvedValue([
        { name: "db-conn", ok: false, message: "DB Connection Failed" },
      ]);

      const summary = await buildSetupSummary({ ...defaultOptions, dryRun: false });
      expect(summary.ok).toBe(false);
      expect(summary.mode).toBe("apply");
    });

    test("marks ok=false if db:migrate command fails", async () => {
      mockRunSetupCommand.mockImplementation(async (params) => {
        if (params.command === "bun" && params.args.includes("db:migrate")) {
          return {
            command: "bun",
            args: ["run", "db:migrate"],
            status: "failed",
            exitCode: 1,
            stdout: "",
            stderr: "migration error",
          };
        }
        return {
          command: "mock",
          args: [],
          status: "success",
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      });

      const summary = await buildSetupSummary({ ...defaultOptions, dryRun: false });
      expect(summary.ok).toBe(false);
      expect(summary.nextActions).toContain(
        "db:migrate が失敗しているため、DB 接続と migration エラーを修正して再実行する",
      );
    });
  });
});
