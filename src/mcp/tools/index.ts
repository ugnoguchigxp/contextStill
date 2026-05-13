import type { ToolEntry } from "../registry.js";
import { contextCompileTool } from "./context-compile.tool.js";

export const toolEntries: ToolEntry[] = [contextCompileTool];

export function getExposedToolEntries(): ToolEntry[] {
  return toolEntries;
}
