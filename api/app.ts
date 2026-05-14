import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { activityRouter } from "./modules/activity/activity.routes.js";
import { artifactsRouter } from "./modules/artifacts/artifacts.routes.js";
import { contextCompilerRouter } from "./modules/context-compiler/context-compiler.routes.js";
import { doctorRouter } from "./modules/doctor/doctor.routes.js";
import { evidenceRouter } from "./modules/evidence/evidence.routes.js";
import { graphRouter } from "./modules/graph/graph.routes.js";
import { knowledgeRouter } from "./modules/knowledge/knowledge.routes.js";
import { sourcesRouter } from "./modules/sources/sources.routes.js";
import { Hono } from "hono";

const app = new Hono();

app.use("*", logger(), prettyJSON(), cors());

app.get("/api/health", (c) => c.json({ status: "ok", service: "memory-router-api" }));
app.route("/api/context", contextCompilerRouter);
app.route("/api/doctor", doctorRouter);
app.route("/api/knowledge", knowledgeRouter);
app.route("/api/sources", sourcesRouter);
app.route("/api/evidence", evidenceRouter);
app.route("/api/activity", activityRouter);
app.route("/api/artifacts", artifactsRouter);
app.route("/api/graph", graphRouter);

export default app;
