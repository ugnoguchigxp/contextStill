import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { agentDiffsRouter } from "./modules/agent-diffs/agent-diffs.routes.js";
import { auditLogsRouter } from "./modules/audit/audit.routes.js";
import { candidatesRouter } from "./modules/candidates/candidates.routes.js";
import { contextCompilerRouter } from "./modules/context-compiler/context-compiler.routes.js";
import { doctorRouter } from "./modules/doctor/doctor.routes.js";
import { graphRouter } from "./modules/graph/graph.routes.js";
import { knowledgeRouter } from "./modules/knowledge/knowledge.routes.js";
import { overviewRouter } from "./modules/overview/overview.routes.js";
import { sourcesRouter } from "./modules/sources/sources.routes.js";
import { vibeMemoryRouter } from "./modules/vibe-memory/vibe-memory.routes.js";
import { Hono } from "hono";

const app = new Hono();

app.use("*", logger(), prettyJSON(), cors());

app.get("/api/health", (c) => c.json({ status: "ok", service: "memory-router-api" }));
app.route("/api/context", contextCompilerRouter);
app.route("/api/doctor", doctorRouter);
app.route("/api/knowledge", knowledgeRouter);
app.route("/api/sources", sourcesRouter);
app.route("/api/vibe-memory", vibeMemoryRouter);
app.route("/api/agent-diffs", agentDiffsRouter);
app.route("/api/graph", graphRouter);
app.route("/api/overview", overviewRouter);
app.route("/api/audit-logs", auditLogsRouter);
app.route("/api/candidates", candidatesRouter);

export default app;
