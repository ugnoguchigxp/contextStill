import type { CandidateRecord } from "./repository.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";

function toCandidateRecord(value: unknown): CandidateRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const title =
    typeof (value as { title?: unknown }).title === "string"
      ? (value as { title: string }).title.trim()
      : "";
  const content =
    typeof (value as { content?: unknown }).content === "string"
      ? (value as { content: string }).content.trim()
      : "";
  if (!title || !content) return null;
  return { title, content };
}

export function parseStorageCandidatesFromLlmOutput(llmOutput: string): CandidateRecord[] {
  const parsed = parseLlmJsonLike(llmOutput)?.value as { candidates?: unknown } | null;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.candidates)) {
    throw new Error("LLM output JSON must have candidates array");
  }

  const candidates = parsed.candidates.map(toCandidateRecord).filter(Boolean) as CandidateRecord[];
  return candidates;
}
