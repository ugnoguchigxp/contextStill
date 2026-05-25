import { Hono } from "hono";
import { overviewDomainNameSchema } from "../../../src/shared/schemas/overview.schema.js";
import { fetchOverviewDashboardForApi, fetchOverviewDomainForApi } from "./overview.repository.js";

export const overviewRouter = new Hono()
  .get("/", async (c) => {
    const dashboard = await fetchOverviewDashboardForApi();
    return c.json(dashboard);
  })
  .get("/domains/:domain", async (c) => {
    const parsed = overviewDomainNameSchema.safeParse(c.req.param("domain"));
    if (!parsed.success) {
      return c.json({ error: "Unknown overview domain" }, 404);
    }
    const domain = await fetchOverviewDomainForApi(parsed.data);
    return c.json(domain);
  });
