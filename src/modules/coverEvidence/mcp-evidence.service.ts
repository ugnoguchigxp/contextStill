import type { CoverEvidenceReference, CoverEvidenceToolEvent } from "./types.js";
import { legacyProjectEnvKey, projectEnvKey } from "../../project-identity.js";

type McpReferenceKind = Extract<CoverEvidenceReference["kind"], "context7" | "deepwiki">;
export type McpEvidenceToolName = McpReferenceKind;

const mcpEvidenceToolNames = [
  "context7",
  "deepwiki",
] as const satisfies readonly McpEvidenceToolName[];

function mcpCommandEnvKey(toolName: McpEvidenceToolName): string {
  return projectEnvKey(`${toolName.toUpperCase()}_MCP_COMMAND`);
}

function legacyMcpCommandEnvKey(toolName: McpEvidenceToolName): string {
  return legacyProjectEnvKey(`${toolName.toUpperCase()}_MCP_COMMAND`);
}

function mcpReferenceKind(value: string): McpReferenceKind | null {
  if (value === "context7" || value === "deepwiki") return value;
  return null;
}

export function configuredMcpEvidenceToolNames(): McpEvidenceToolName[] {
  return mcpEvidenceToolNames.filter((toolName) => {
    const command =
      process.env[mcpCommandEnvKey(toolName)] ?? process.env[legacyMcpCommandEnvKey(toolName)];
    return typeof command === "string" && Boolean(command.trim());
  });
}

export function referencesFromMcpToolEvents(
  toolEvents: CoverEvidenceToolEvent[],
): CoverEvidenceReference[] {
  return toolEvents
    .map((event): CoverEvidenceReference | null => {
      if (!event.ok) return null;
      const kind = mcpReferenceKind(event.name);
      if (!kind) return null;
      const metadata = event.metadata ?? {};
      const uri =
        typeof metadata.uri === "string" && metadata.uri.trim()
          ? metadata.uri.trim()
          : `${kind}:evidence`;
      return {
        kind,
        uri,
        locator:
          typeof metadata.locator === "string" && metadata.locator.trim()
            ? metadata.locator.trim()
            : undefined,
        title:
          typeof metadata.title === "string" && metadata.title.trim()
            ? metadata.title.trim()
            : undefined,
        note: "mcp evidence verified external claim",
        evidenceRole: "external_verification",
      };
    })
    .filter((reference): reference is CoverEvidenceReference => Boolean(reference));
}
