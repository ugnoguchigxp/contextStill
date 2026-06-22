import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { closeDbPool } from "../db/client.js";
import { projectIdentity } from "../project-identity.js";
import { createMcpServer } from "./server.js";
import { getExposedToolEntries } from "./tools/index.js";

type SessionRecord = {
  sessionId: string;
  clientName?: string;
  clientVersion?: string;
  remoteAddress?: string;
  createdAt: string;
  lastActivityAt: string;
  inFlightRequestCount: number;
  workerId?: string;
  route: string;
  closeReason?: string | null;
};

type ManagedSession = {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
  record: SessionRecord;
};

const workerId = `typescript-mcp-worker-${process.pid}`;
const sessions = new Map<string, ManagedSession>();

function defaultAppDataDir(): string {
  if (process.env.CONTEXT_STILL_APP_DATA_DIR) return process.env.CONTEXT_STILL_APP_DATA_DIR;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "contextStill");
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "contextStill");
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "contextStill",
  );
}

function resolveRuntimePaths() {
  const appDataDir = defaultAppDataDir();
  const runDir = path.join(appDataDir, "run");
  return {
    appDataDir,
    runDir,
    endpointPath: path.join(runDir, "mcp-endpoint.json"),
    sessionsPath: path.join(runDir, "mcp-sessions.json"),
  };
}

function resolveEndpoint() {
  const host = process.env.CONTEXT_STILL_MCP_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.CONTEXT_STILL_MCP_PORT || "39172", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid CONTEXT_STILL_MCP_PORT: ${process.env.CONTEXT_STILL_MCP_PORT}`);
  }
  return { host, port, url: `http://${host}:${port}/mcp` };
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function persistEndpoint(): void {
  const runtimePaths = resolveRuntimePaths();
  const endpoint = resolveEndpoint();
  writeJson(runtimePaths.endpointPath, {
    server: projectIdentity.packageName,
    url: endpoint.url,
    transport: "streamable-http",
    auth: "none",
    pid: process.pid,
    workerId,
    startedAt: new Date().toISOString(),
    sessionStatePath: runtimePaths.sessionsPath,
  });
}

function removeEndpoint(): void {
  const runtimePaths = resolveRuntimePaths();
  fs.rmSync(runtimePaths.endpointPath, { force: true });
}

function persistSessions(): void {
  const runtimePaths = resolveRuntimePaths();
  writeJson(
    runtimePaths.sessionsPath,
    [...sessions.values()].map((session) => session.record),
  );
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders = {}): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(value));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

function extractSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers["mcp-session-id"];
  if (Array.isArray(header)) return header[0];
  return header;
}

function getActiveSession(sessionId: string | undefined): ManagedSession | undefined {
  if (!sessionId) return undefined;
  const session = sessions.get(sessionId);
  if (!session || session.record.closeReason) return undefined;
  return session;
}

function extractClientInfo(body: unknown): { name?: string; version?: string } {
  if (!body || typeof body !== "object") return {};
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object") return {};
  const clientInfo = (params as { clientInfo?: unknown }).clientInfo;
  if (!clientInfo || typeof clientInfo !== "object") return {};
  return {
    name:
      typeof (clientInfo as { name?: unknown }).name === "string"
        ? (clientInfo as { name: string }).name
        : undefined,
    version:
      typeof (clientInfo as { version?: unknown }).version === "string"
        ? (clientInfo as { version: string }).version
        : undefined,
  };
}

function touchSession(session: ManagedSession, deltaInFlight: number): void {
  session.record.lastActivityAt = new Date().toISOString();
  session.record.inFlightRequestCount = Math.max(
    0,
    session.record.inFlightRequestCount + deltaInFlight,
  );
  persistSessions();
}

async function closeSession(sessionId: string, reason: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.record.closeReason = reason;
  session.record.lastActivityAt = new Date().toISOString();
  session.record.inFlightRequestCount = 0;
  persistSessions();
  await session.transport.close();
  await session.server.close();
}

async function handleMcpPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const existingSessionId = extractSessionId(req);
  const existing = getActiveSession(existingSessionId);

  if (existing) {
    touchSession(existing, 1);
    try {
      await existing.transport.handleRequest(req, res, body);
    } finally {
      touchSession(existing, -1);
    }
    return;
  }

  if (existingSessionId) {
    sendJson(res, 404, {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "MCP session is not active; initialize a new session",
      },
      id: null,
    });
    return;
  }

  if (!isInitializeRequest(body)) {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: initialize is required before session requests",
      },
      id: null,
    });
    return;
  }

  let sessionId = "";
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (initializedSessionId) => {
      sessionId = initializedSessionId;
      const now = new Date().toISOString();
      const client = extractClientInfo(body);
      sessions.set(initializedSessionId, {
        transport,
        server,
        record: {
          sessionId: initializedSessionId,
          clientName: client.name,
          clientVersion: client.version,
          remoteAddress: req.socket.remoteAddress ?? undefined,
          createdAt: now,
          lastActivityAt: now,
          inFlightRequestCount: 1,
          workerId,
          route: "typescript-mcp-server",
          closeReason: null,
        },
      });
      persistSessions();
    },
  });

  transport.onclose = () => {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session || session.record.closeReason) return;
    session.record.closeReason = "transport_closed";
    session.record.lastActivityAt = new Date().toISOString();
    persistSessions();
  };

  let cleanedUpUninitializedSession = false;
  const cleanupUninitializedSession = async () => {
    if (sessionId || cleanedUpUninitializedSession) return;
    cleanedUpUninitializedSession = true;
    await Promise.allSettled([transport.close(), server.close()]);
  };

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    await cleanupUninitializedSession();
    throw error;
  } finally {
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session) touchSession(session, -1);
    } else {
      await cleanupUninitializedSession();
    }
  }
}

async function handleMcpGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = extractSessionId(req);
  const session = getActiveSession(sessionId);
  if (!session) {
    sendJson(
      res,
      405,
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed without an active session" },
        id: null,
      },
      { allow: "POST, DELETE" },
    );
    return;
  }
  await session.transport.handleRequest(req, res);
}

async function handleMcpDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = extractSessionId(req);
  if (!sessionId || !getActiveSession(sessionId)) {
    sendJson(res, 404, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "MCP session not found" },
      id: null,
    });
    return;
  }
  await closeSession(sessionId, "client_disconnect");
  sendJson(res, 200, { ok: true, sessionId });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.url === "/mcp/health" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        server: projectIdentity.packageName,
        transport: "streamable-http",
        toolCount: getExposedToolEntries().length,
        activeSessionCount: [...sessions.values()].filter((session) => !session.record.closeReason)
          .length,
      });
      return;
    }

    if (req.url !== "/mcp") {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    if (req.method === "POST") {
      await handleMcpPost(req, res);
      return;
    }
    if (req.method === "GET") {
      await handleMcpGet(req, res);
      return;
    }
    if (req.method === "DELETE") {
      await handleMcpDelete(req, res);
      return;
    }

    sendJson(res, 405, { ok: false, error: "method_not_allowed" }, { allow: "GET, POST, DELETE" });
  } catch (error) {
    sendJson(res, 500, {
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
      id: null,
    });
  }
}

async function shutdown(signal: string, server: http.Server): Promise<void> {
  for (const [sessionId] of sessions) {
    await closeSession(sessionId, `daemon_${signal.toLowerCase()}`);
  }
  persistSessions();
  removeEndpoint();
  await closeDbPool();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

const endpoint = resolveEndpoint();
removeEndpoint();
persistSessions();

const server = http.createServer((req, res) => {
  void handleRequest(req, res);
});

server.on("error", (error) => {
  console.error(
    `[${projectIdentity.packageName}] MCP Streamable HTTP endpoint failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  removeEndpoint();
  void closeDbPool().finally(() => process.exit(1));
});

server.listen(endpoint.port, endpoint.host, () => {
  persistEndpoint();
  console.error(
    `[${projectIdentity.packageName}] MCP Streamable HTTP endpoint listening at ${endpoint.url}`,
  );
});

process.on("SIGINT", () => {
  void shutdown("SIGINT", server);
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM", server);
});
