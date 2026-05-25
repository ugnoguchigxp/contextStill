import { runDoctor, runDoctorDomain } from "../../../src/modules/doctor/doctor.service.js";
import type { DoctorDomainName } from "../../../src/shared/schemas/doctor.schema.js";

export async function fetchDoctorReport() {
  return runDoctor();
}

export async function fetchDoctorDomain(domain: DoctorDomainName) {
  return runDoctorDomain(domain);
}
