import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { UpsertResult } from "../scope";

export interface UpsertSpec {
	table: string;
	/** Conflict target: the identity of the row. */
	key: Record<string, SQLQueryBindings>;
	/** Columns written on insert and compared on conflict; a difference updates them all. */
	values: Record<string, SQLQueryBindings>;
	/** Written on insert only; never compared or changed afterwards (e.g. created_at). */
	insertOnly?: Record<string, SQLQueryBindings>;
	/** Written on insert, and on update only when a compared column differs (e.g. updated_at). */
	touch?: Record<string, SQLQueryBindings>;
	/** Increase `revision` by one on a real update. */
	revision?: boolean;
}

/**
 * `INSERT … ON CONFLICT DO UPDATE … WHERE <any column differs>`: the row's `seq` never changes,
 * and an identical write changes nothing (no revision bump, no FTS trigger). The caller owns the
 * transaction. Table and column names come from the calling repository, never from input.
 */
export function upsertRow(db: Database, spec: UpsertSpec): UpsertResult {
	const keyNames = Object.keys(spec.key);
	const valueNames = Object.keys(spec.values);
	const onceNames = Object.keys(spec.insertOnly ?? {});
	const touchNames = Object.keys(spec.touch ?? {});
	const names = [...keyNames, ...valueNames, ...onceNames, ...touchNames];
	const bindings = [
		...Object.values(spec.key),
		...Object.values(spec.values),
		...Object.values(spec.insertOnly ?? {}),
		...Object.values(spec.touch ?? {}),
	];
	const assignments = [
		...[...valueNames, ...touchNames].map((n) => `${n}=excluded.${n}`),
		...(spec.revision ? ["revision=revision+1"] : []),
	];
	const differs = valueNames.map(
		(n) => `${spec.table}.${n} IS NOT excluded.${n}`,
	);
	const where = keyNames.map((n) => `${spec.table}.${n} IS ?`);
	const existed =
		db
			.query(
				`SELECT 1 AS present FROM ${spec.table} WHERE ${where.join(" AND ")}`,
			)
			.get(...Object.values(spec.key)) !== null;
	const sql =
		`INSERT INTO ${spec.table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) ` +
		`ON CONFLICT(${keyNames.join(", ")}) DO UPDATE SET ${assignments.join(", ")}` +
		(differs.length ? ` WHERE ${differs.join(" OR ")}` : "");
	const { changes } = db.query(sql).run(...bindings);
	if (changes === 0) return "unchanged";
	return existed ? "updated" : "inserted";
}
