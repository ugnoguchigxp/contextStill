import { readProjectEnv } from "../../project-identity.js";
import type { ToolEntry } from "../registry.js";
import { compileEvalTool } from "./compile-eval.tool.js";
import { contextCompileTool } from "./context-compile.tool.js";
import { contextDecisionFeedbackTool, contextDecisionTool } from "./context-decision.tool.js";
import { fetchEpisodeTool, searchEpisodesTool } from "./episode.tool.js";
import {
  listKnowledgeTool,
  registerCandidatesTool,
  registerReviewCorrectionsTool,
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
import { doctorTool, initialInstructionsTool } from "./system.tool.js";

function isMcpV2Enabled(): boolean {
  const raw = readProjectEnv("MCP_V2")?.trim().toLowerCase();
  if (!raw) return true;
  return !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
}

const v1ToolEntries: ToolEntry[] = [
  initialInstructionsTool,
  contextCompileTool,
  contextDecisionTool,
  contextDecisionFeedbackTool,
  searchKnowledgeTool,
  registerCandidatesTool,
  registerReviewCorrectionsTool,
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
  compileEvalTool,
  contextDecisionTool,
  contextDecisionFeedbackTool,
  searchKnowledgeTool,
  registerCandidatesTool,
  registerReviewCorrectionsTool,
  searchMemoryTool,
  fetchMemoryTool,
  searchEpisodesTool,
  fetchEpisodeTool,
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
