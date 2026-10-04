import { type DistillationQueueName, queueTableNameByQueue } from "./types.js";

type SchemaReader = { query(sql: string): { all(): unknown[] } };

/** Legacy workers must neither claim nor recover resident Agent runs. Older databases are
 * supported until the additive migration installs the protocol column. */
export function legacyProtocolPredicate(db: SchemaReader, queue: DistillationQueueName): string {
  if (queue !== "findingCandidate" && queue !== "coveringEvidence" && queue !== "finalizeDistille")
    return "1 = 1";
  const table = queueTableNameByQueue[queue];
  const columns = db.query(`select name from pragma_table_info('${table}')`).all();
  const hasProtocol = columns.some(
    (row) =>
      row !== null && typeof row === "object" && "name" in row && row.name === "protocol_version",
  );
  const residentProtocol = queue === "finalizeDistille" ? 2 : 3;
  return hasProtocol ? `coalesce(protocol_version, 1) < ${residentProtocol}` : "1 = 1";
}
