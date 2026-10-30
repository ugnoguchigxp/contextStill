import type { VectorOwnerKind } from "../../vectors";
import type { EmbeddingTextRow } from "../contracts";

/**
 * The text that is embedded (and whose sha256 is the vector's `content_digest`).
 *  knowledge: `${title}\n${body}` (the legacy `content_hash` input)
 *  episode:   the non-empty ones of title, situation, action, outcome, lesson joined by "\n"
 */
export function embeddingText(
	kind: VectorOwnerKind,
	row: EmbeddingTextRow,
): string {
	if (kind === "knowledge") return `${row.title}\n${row.body ?? ""}`;
	return [row.title, row.situation, row.action, row.outcome, row.lesson]
		.filter((part): part is string => typeof part === "string" && part !== "")
		.join("\n");
}
