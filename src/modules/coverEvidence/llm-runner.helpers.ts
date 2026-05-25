import { groupedConfig } from "../../config.js";
import type { DistillationCompletionResult } from "../distillation/distillation-runtime.service.js";
import type { CoverEvidenceToolEvent } from "./types.js";

const MAX_PARSE_FAILURE_PREVIEW_CHARS = 700;
const MAX_PROCEDURE_REPAIR_EVIDENCE_CHARS = 12_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function coverEvidenceToolLimits(): Record<string, number> {
  return {
    search_web: groupedConfig.distillationTools.coverEvidenceSearchMaxCalls,
    fetch_content: groupedConfig.distillationTools.coverEvidenceFetchMaxCalls,
  };
}

export function coverEvidenceMaxToolRounds(): number {
  const limits = coverEvidenceToolLimits();
  return Math.max(0, limits.search_web + limits.fetch_content);
}

export function parseFailureToolEvent(params: {
  reason: string;
  error: unknown;
  completion: DistillationCompletionResult;
}): CoverEvidenceToolEvent {
  const content = params.completion.content ?? "";
  return {
    name: "parse_cover_evidence_result",
    ok: false,
    error: errorMessage(params.error),
    metadata: {
      reason: params.reason,
      contentChars: content.length,
      contentPreview: content.slice(0, MAX_PARSE_FAILURE_PREVIEW_CHARS),
      toolEventCount: params.completion.toolEvents.length,
    },
  };
}

function toolEvidenceLabel(event: DistillationCompletionResult["toolEvents"][number]): string {
  const metadata = event.metadata ?? {};
  const locator =
    typeof metadata.finalUrl === "string"
      ? metadata.finalUrl
      : typeof metadata.url === "string"
        ? metadata.url
        : typeof metadata.query === "string"
          ? `query:${metadata.query}`
          : "";
  return locator ? `${event.name} ${locator}` : event.name;
}

function appendUniqueEvidence(
  parts: string[],
  seen: Set<string>,
  label: string,
  content: string,
): void {
  const trimmed = content.trim();
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  parts.push(`${label}:\n${trimmed}`);
}

export function procedureRepairEvidenceFromCompletion(params: {
  sourceEvidence?: string;
  completion: DistillationCompletionResult;
}): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  if (params.sourceEvidence?.trim()) {
    appendUniqueEvidence(parts, seen, "Source evidence", params.sourceEvidence);
  }
  for (const event of params.completion.toolEvents) {
    if (event.ok && event.content?.trim()) {
      appendUniqueEvidence(
        parts,
        seen,
        `Tool evidence (${toolEvidenceLabel(event)})`,
        event.content,
      );
    }
  }
  for (const message of params.completion.messages) {
    if (message.role === "tool" && message.content?.trim()) {
      appendUniqueEvidence(
        parts,
        seen,
        `Tool message evidence (${message.name ?? message.tool_call_id ?? "tool"})`,
        message.content,
      );
    }
  }
  return parts.join("\n\n---\n\n").slice(0, MAX_PROCEDURE_REPAIR_EVIDENCE_CHARS);
}
