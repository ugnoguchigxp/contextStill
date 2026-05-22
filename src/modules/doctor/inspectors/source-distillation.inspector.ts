import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import {
  type DistillationRunInspectorOptions,
  inspectDistillationRunHealth,
} from "./distillation-run.inspector.js";

export async function inspectSourceDistillation(
  options: DistillationRunInspectorOptions,
): Promise<DoctorReport["sourceDistillation"]> {
  return inspectDistillationRunHealth(options, {
    label: "wiki distillation",
    launchAgentLabel: "com.memory-router.distill-pipeline",
    setupScript: "./scripts/setup-distill-pipeline-automation.sh",
    runCommand: "bun run distill:pipeline -- --write --limit 1 --kind wiki",
    logPath: "logs/distill-pipeline.log",
    targetKind: "wiki_file",
  });
}
