export const saaaMemorySchemaSql = `
CREATE TABLE IF NOT EXISTS saaa_imported_fragments (
 fragment_key TEXT PRIMARY KEY,vibe_memory_id TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS saaa_fragment_memory ON saaa_imported_fragments(vibe_memory_id);
`;
