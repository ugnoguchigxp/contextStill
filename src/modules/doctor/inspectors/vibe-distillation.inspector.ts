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
    launchAgentLabel: "com.context-still.daemon",
    setupScript: "bun run automation:context-stilld --",
    runCommand: "bun run queue:finding:once",
    logPath: "logs/queue-supervisor.log",
    targetKind: "vibe_memory",
  });
}
