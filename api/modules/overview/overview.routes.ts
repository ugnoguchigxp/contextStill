import { Hono } from "hono";
import { fetchOverviewDashboardForApi } from "./overview.repository.js";

export const overviewRouter = new Hono().get("/", async (c) => {
  const dashboard = await fetchOverviewDashboardForApi();
  return c.json(dashboard);
});
