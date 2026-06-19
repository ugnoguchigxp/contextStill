export type ParsedPortableSqlArchive = {
  tables: Map<string, PortableParsedSqlRow[]>;
  counts: Map<string, number>;
};

export type PortableParsedSqlRow = {
  tableName: string;
  values: Record<string, unknown>;
};

function parseQuotedIdentifierList(raw: string): string[] {
  return [...raw.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

function parseSqlStringLiteral(raw: string): { value: string; suffix: string } {
  let value = "";
  let index = 1;
  while (index < raw.length) {
    const char = raw[index];
    if (char === "'") {
      if (raw[index + 1] === "'") {
        value += "'";
        index += 2;
        continue;
      }
      return { value, suffix: raw.slice(index + 1).trim() };
    }
    value += char;
    index += 1;
  }
  throw new Error(`Unterminated SQL string literal: ${raw}`);
}

function parseSqlLiteral(raw: string): unknown {
  const value = raw.trim();
  if (value === "NULL") return null;
  if (value === "TRUE") return true;
  if (value === "FALSE") return false;
  if (value.startsWith("'")) {
    const parsed = parseSqlStringLiteral(value);
    if (parsed.suffix === "::jsonb") return JSON.parse(parsed.value);
    if (parsed.suffix === "::timestamp") return parsed.value;
    if (parsed.suffix.length > 0) {
      throw new Error(`Unsupported SQL literal suffix: ${parsed.suffix}`);
    }
    return parsed.value;
  }
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) return numberValue;
  throw new Error(`Unsupported SQL literal: ${value}`);
}

function splitTopLevelValues(raw: string): string[] {
  const values: string[] = [];
  let start = 0;
  let inString = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "'") {
      if (inString && raw[index + 1] === "'") {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (!inString && char === ",") {
      values.push(raw.slice(start, index).trim());
      start = index + 1;
    }
  }

  values.push(raw.slice(start).trim());
  return values;
}

function parseValueTuples(raw: string): string[] {
  const tuples: string[] = [];
  let tupleStart = -1;
  let depth = 0;
  let inString = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "'") {
      if (inString && raw[index + 1] === "'") {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (depth === 0 && char !== "(") {
      if (char === "," || /\s/.test(char)) continue;
      throw new Error(`Unexpected token in SQL VALUES block: ${char}`);
    }

    if (char === "(") {
      if (depth === 0) tupleStart = index + 1;
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0 && tupleStart >= 0) {
        tuples.push(raw.slice(tupleStart, index));
        tupleStart = -1;
      }
    }
  }

  if (depth !== 0 || inString) throw new Error("Malformed SQL VALUES block");
  return tuples;
}

export function parsePostgresDataSql(sql: string): ParsedPortableSqlArchive {
  const tables = new Map<string, PortableParsedSqlRow[]>();
  const insertPattern =
    /INSERT INTO "([^"]+)"\s+\(([^)]+)\)\s+VALUES\s+([\s\S]*?)\nON CONFLICT DO NOTHING;/g;

  for (const match of sql.matchAll(insertPattern)) {
    const tableName = match[1];
    const columnBlock = match[2];
    const valuesBlock = match[3];
    if (!tableName || !columnBlock || !valuesBlock) continue;

    const columns = parseQuotedIdentifierList(columnBlock);
    const rows = parseValueTuples(valuesBlock).map((tuple) => {
      const rawValues = splitTopLevelValues(tuple);
      if (rawValues.length !== columns.length) {
        throw new Error(
          `Column/value length mismatch in ${tableName}: ${columns.length} columns, ${rawValues.length} values`,
        );
      }
      return {
        tableName,
        values: Object.fromEntries(
          columns.map((column, index) => [column, parseSqlLiteral(rawValues[index] ?? "")]),
        ),
      };
    });

    tables.set(tableName, [...(tables.get(tableName) ?? []), ...rows]);
  }

  return {
    tables,
    counts: new Map([...tables.entries()].map(([tableName, rows]) => [tableName, rows.length])),
  };
}

export function buildPostgresInsertOnlyStatements(sql: string): string[] {
  const insertPattern =
    /INSERT INTO "([^"]+)"\s+\(([^)]+)\)\s+VALUES\s+([\s\S]*?)\nON CONFLICT DO NOTHING;/g;
  const statements: string[] = [];

  for (const match of sql.matchAll(insertPattern)) {
    const tableName = match[1];
    const columnBlock = match[2];
    const valuesBlock = match[3];
    if (!tableName || !columnBlock || !valuesBlock) continue;
    statements.push(`INSERT INTO "${tableName}" (${columnBlock}) VALUES ${valuesBlock};`);
  }

  return statements;
}
