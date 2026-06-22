import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildMcpConfigSnippet } from "../src/cli/onboarding/mcp-config.js";
import { findLegacyMcpConfigWarnings } from "../src/modules/doctor/inspectors/mcp.inspector.js";

describe("MCP config snippet", () => {
  test("uses daemon endpoint URL registration instead of command registration", () => {
    const snippet = buildMcpConfigSnippet("/repo");
    const parsed = JSON.parse(snippet);

    expect(parsed.mcpServers["context-still"]).toEqual({
      url: "http://127.0.0.1:39172/mcp",
      enabled: true,
    });
    expect(snippet).not.toContain("command");
    expect(snippet).not.toContain("start:mcp");
    expect(snippet).not.toContain("src/index.ts");
  });

  test("does not expose the deleted direct stdio MCP runtime through package scripts", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    const scripts = packageJson.scripts ?? {};
    const serializedScripts = JSON.stringify(scripts);

    expect(scripts["start:mcp"]).toBe("bun run src/mcp/http-server.ts");
    expect(scripts).not.toHaveProperty("start:mcp:stdio");
    expect(serializedScripts).not.toContain("src/index.ts");
    expect(serializedScripts).not.toContain("src/mcp/stdio-server.ts");
    expect(serializedScripts).not.toContain("src/cli/mcp-smoke.ts");
    expect(fs.existsSync(new URL("../src/index.ts", import.meta.url))).toBe(false);
    expect(fs.existsSync(new URL("../src/mcp/stdio-server.ts", import.meta.url))).toBe(false);
    expect(fs.existsSync(new URL("../src/cli/mcp-smoke.ts", import.meta.url))).toBe(false);
  });

  test("doctor legacy config scan ignores sibling command-based MCP servers", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-still-mcp-config-"));
    const codexConfig = path.join(tempDir, "config.toml");
    const antigravityConfig = path.join(tempDir, "mcp_config.json");

    fs.writeFileSync(
      codexConfig,
      [
        "[mcp_servers.context-still.tools.context_compile]",
        'description = "enabled tool"',
        "",
        "[mcp_servers.node_repl]",
        'command = "/usr/local/bin/node-repl"',
        "",
        "[mcp_servers.context-still]",
        'url = "http://127.0.0.1:39172/mcp"',
        "enabled = true",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      antigravityConfig,
      `${JSON.stringify(
        {
          mcpServers: {
            "other-server": { command: "/tmp/other" },
            "context-still": { url: "http://127.0.0.1:39172/mcp", enabled: true },
          },
        },
        null,
        2,
      )}\n`,
    );

    expect(
      findLegacyMcpConfigWarnings([
        { path: codexConfig, format: "toml" },
        { path: antigravityConfig, format: "json" },
      ]),
    ).toEqual([]);
  });
});
