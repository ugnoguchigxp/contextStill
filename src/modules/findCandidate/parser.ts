import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import type { CandidateKnowledgeType, CandidateRecord } from "./repository.js";

function toCandidateType(value: unknown): CandidateKnowledgeType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "rule" || normalized === "procedure") return normalized;
  return undefined;
}

function toCandidateRecord(value: unknown): CandidateRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as {
    type?: unknown;
    candidateType?: unknown;
    title?: unknown;
    name?: unknown;
    content?: unknown;
    body?: unknown;
    description?: unknown;
  };
  const type = toCandidateType(record.type ?? record.candidateType);
  const title =
    typeof record.title === "string"
      ? record.title.trim()
      : typeof record.name === "string"
        ? record.name.trim()
        : "";
  const content =
    typeof record.content === "string"
      ? record.content.trim()
      : typeof record.body === "string"
        ? record.body.trim()
        : typeof record.description === "string"
          ? record.description.trim()
          : "";
  const normalizedTitle = title || content.slice(0, 80).replace(/\s+/g, " ").trim();
  const normalizedContent = content || title;
  if (!normalizedTitle || !normalizedContent) return null;
  return { ...(type ? { type } : {}), title: normalizedTitle, content: normalizedContent };
}

function hasCandidateFields(record: Record<string, unknown>): boolean {
  return (
    typeof record.title === "string" ||
    typeof record.name === "string" ||
    typeof record.content === "string" ||
    typeof record.body === "string" ||
    typeof record.description === "string"
  );
}

function collectCandidateValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as {
    candidates?: unknown;
    candidate?: unknown;
  };
  if (Array.isArray(record.candidates)) return record.candidates;
  if (record.candidate && typeof record.candidate === "object") return [record.candidate];
  if (hasCandidateFields(value as Record<string, unknown>)) return [value];
  return [];
}

function parsePlainTextCandidates(llmOutput: string): CandidateRecord[] {
  return llmOutput
    .split(/\n-{3,}\n/g)
    .map((block) => {
      const title = block.match(/^TITLE:\s*(.+)$/im)?.[1]?.trim() ?? "";
      const content = block.match(/^CONTENT:\s*([\s\S]+)$/im)?.[1]?.trim() ?? "";
      const type = toCandidateType(block.match(/^TYPE:\s*(.+)$/im)?.[1]);
      if (!title || !content) return null;
      return { ...(type ? { type } : {}), title, content };
    })
    .filter((candidate): candidate is CandidateRecord => Boolean(candidate));
}

export function parseStorageCandidatesFromLlmOutput(llmOutput: string): CandidateRecord[] {
  const parsed = parseLlmJsonLike(llmOutput)?.value;
  if (parsed === undefined || parsed === null) {
    return parsePlainTextCandidates(llmOutput);
  }

  const candidates = collectCandidateValues(parsed)
    .map(toCandidateRecord)
    .filter((candidate): candidate is CandidateRecord => Boolean(candidate));
  if (candidates.length > 0) return candidates;
  return parsePlainTextCandidates(llmOutput);
}
