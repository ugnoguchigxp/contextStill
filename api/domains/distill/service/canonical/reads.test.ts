import { afterEach, expect, test } from "bun:test";
import { insertReview, settleReview } from "../../repository";
import { createTestDistill, T0 } from "../../test/fixtures";
import { hasSingleReview, reviewId } from "./reads";

const ts: ReturnType<typeof createTestDistill>[] = [];
afterEach(async () => {
	for (const t of ts.splice(0)) await t.dispose();
});

test("a generality review holds the atom only while open; host and verifier reviews hold it for good", async () => {
	const t = createTestDistill();
	ts.push(t);
	const atom = { id: "k1", contentDigest: "d1" };
	const open = (kind: "generality" | "host_rejected") =>
		t.deps.store.write((db) =>
			insertReview(db, {
				id: reviewId(kind, [atom]),
				kind,
				subject: { ownerKind: "knowledge", ownerId: atom.id },
				proposal: {},
				at: T0,
			}),
		);
	const held = () => t.deps.store.read((db) => hasSingleReview(db, atom));

	expect(held()).toBe(false);
	await open("generality");
	expect(held()).toBe(true);
	await t.deps.store.write((db) =>
		settleReview(db, reviewId("generality", [atom]), "resolved", {}, T0),
	);
	expect(held()).toBe(false);
	await open("host_rejected");
	await t.deps.store.write((db) =>
		settleReview(db, reviewId("host_rejected", [atom]), "resolved", {}, T0),
	);
	expect(held()).toBe(true);
});
