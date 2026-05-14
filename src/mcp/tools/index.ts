import type { ToolEntry } from "../registry.js";
import { memoryFetchTool, memorySearchTool, recordVibeMemoryTool } from "./memory.tool.js";
import { contextCompileTool } from "./context-compile.tool.js";
import { doctorTool, initialInstructionsTool } from "./system.tool.js";

export const toolEntries: ToolEntry[] = [
  contextCompileTool,
  recordVibeMemoryTool,
  memorySearchTool,
  memoryFetchTool,
  initialInstructionsTool,
  doctorTool,
];

export function getExposedToolEntries(): ToolEntry[] {
  return toolEntries;
}
