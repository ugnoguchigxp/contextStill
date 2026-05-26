import type { ToolEntry } from "../registry.js";
import { contextCompileTool } from "./context-compile.tool.js";
import {
  listKnowledgeTool,
  registerCandidateTool,
  registerCandidatesTool,
  searchKnowledgeTool,
  updateKnowledgeTool,
} from "./knowledge.tool.js";
import {
  fetchMemoryTool,
  memoryFetchTool,
  memorySearchTool,
  searchMemoryTool,
} from "./memory.tool.js";
import { readFileTool } from "./read-file.tool.js";
import { sessionMemoTool } from "./session-memo.tool.js";
import { doctorTool, initialInstructionsTool } from "./system.tool.js";

function isMcpV2Enabled(): boolean {
  const raw = process.env.MEMORY_ROUTER_MCP_V2?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

const v1ToolEntries: ToolEntry[] = [
  initialInstructionsTool,
  contextCompileTool,
  searchKnowledgeTool,
  registerCandidateTool,
  registerCandidatesTool,
  listKnowledgeTool,
  updateKnowledgeTool,
  readFileTool,
  memorySearchTool,
  memoryFetchTool,
  doctorTool,
];

const v2ToolEntries: ToolEntry[] = [
  initialInstructionsTool,
  contextCompileTool,
  searchKnowledgeTool,
  registerCandidateTool,
  registerCandidatesTool,
  sessionMemoTool,
  searchMemoryTool,
  fetchMemoryTool,
  doctorTool,
];

export function getExposedToolEntries(): ToolEntry[] {
  return isMcpV2Enabled() ? v2ToolEntries : v1ToolEntries;
}

export function getCallableToolEntries(): ToolEntry[] {
  if (!isMcpV2Enabled()) {
    return v1ToolEntries;
  }
  return [...v2ToolEntries, memorySearchTool, memoryFetchTool];
}
