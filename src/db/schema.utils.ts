export const toSqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(", ");
