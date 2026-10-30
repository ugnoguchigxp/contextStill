import type { Database } from "bun:sqlite";
import { canonicalJson } from "../../../infrastructure/digest";
import type { UsageEventInput } from "../contracts";

export { migrations } from "./migrations";

/**
 * Usage events are immutable: an existing id is left as it is. Only a duplicate id is
 * ignored; a CHECK violation (unknown verdict, …) still throws.
 */
export function insertUsageEvent(
	db: Database,
	input: UsageEventInput,
): "inserted" | "unchanged" {
	const { changes } = db
		.query(
			`INSERT INTO usage_events
			   (id, owner_kind, owner_id, channel, verdict, actor, run_ref, reason, origin, occurred_at, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO NOTHING`,
		)
		.run(
			input.id,
			input.ownerKind,
			input.ownerId,
			input.channel,
			input.verdict,
			input.actor,
			input.runRef,
			input.reason,
			input.origin,
			input.occurredAt,
			canonicalJson(input.metadata),
		);
	return changes === 0 ? "unchanged" : "inserted";
}
