import { runDoctor } from "../../../src/modules/doctor/doctor.service.js";

export async function fetchDoctorReport() {
  return runDoctor();
}
