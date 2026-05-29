import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import { getRequiredPrimaryMcpTools } from "../doctor.constants.js";

export async function inspectMcpSurface(): Promise<DoctorReport["mcp"]> {
  const { getExposedToolEntries } = await import("../../../mcp/tools/index.js");
  const requiredPrimaryMcpTools = getRequiredPrimaryMcpTools();
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
