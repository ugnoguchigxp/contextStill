export type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<ToolResult>;
}
