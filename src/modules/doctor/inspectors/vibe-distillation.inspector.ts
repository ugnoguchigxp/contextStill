import { groupedConfig } from "../../../config.js";
import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import {
  inspectDistillationRunHealth,
  type DistillationRunInspectorOptions,
} from "./distillation-run.inspector.js";

export async function inspectVibeDistillation(
  options: DistillationRunInspectorOptions,
): Promise<DoctorReport["vibeDistillation"]> {
  return inspectDistillationRunHealth(options, {
    label: "vibe distillation",
    launchAgentLabel: "com.memory-router.vibe-distillation",
    syncStateId: "vibe_distillation",
    runTableName: "vibe_memory_distillation_runs",
    subjectColumnName: "vibe_memory_id",
    promptVersion: groupedConfig.vibeDistillation.promptVersion,
    setupScript: "./scripts/setup-distillation-automation.sh",
    runCommand: "bun run distill:vibe-memory -- --apply",
    logPath: "logs/vibe-distillation.log",
    jobSourceKind: "vibe_memory",
  });
}
