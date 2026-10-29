use rusqlite::Connection;
use std::path::Path;
pub(super) fn sanitize(path: &Path) -> Result<(), String> {
    let c = Connection::open(path).map_err(|e| e.to_string())?;
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='vibe_memories')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(());
    }
    c.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;
 CREATE TEMP TABLE private_memories AS SELECT id FROM vibe_memories WHERE json_type(metadata,'$.saaa')='object';
 CREATE TEMP TABLE private_episodes AS SELECT id FROM episode_cards WHERE json_type(metadata,'$.saaa')='object';
 DELETE FROM episode_cards_fts WHERE id IN private_episodes;
 DELETE FROM episode_refs WHERE episode_card_id IN private_episodes;
 DELETE FROM episode_cards WHERE id IN private_episodes;
 DELETE FROM vibe_memories_fts WHERE id IN private_memories;
 DELETE FROM distillation_queue_events WHERE queue_name='episodeDistiller' AND queue_job_id IN(SELECT id FROM episode_distiller_queue WHERE source_key IN private_memories);
 DELETE FROM episode_distiller_queue WHERE source_key IN private_memories;
 DELETE FROM vibe_memories WHERE id IN private_memories;
 DELETE FROM sync_states WHERE id LIKE 'saaa:%';
 COMMIT;").map_err(|e|format!("personal backup purge: {e}"))?;
    let exists: bool = c
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='saaa_imported_fragments')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        c.execute("DELETE FROM saaa_imported_fragments", [])
            .map_err(|e| e.to_string())?;
    }
    c.execute_batch("VACUUM;").map_err(|e| e.to_string())
}
