import type { ToolEntry } from "../registry.js";
import { memoryFetchTool, memorySearchTool } from "./memory.tool.js";
import { contextCompileTool } from "./context-compile.tool.js";
import { searchKnowledgeTool, registerKnowledgeTool } from "./knowledge.tool.js";
import { doctorTool, initialInstructionsTool } from "./system.tool.js";

export const toolEntries: ToolEntry[] = [
  initialInstructionsTool,
  contextCompileTool,
  searchKnowledgeTool,
  registerKnowledgeTool,
  memorySearchTool,
  memoryFetchTool,
  doctorTool,
];

export function getExposedToolEntries(): ToolEntry[] {
  return toolEntries;
}
