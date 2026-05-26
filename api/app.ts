import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { groupedConfig } from "../src/config.js";
import { adminApiKeyAuth } from "./middleware/admin-auth.js";
import { agentDiffsRouter } from "./modules/agent-diffs/agent-diffs.routes.js";
import { auditLogsRouter } from "./modules/audit/audit.routes.js";
import { candidatesRouter } from "./modules/candidates/candidates.routes.js";
import { contextCompilerRouter } from "./modules/context-compiler/context-compiler.routes.js";
import { doctorRouter } from "./modules/doctor/doctor.routes.js";
import { graphRouter } from "./modules/graph/graph.routes.js";
import { knowledgeRouter } from "./modules/knowledge/knowledge.routes.js";
import { overviewRouter } from "./modules/overview/overview.routes.js";
import { queueRouter } from "./modules/queue/queue.routes.js";
import { settingsRouter } from "./modules/settings/settings.routes.js";
import { sourcesRouter } from "./modules/sources/sources.routes.js";
import { sessionMemoRouter } from "./modules/session-memo/session-memo.routes.js";
import { vibeMemoryRouter } from "./modules/vibe-memory/vibe-memory.routes.js";

const app = new Hono();

const corsMiddleware =
  groupedConfig.admin.allowedOrigins.length > 0
    ? cors({ origin: groupedConfig.admin.allowedOrigins })
    : cors();

app.use("*", logger(), prettyJSON(), corsMiddleware);
app.use("/api/*", adminApiKeyAuth());

app.get("/api/health/live", (c) => c.json({ status: "alive", service: "memory-router-api" }));
app.get("/api/health/ready", (c) => c.json({ status: "ready", service: "memory-router-api" }));
app.get("/api/health", (c) => c.json({ status: "ok", service: "memory-router-api" }));
app.route("/api/context", contextCompilerRouter);
app.route("/api/doctor", doctorRouter);
app.route("/api/knowledge", knowledgeRouter);
app.route("/api/sources", sourcesRouter);
app.route("/api/vibe-memory", vibeMemoryRouter);
app.route("/api/session-memo", sessionMemoRouter);
app.route("/api/agent-diffs", agentDiffsRouter);
app.route("/api/graph", graphRouter);
app.route("/api/overview", overviewRouter);
app.route("/api/queue", queueRouter);
app.route("/api/audit-logs", auditLogsRouter);
app.route("/api/candidates", candidatesRouter);
app.route("/api/settings", settingsRouter);

export default app;
