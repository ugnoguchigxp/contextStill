import { Hono } from "hono";
import { doctorDomainNameSchema } from "../../../src/shared/schemas/doctor.schema.js";
import { getDoctorDomainForApi, getDoctorReportForApi } from "./doctor.service.js";

export const doctorRouter = new Hono()
  .get("/", async (c) => {
    const report = await getDoctorReportForApi();
    return c.json(report);
  })
  .get("/domains/:domain", async (c) => {
    const parsed = doctorDomainNameSchema.safeParse(c.req.param("domain"));
    if (!parsed.success) {
      return c.json({ error: "Unknown doctor domain" }, 404);
    }
    const domain = await getDoctorDomainForApi(parsed.data);
    return c.json(domain);
  });
