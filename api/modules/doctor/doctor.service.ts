import { fetchDoctorReport } from "./doctor.repository.js";

export async function getDoctorReportForApi() {
  return fetchDoctorReport();
}
