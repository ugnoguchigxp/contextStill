export type PortableColumnKind = "text" | "number" | "jsonb" | "timestamp";

export type PortableColumnDefinition = {
  name: string;
  kind: PortableColumnKind;
};

export type PortableSqlTable = {
  name: string;
  columns: PortableColumnDefinition[];
};

export type PortableSqlRow = Record<string, unknown>;

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return null;
}

export function toPostgresLiteral(value: unknown, kind: PortableColumnKind): string {
  if (value == null) return "NULL";

  if (kind === "jsonb") {
    return `'${escapeSqlString(JSON.stringify(value))}'::jsonb`;
  }

  if (kind === "number") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? String(numberValue) : "NULL";
  }

  if (kind === "timestamp") {
    const timestamp = normalizeTimestamp(value);
    return timestamp ? `'${escapeSqlString(timestamp)}'::timestamp` : "NULL";
  }

  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${escapeSqlString(String(value))}'`;
}

export function writePostgresInsert(table: PortableSqlTable, rows: PortableSqlRow[]): string {
  if (rows.length === 0) return "";

  const columnNames = table.columns.map((column) => `"${column.name}"`).join(", ");
  const values = rows
    .map((row) => {
      const literals = table.columns.map((column) =>
        toPostgresLiteral(row[column.name], column.kind),
      );
      return `(${literals.join(", ")})`;
    })
    .join(",\n");

  return `INSERT INTO "${table.name}" (${columnNames}) VALUES\n${values}\nON CONFLICT DO NOTHING;\n`;
}

export function writePostgresDataSql(input: {
  tables: Array<{
    table: PortableSqlTable;
    rows: PortableSqlRow[];
  }>;
  createdAt: string;
  redactionEnabled: boolean;
}): string {
  const parts = [
    "-- context-still portable export",
    `-- created_at: ${input.createdAt}`,
    `-- redaction_enabled: ${String(input.redactionEnabled)}`,
    "BEGIN;",
    "",
  ];

  for (const entry of input.tables) {
    const insertSql = writePostgresInsert(entry.table, entry.rows);
    if (!insertSql) continue;
    parts.push(`-- ${entry.table.name}`, insertSql);
  }

  parts.push("COMMIT;", "");
  return parts.join("\n");
}
