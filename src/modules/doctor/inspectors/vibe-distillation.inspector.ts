import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import {
  type DistillationRunInspectorOptions,
  inspectDistillationRunHealth,
} from "./distillation-run.inspector.js";

export async function inspectVibeDistillation(
  options: DistillationRunInspectorOptions,
): Promise<DoctorReport["vibeDistillation"]> {
  return inspectDistillationRunHealth(options, {
    label: "vibe distillation",
    launchAgentLabel: "com.memory-router.distill-pipeline",
    setupScript: "bun run automation:distill-pipeline --",
    runCommand: "bun run distill:pipeline -- --write --limit 1 --kind vibe",
    logPath: "logs/distill-pipeline.log",
    targetKind: "vibe_memory",
  });
}
