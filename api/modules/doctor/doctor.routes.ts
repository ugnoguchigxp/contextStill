import { Hono } from "hono";
import { getDoctorReportForApi } from "./doctor.service.js";

export const doctorRouter = new Hono().get("/", async (c) => {
  const report = await getDoctorReportForApi();
  return c.json(report);
});
