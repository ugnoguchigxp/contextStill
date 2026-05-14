import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { contextCompilerRouter } from "./modules/context-compiler/context-compiler.routes.js";
import { doctorRouter } from "./modules/doctor/doctor.routes.js";
import { Hono } from "hono";

const app = new Hono();

app.use("*", logger(), prettyJSON(), cors());

app.get("/api/health", (c) => c.json({ status: "ok", service: "memory-router-api" }));
app.route("/api/context", contextCompilerRouter);
app.route("/api/doctor", doctorRouter);

export default app;
