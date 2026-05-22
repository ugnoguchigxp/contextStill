import type { ToolEntry } from "../registry.js";
import { contextCompileTool } from "./context-compile.tool.js";
import {
  listKnowledgeTool,
  registerCandidateTool,
  searchKnowledgeTool,
  updateKnowledgeTool,
} from "./knowledge.tool.js";
import { memoryFetchTool, memorySearchTool } from "./memory.tool.js";
import { readFileTool } from "./read-file.tool.js";
import { doctorTool, initialInstructionsTool } from "./system.tool.js";

const toolEntries: ToolEntry[] = [
  initialInstructionsTool,
  contextCompileTool,
  searchKnowledgeTool,
  registerCandidateTool,
  listKnowledgeTool,
  updateKnowledgeTool,
  readFileTool,
  memorySearchTool,
  memoryFetchTool,
  doctorTool,
];

export function getExposedToolEntries(): ToolEntry[] {
  return toolEntries;
}
