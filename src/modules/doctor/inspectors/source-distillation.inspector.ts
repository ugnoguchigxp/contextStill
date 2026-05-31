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
    launchAgentLabel: "com.context-still.queue-supervisor",
    setupScript: "bun run automation:queue-supervisor --",
    runCommand: "bun run queue:finding:once",
    logPath: "logs/queue-supervisor.log",
    targetKind: "wiki_file",
  });
}
