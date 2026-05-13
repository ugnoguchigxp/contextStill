import { closeDbPool } from "../db/index.js";
import { runDoctor } from "../modules/doctor/doctor.service.js";

async function main(): Promise<void> {
  const report = await runDoctor();
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "failed") {
    process.exitCode = 1;
  }
}

main().finally(async () => {
  await closeDbPool();
});
