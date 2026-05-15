import { getExposedToolEntries } from "../../../mcp/tools/index.js";
import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import { requiredPrimaryMcpTools } from "../doctor.constants.js";

export function inspectMcpSurface(): DoctorReport["mcp"] {
  const exposedTools = getExposedToolEntries()
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const missingPrimaryTools = requiredPrimaryMcpTools.filter(
    (name) => !exposedTools.includes(name),
  );
  const nextActions: string[] = [];
  if (missingPrimaryTools.length > 0) {
    nextActions.push(`不足 MCP primary tools を追加する: ${missingPrimaryTools.join(", ")}`);
  }

  return {
    exposedTools,
    requiredPrimaryTools: [...requiredPrimaryMcpTools],
    missingPrimaryTools,
    staleKnowledgeCount: 0,
    staleSourceCount: 0,
    nextActions,
  };
}
