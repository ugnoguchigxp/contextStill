export type UsageOwnerKind = "knowledge" | "episode";
export type UsageChannel = "compile" | "search" | "mcp";
export type UsageVerdict =
	| "presented"
	| "used"
	| "not_used"
	| "wrong"
	| "off_topic";
export type UsageActor = "agent" | "system" | "user" | "eumenes";
export type UsageOrigin = "legacy_import" | "live";

export interface UsageEventInput {
	id: string;
	ownerKind: UsageOwnerKind;
	ownerId: string;
	channel: UsageChannel;
	verdict: UsageVerdict;
	actor: UsageActor;
	runRef: string | null;
	reason: string | null;
	origin: UsageOrigin;
	occurredAt: string;
	metadata: Record<string, unknown>;
}
