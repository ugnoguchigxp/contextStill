import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
export async function callIsolatedMcp(runtime, name, args) {
  const endpoint = JSON.parse(await readFile(runtime.env.CONTEXT_STILL_MCP_ENDPOINT_PATH, "utf8"));
  const url = endpoint.url ?? endpoint.mcpUrl;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const initialized = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "isolated-onboarding", version: "1" },
      },
    }),
  });
  assert.equal(initialized.status, 200);
  const session = initialized.headers.get("mcp-session-id");
  if (session) headers["mcp-session-id"] = session;
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const payload = JSON.parse(
      text.startsWith("event:") || text.startsWith("data:")
        ? text
            .split("\n")
            .find((line) => line.startsWith("data:"))
            .slice(5)
            .trim()
        : text,
    );
    assert.ok(!payload.error, JSON.stringify(payload.error));
    assert.ok(!payload.result.isError, JSON.stringify(payload.result));
    return payload.result;
  } finally {
    if (session) await fetch(url, { method: "DELETE", headers });
  }
}
