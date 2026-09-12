#![cfg(test)]
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Instant;

use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    Connection,
};

use super::test_support::create_minimal_compile_schema;
use super::*;

fn fixture(count: usize, links: usize) -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    create_minimal_compile_schema(&connection);
    connection.execute_batch(
        "create table sources(id text primary key, uri text not null);
         create table source_fragments(id text primary key, source_id text, locator text not null);
         create table knowledge_source_links(knowledge_id text, source_fragment_id text, confidence real, created_at text);
         create index source_links_knowledge on knowledge_source_links(knowledge_id);",
    ).unwrap();
    let transaction = connection.unchecked_transaction().unwrap();
    for index in 0..count {
        let id = format!("k{index:05}");
        transaction
            .execute(
                "insert into knowledge_items (id,type,status,title,body,dynamic_score,applies_to)
             values (?1,'rule','active','sqlite 日本語','sqlite 本文',50,'{\"general\":true}')",
                [&id],
            )
            .unwrap();
        for link in 0..links {
            let source_id = format!("{id}-s{link}");
            transaction
                .execute(
                    "insert into sources values (?1,?2)",
                    (&source_id, format!("file:///{source_id}")),
                )
                .unwrap();
            transaction
                .execute(
                    "insert into source_fragments values (?1,?1,?2)",
                    (&source_id, format!("line-{link}")),
                )
                .unwrap();
            transaction
                .execute(
                    "insert into knowledge_source_links values (?1,?2,?3,?4)",
                    (
                        &id,
                        &source_id,
                        (link / 2) as f64,
                        format!("2026-09-{:02}", link + 1),
                    ),
                )
                .unwrap();
        }
    }
    transaction.commit().unwrap();
    connection
}

fn count_source_reads(connection: &Connection) -> Arc<AtomicUsize> {
    let count = Arc::new(AtomicUsize::new(0));
    let captured = Arc::clone(&count);
    connection.authorizer(Some(move |context: AuthContext<'_>| {
        if matches!(
            context.action,
            AuthAction::Read {
                table_name: "sources",
                column_name: "uri"
            }
        ) {
            captured.fetch_add(1, Ordering::SeqCst);
        }
        Authorization::Allow
    }));
    count
}

fn search(connection: &Connection, limit: usize, foundation: bool) -> Vec<PackKnowledge> {
    let identity = resolve_compile_project_identity(
        &CompileProjectIdentityInput::default(),
        CompileProjectIdentityTrust::RequestHint,
        None,
    )
    .unwrap();
    search_knowledge_items(
        connection,
        "sqlite",
        limit,
        &identity,
        &RepositoryRequestFacets::default(),
        foundation,
    )
    .unwrap()
}

fn legacy_refs(connection: &Connection, id: &str) -> Vec<String> {
    connection
        .prepare(
            "select s.uri, sf.locator from knowledge_source_links ksl
         join source_fragments sf on sf.id = ksl.source_fragment_id
         join sources s on s.id = sf.source_id
         where ksl.knowledge_id = ?1
         order by ksl.confidence desc, ksl.created_at desc limit 5",
        )
        .unwrap()
        .query_map([id], |row| {
            Ok(format!(
                "{}#{}",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn source_refs_preserve_per_item_order_limit_and_missing_links() {
    let connection = fixture(40, 8);
    connection
        .execute(
            "delete from knowledge_source_links where knowledge_id = 'k00000'",
            [],
        )
        .unwrap();
    for foundation in [false, true] {
        let items = search(&connection, 20, foundation);
        assert!(!items.is_empty());
        assert!(items[0].source_refs.is_empty());
        for item in &items {
            assert_eq!(
                item.source_refs,
                legacy_refs(&connection, &item.id),
                "{}",
                item.id
            );
            assert!(item.source_refs.len() <= 5);
        }
    }
}

#[test]
fn source_refs_are_loaded_only_for_retained_candidates_in_chunks() {
    let connection = fixture(1100, 1);
    let count = count_source_reads(&connection);
    let items = search(&connection, 600, false);
    assert_eq!(items.len(), 600);
    assert_eq!(items[0].id, "k00000");
    assert_eq!(items[599].id, "k00599");
    assert_eq!(
        count.load(Ordering::SeqCst),
        3,
        "one source query per 256 retained candidates"
    );
    assert!(items.iter().all(|item| item.source_refs.len() == 1));
}

#[test]
fn source_refs_do_not_query_for_zero_limit_and_tolerate_optional_tables() {
    let connection = fixture(5, 0);
    let count = count_source_reads(&connection);
    assert!(search(&connection, 0, false).is_empty());
    assert_eq!(count.load(Ordering::SeqCst), 0);
    connection
        .execute_batch(
            "drop table knowledge_source_links; drop table source_fragments; drop table sources;",
        )
        .unwrap();
    let items = search(&connection, 5, false);
    assert_eq!(items.len(), 5);
    assert!(items.iter().all(|item| item.source_refs.is_empty()));
}

#[test]
fn source_refs_ten_thousand_candidates_have_bounded_queries() {
    let connection = fixture(10_000, 1);
    let count = count_source_reads(&connection);
    let started = Instant::now();
    let items = search(&connection, 256, false);
    let elapsed = started.elapsed();
    let queries = count.load(Ordering::SeqCst);
    eprintln!(
        "source_refs_benchmark rows=10000 retained={} source_queries={queries} retrieval_ms={:.3}",
        items.len(),
        elapsed.as_secs_f64() * 1000.0
    );
    assert_eq!(items.len(), 256);
    assert_eq!(queries, 1);
}

#[test]
fn source_refs_reuse_the_callers_transaction_without_ending_it() {
    let connection = fixture(2, 1);
    let transaction = connection.unchecked_transaction().unwrap();
    transaction
        .execute("update sources set uri = 'file:///uncommitted'", [])
        .unwrap();
    let items = search(&transaction, 2, false);
    assert_eq!(items.len(), 2);
    assert!(items
        .iter()
        .all(|item| item.source_refs[0].starts_with("file:///uncommitted#")));
    assert!(!connection.is_autocommit());
    transaction.rollback().unwrap();
    assert!(connection.is_autocommit());
    assert!(search(&connection, 2, false)
        .iter()
        .all(|item| !item.source_refs[0].starts_with("file:///uncommitted#")));
    assert!(connection.is_autocommit());
}

#[test]
fn source_refs_share_the_candidate_snapshot_during_concurrent_writes() {
    let directory = super::test_support::temp_db_path().with_extension("snapshot-test");
    std::fs::create_dir_all(&directory).unwrap();
    let database_path = directory.join("core.sqlite");
    let seed = fixture(2, 1);
    seed.execute("vacuum into ?1", [database_path.to_str().unwrap()])
        .unwrap();
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute_batch("pragma journal_mode=WAL;")
        .unwrap();
    let writer = std::sync::Mutex::new(Connection::open(&database_path).unwrap());
    let mutated = Arc::new(AtomicUsize::new(0));
    let captured = Arc::clone(&mutated);
    connection.authorizer(Some(move |context: AuthContext<'_>| {
        if matches!(
            context.action,
            AuthAction::Read {
                table_name: "sources",
                column_name: "uri"
            }
        ) && captured.fetch_add(1, Ordering::SeqCst) == 0
        {
            writer
                .lock()
                .unwrap()
                .execute(
                    "update sources set uri = 'file:///changed-after-candidates'",
                    [],
                )
                .unwrap();
        }
        Authorization::Allow
    }));
    let items = search(&connection, 2, false);
    assert_eq!(mutated.load(Ordering::SeqCst), 1);
    assert_eq!(items[0].source_refs, vec!["file:///k00000-s0#line-0"]);
    assert_eq!(items[1].source_refs, vec!["file:///k00001-s0#line-0"]);
    assert!(connection.is_autocommit());
    // A later request observes the committed update, so no read transaction leaked.
    assert!(search(&connection, 2, false)
        .iter()
        .all(|item| item.source_refs[0].starts_with("file:///changed-after-candidates#")));
    drop(connection);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn snapshot_failure_is_an_error_instead_of_no_content() {
    let connection = fixture(1, 1);
    connection.authorizer(Some(|context: AuthContext<'_>| {
        if matches!(context.action, AuthAction::Transaction { .. }) {
            Authorization::Deny
        } else {
            Authorization::Allow
        }
    }));
    let identity = resolve_compile_project_identity(
        &CompileProjectIdentityInput::default(),
        CompileProjectIdentityTrust::RequestHint,
        None,
    )
    .unwrap();
    let result = search_knowledge_items(
        &connection,
        "sqlite",
        8,
        &identity,
        &RepositoryRequestFacets::default(),
        false,
    );
    assert!(result
        .unwrap_err()
        .contains("failed to start knowledge retrieval snapshot"));
}

#[test]
#[ignore = "controlled performance matrix; run without coverage instrumentation"]
fn source_ref_performance_matrix() {
    let filter = std::env::var("CONTEXT_STILL_BENCH_CASE").ok();
    for count in [1000, 10000] {
        for links in [0, 8] {
            let connection = fixture(count, links);
            let identity = resolve_compile_project_identity(
                &CompileProjectIdentityInput::default(),
                CompileProjectIdentityTrust::RequestHint,
                None,
            )
            .unwrap();
            for goal in [
                "sqlite",
                "日本語",
                "sqlite 日本語の本文を確認して検索結果と参照の一貫性を検証する",
            ] {
                if filter
                    .as_ref()
                    .is_some_and(|value| value != &format!("{count}/{links}/{goal}"))
                {
                    continue;
                }
                let mut samples = [Vec::new(), Vec::new()];
                let reads = count_source_reads(&connection);
                for iteration in 0..22 {
                    let mut snapshots = [String::new(), String::new()];
                    let order = if iteration % 2 == 0 { [0, 1] } else { [1, 0] };
                    for variant in order {
                        reads.store(0, Ordering::SeqCst);
                        let start = Instant::now();
                        let results = if variant == 0 {
                            super::retrieval_benchmark_reference::search_knowledge_items(
                                &connection,
                                goal,
                                256,
                                &identity,
                                &RepositoryRequestFacets::default(),
                                false,
                            )
                        } else {
                            search_knowledge_items(
                                &connection,
                                goal,
                                256,
                                &identity,
                                &RepositoryRequestFacets::default(),
                                false,
                            )
                            .unwrap()
                        };
                        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                        snapshots[variant] = serde_json::to_string(
                            &results
                                .iter()
                                .map(PackKnowledge::to_json)
                                .collect::<Vec<_>>(),
                        )
                        .unwrap();
                        assert_eq!(
                            reads.load(Ordering::SeqCst),
                            if variant == 0 { count } else { 1 }
                        );
                        if iteration > 0 {
                            samples[variant].push(elapsed);
                        }
                    }
                    assert_eq!(snapshots[0], snapshots[1]);
                }
                for values in &mut samples {
                    values.sort_by(f64::total_cmp);
                }
                println!(
                    "PERFORMANCE_JSON {}",
                    json!({"rows":count,"linksPerRow":links,"goal":goal,"iterations":21,"baselineSourceQueries":count,"sourceQueries":1,"baselineP50Ms":samples[0][10],"baselineP95Ms":samples[0][19],"p50Ms":samples[1][10],"p95Ms":samples[1][19],"scope":"global","seed":"sequential-fixed-v1","instrumentation":"none","phase":"retrieval_and_refs","baselineRevision":"ff77032","outputsEqual":true})
                );
            }
        }
    }
}
