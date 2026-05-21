export type KnowledgeTagSeedKind = "technology" | "change_type";

export type KnowledgeTagSeed = {
  kind: KnowledgeTagSeedKind;
  slug: string;
  label: string;
  description?: string;
  aliases?: string[];
  sortOrder?: number;
  status?: "active" | "draft" | "deprecated";
};

export const knowledgeTagDefinitionSeeds: KnowledgeTagSeed[] = [
  { kind: "technology", slug: "typescript", label: "TypeScript", aliases: ["ts"] },
  { kind: "technology", slug: "javascript", label: "JavaScript", aliases: ["js"] },
  { kind: "technology", slug: "python", label: "Python", aliases: ["py"] },
  { kind: "technology", slug: "bun", label: "Bun" },
  { kind: "technology", slug: "node", label: "Node.js", aliases: ["nodejs"] },
  { kind: "technology", slug: "react", label: "React" },
  { kind: "technology", slug: "vite", label: "Vite" },
  { kind: "technology", slug: "hono", label: "Hono" },
  { kind: "technology", slug: "zod", label: "Zod" },
  { kind: "technology", slug: "drizzle", label: "Drizzle" },
  { kind: "technology", slug: "postgres", label: "PostgreSQL", aliases: ["postgresql"] },
  { kind: "technology", slug: "pgvector", label: "pgvector" },
  { kind: "technology", slug: "playwright", label: "Playwright" },
  { kind: "technology", slug: "biome", label: "Biome" },
  { kind: "change_type", slug: "feature", label: "Feature" },
  { kind: "change_type", slug: "bugfix", label: "Bugfix", aliases: ["fix", "bug"] },
  { kind: "change_type", slug: "refactor", label: "Refactor", aliases: ["refactoring"] },
  { kind: "change_type", slug: "schema", label: "Schema" },
  { kind: "change_type", slug: "migration", label: "Migration" },
  { kind: "change_type", slug: "test", label: "Test" },
  { kind: "change_type", slug: "docs", label: "Docs", aliases: ["documentation"] },
  { kind: "change_type", slug: "review", label: "Review" },
  { kind: "change_type", slug: "debug", label: "Debug" },
  { kind: "change_type", slug: "build", label: "Build" },
  { kind: "change_type", slug: "runtime", label: "Runtime" },
  { kind: "change_type", slug: "performance", label: "Performance", aliases: ["perf"] },
];
