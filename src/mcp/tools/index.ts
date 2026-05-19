import type { ToolEntry } from "../registry.js";
import { memoryFetchTool, memorySearchTool } from "./memory.tool.js";
import { contextCompileTool } from "./context-compile.tool.js";
import {
  listKnowledgeTool,
  registerKnowledgeTool,
  searchKnowledgeTool,
  updateKnowledgeTool,
} from "./knowledge.tool.js";
import { readFileTool } from "./read-file.tool.js";
import { doctorTool, initialInstructionsTool } from "./system.tool.js";

const toolEntries: ToolEntry[] = [
  initialInstructionsTool,
  contextCompileTool,
  searchKnowledgeTool,
  registerKnowledgeTool,
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
