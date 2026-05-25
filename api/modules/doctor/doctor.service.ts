import type { DoctorDomainName } from "../../../src/shared/schemas/doctor.schema.js";
import { fetchDoctorDomain, fetchDoctorReport } from "./doctor.repository.js";

export async function getDoctorReportForApi() {
  return fetchDoctorReport();
}

export async function getDoctorDomainForApi(domain: DoctorDomainName) {
  return fetchDoctorDomain(domain);
}
