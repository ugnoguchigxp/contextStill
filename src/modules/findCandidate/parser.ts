import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { hasSkillLikeProcedureBody } from "../distillation/procedure-quality.js";
import type {
  CandidateKnowledgePolarity,
  CandidateKnowledgeType,
  CandidateRecord,
} from "./repository.js";

function toCandidateType(value: unknown): CandidateKnowledgeType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "rule" || normalized === "procedure") return normalized;
  return undefined;
}

function toCandidatePolarity(
  value: unknown,
): Exclude<CandidateKnowledgePolarity, "neutral"> | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "positive" || normalized === "negative") {
    return normalized;
  }
  return undefined;
}

function toCandidateRecord(value: unknown): CandidateRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as {
    type?: unknown;
    candidateType?: unknown;
    polarity?: unknown;
    title?: unknown;
    name?: unknown;
    content?: unknown;
    body?: unknown;
    description?: unknown;
  };
  const type = toCandidateType(record.type ?? record.candidateType);
  const polarity = toCandidatePolarity(record.polarity);
  if (!type || !polarity) return null;
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
  if (polarity === "negative" && type === "procedure") return null;
  if (type === "procedure" && !hasSkillLikeProcedureBody(normalizedContent)) return null;
  return {
    type,
    polarity,
    title: normalizedTitle,
    content: normalizedContent,
  };
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
      const fields: Record<string, string[]> = {};
      let currentField: string | null = null;
      for (const line of block.split(/\r?\n/)) {
        const match = line.match(/^(TYPE|POLARITY|TITLE|CONTENT):\s*(.*)$/i);
        if (match) {
          currentField = match[1].toUpperCase();
          fields[currentField] = [match[2] ?? ""];
          continue;
        }
        if (currentField) {
          fields[currentField].push(line);
        }
      }
      const title = fields.TITLE?.join("\n").trim() ?? "";
      const content = fields.CONTENT?.join("\n").trim() ?? "";
      const type = toCandidateType(fields.TYPE?.join("\n"));
      const polarity = toCandidatePolarity(fields.POLARITY?.join("\n"));
      if (!type || !polarity || !title || !content) return null;
      if (polarity === "negative" && type === "procedure") return null;
      if (type === "procedure" && !hasSkillLikeProcedureBody(content)) return null;
      return {
        type,
        polarity,
        title,
        content,
      };
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
