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
    launchAgentLabel: "com.context-still.daemon",
    setupScript: "bun run automation:context-stilld --",
    runCommand: "bun run queue:finding:once",
    logPath: "logs/queue-supervisor.log",
    targetKind: "wiki_file",
  });
}
