import { groupedConfig } from "../../../config.js";
import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import {
  inspectDistillationRunHealth,
  type DistillationRunInspectorOptions,
} from "./distillation-run.inspector.js";

export async function inspectSourceDistillation(
  options: DistillationRunInspectorOptions,
): Promise<DoctorReport["sourceDistillation"]> {
  return inspectDistillationRunHealth(options, {
    label: "source distillation",
    launchAgentLabel: "com.memory-router.source-distillation",
    syncStateId: "source_distillation",
    runTableName: "source_distillation_runs",
    subjectColumnName: "source_fragment_id",
    promptVersion: groupedConfig.sourceDistillation.promptVersion,
    setupScript: "./scripts/setup-source-distillation-automation.sh",
    runCommand: "bun run distill:sources -- --apply",
    logPath: "logs/source-distillation.log",
  });
}
