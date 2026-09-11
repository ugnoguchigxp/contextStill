use super::super::types::ProviderLeaseAssignment;
use super::*;

fn setup() -> (Connection, ClaimedProviderLeaseJob, Value) {
    crate::domains::vector_index::service::register_sqlite_vec();
    let mut connection = Connection::open_in_memory().unwrap();
    crate::domains::sqlite_writer::schema::migrate(&mut connection, 2).unwrap();
    connection.execute_batch("insert into knowledge_items(id,type,status,scope,classification_status,title,body) values
        ('subject','rule','active','global','classified','Subject','Use a transaction for related writes.'),
        ('canonical','rule','active','global','classified','Canonical','Commit related updates atomically.'),
        ('inactive','rule','deprecated','global','classified','Inactive','Old guidance');
        insert into knowledge_items_vec_fallback(knowledge_id,embedding_json,embedding_dimension,content_hash) values ('subject','[1,0]',2,'a'),('canonical','[0.99,0.01]',2,'b');").unwrap();
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 2);
    let id: String = connection.query_row(
        "select id from landscape_curation_queue where subject_knowledge_id='subject' order by created_at limit 1",
        [],
        |row| row.get(0),
    ).unwrap();
    connection
        .execute(
            "update landscape_curation_queue set status='running',locked_by='worker' where id=?1",
            [&id],
        )
        .unwrap();
    connection.execute("insert into llm_provider_leases(id,pool_id,target_id,queue_name,queue_job_id,worker_id,status,expires_at) values ('lease','pool','target',?1,?2,'worker','active',datetime('now','+10 minutes'))",params![QUEUE,id]).unwrap();
    let job = ClaimedProviderLeaseJob {
        queue_name: QUEUE.into(),
        id: id.clone(),
        provider_lease: ProviderLeaseAssignment {
            id: "lease".into(),
            pool_id: "pool".into(),
            target_id: "target".into(),
            queue_name: QUEUE.into(),
            queue_job_id: id.clone(),
            worker_id: "worker".into(),
        },
    };
    let snapshot = repository::capture(&connection, &id).unwrap();
    (connection, job, snapshot)
}
fn decision(kind: &str, snapshot: &Value) -> Decision {
    let survivor = "canonical";
    let retained = if kind == "merge" {
        vec!["subject:g0".into(), "canonical:g0".into()]
    } else {
        vec!["canonical:g0".into()]
    };
    let coverage = vec![
        Coverage {
            source_group_id: "subject:g0".into(),
            disposition: if kind == "merge" {
                "retained".into()
            } else {
                "entailed".into()
            },
            target_group_ids: if kind == "merge" {
                vec!["subject:g0".into()]
            } else {
                vec!["canonical:g0".into()]
            },
        },
        Coverage {
            source_group_id: "canonical:g0".into(),
            disposition: "retained".into(),
            target_group_ids: vec!["canonical:g0".into()],
        },
    ];
    let checks = json!({"obligations":"preserved","conditions":"preserved","negation":"preserved","exceptions":"preserved","numbersAndUnits":"preserved","identifiers":"preserved","ordering":"preserved","provenance":"preserved"});
    Decision {
        schema_version: 2,
        action: kind.into(),
        survivor_knowledge_id: Some(survivor.into()),
        deprecated_knowledge_ids: vec!["subject".into()],
        retained_group_ids: retained,
        coverage,
        reason_codes: vec![if kind == "merge" {
            "COMPLEMENTARY".into()
        } else {
            "COMPLETE_DUPLICATE".into()
        }],
        rationale: "Both express atomicity of related updates.".into(),
        verification: Some(Verification {
            schema_version: 2,
            verdict: "supported".into(),
            input_hash: repository::hash(&repository::canonical_json(snapshot)),
            findings: vec![
                VerificationFinding {
                    source_group_id: "subject:g0".into(),
                    target_group_ids: if kind == "merge" {
                        vec!["subject:g0".into()]
                    } else {
                        vec!["canonical:g0".into()]
                    },
                    checks: checks.clone(),
                },
                VerificationFinding {
                    source_group_id: "canonical:g0".into(),
                    target_group_ids: vec!["canonical:g0".into()],
                    checks,
                },
            ],
            no_new_meaning: "preserved".into(),
            no_unresolved_contradiction: "preserved".into(),
            rationale: "All source groups and conditions remain available.".into(),
        }),
    }
}
fn status(connection: &Connection, id: &str) -> String {
    connection
        .query_row(
            "select status from knowledge_items where id=?1",
            [id],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn queues_every_active_knowledge_once_including_without_candidates() {
    let (connection, _, _) = setup();
    let before = repository::load_knowledge(&connection, "subject")
        .unwrap()
        .unwrap()["contentRevision"]
        .clone();
    let queued: (String,String) = connection.query_row("select evidence_hash,prompt_version from landscape_curation_queue where subject_knowledge_id='subject'", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(queued.0, before.as_str().unwrap());
    assert_eq!(queued.1, VERSION);
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 0);
    connection
        .execute("update landscape_curation_queue set status='completed'", [])
        .unwrap();
    connection
        .execute(
            "update knowledge_items set body='changed',updated_at=CURRENT_TIMESTAMP",
            [],
        )
        .unwrap();
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 2);
    connection.execute("insert into knowledge_items(id,type,status,scope,classification_status,title,body) values ('new','rule','active','global','classified','New','No embedding')",[]).unwrap();
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 1);
    assert_eq!(
        repository::capture(
            &connection,
            connection
                .query_row(
                    "select id from landscape_curation_queue where subject_knowledge_id='new'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap()
                .as_str()
        )
        .unwrap()["candidates"],
        json!([])
    );
}

#[test]
fn finds_semantic_candidates_and_excludes_other_repositories_and_polarities() {
    let (connection, job, snapshot) = setup();
    assert_eq!(snapshot["candidates"].as_array().unwrap().len(), 1);
    assert!(snapshot["candidates"][0]["similarity"].as_f64().unwrap() > 0.99);
    connection
        .execute("update knowledge_items set scope='repo',repo_key=id", [])
        .unwrap();
    assert_eq!(
        repository::capture(&connection, &job.id).unwrap()["candidates"],
        json!([])
    );
    connection.execute("update knowledge_items set scope='global',polarity=case when id='canonical' then 'negative' else 'positive' end",[]).unwrap();
    assert_eq!(
        repository::capture(&connection, &job.id).unwrap()["candidates"],
        json!([])
    );
}

#[test]
fn queues_exact_candidates_without_embeddings() {
    let (connection, job, snapshot) = setup();
    connection
        .execute("delete from knowledge_items_vec_fallback", [])
        .unwrap();
    connection
        .execute(
            "update knowledge_items set body=?1 where id='canonical'",
            [snapshot["subject"]["body"].as_str().unwrap()],
        )
        .unwrap();
    let captured = repository::capture(&connection, &job.id).unwrap();
    assert_eq!(captured["candidates"].as_array().unwrap().len(), 1);
    assert_eq!(captured["candidates"][0]["id"], "canonical");
    assert_eq!(captured["candidates"][0]["similarity"], 1.0);
}

#[test]
fn deprecates_semantic_duplicate_and_preserves_lineage_and_rollback() {
    let (mut connection, job, snapshot) = setup();
    connection.execute("insert into knowledge_origin_links(id,knowledge_id,origin_kind,origin_uri,origin_key,confidence) values ('origin','subject','manual','test://source','source',90)",[]).unwrap();
    assert!(persist(
        &mut connection,
        &job,
        &snapshot,
        Ok((decision("deprecate_duplicate", &snapshot), None))
    )
    .unwrap());
    assert_eq!(status(&connection, "subject"), "deprecated");
    assert_eq!(status(&connection, "canonical"), "active");
    assert_eq!(
        repository::load_knowledge(&connection, "canonical")
            .unwrap()
            .unwrap()["body"],
        snapshot["candidates"][0]["body"]
    );
    let lineage: i64 = connection
        .query_row(
            "select count(*) from knowledge_origin_links where knowledge_id='canonical'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(lineage, 1);
    let rollback: String = connection
        .query_row(
            "select rollback_snapshot from landscape_curation_queue where id=?1",
            [&job.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&rollback).unwrap()["deprecated"]["status"],
        "active"
    );
    assert!(!persist(
        &mut connection,
        &job,
        &snapshot,
        Ok((decision("deprecate_duplicate", &snapshot), None))
    )
    .unwrap());
}

#[test]
fn merges_body_embedding_and_deprecation_atomically() {
    let (mut connection, job, snapshot) = setup();
    let result = decision("merge", &snapshot);
    assert!(persist(
        &mut connection,
        &job,
        &snapshot,
        Ok((result.clone(), Some(vec![0.8, 0.2])))
    )
    .unwrap());
    assert_eq!(status(&connection, "subject"), "deprecated");
    let canonical = repository::load_knowledge(&connection, "canonical")
        .unwrap()
        .unwrap();
    assert_eq!(
        canonical["body"],
        json!("Use a transaction for related writes.\n\nCommit related updates atomically.")
    );
    assert_eq!(
        canonical["sourceGroups"],
        json!([
            {"id":"subject:g0","text":"Use a transaction for related writes.","hash":repository::hash("Use a transaction for related writes."),"order":0},
            {"id":"canonical:g0","text":"Commit related updates atomically.","hash":repository::hash("Commit related updates atomically."),"order":1}
        ])
    );
    let fts: String = connection
        .query_row(
            "select body from knowledge_items_fts where id='canonical'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fts, canonical["body"].as_str().unwrap());
    let vector:String=connection.query_row("select embedding_json from knowledge_items_vec_fallback where knowledge_id='canonical'",[],|r|r.get(0)).unwrap();
    assert_eq!(vector, "[0.8,0.2]");
}

#[test]
fn stale_input_low_confidence_and_conflicting_scope_do_not_mutate() {
    for case in ["stale", "confidence", "scope", "counter_evidence"] {
        let (mut connection, job, mut snapshot) = setup();
        let mut result = decision("deprecate_duplicate", &snapshot);
        match case {
            "stale" => {
                connection
                    .execute(
                        "update knowledge_items set body='new guidance' where id='canonical'",
                        [],
                    )
                    .unwrap();
            }
            "confidence" => result.verification.as_mut().unwrap().verdict = "unknown".into(),
            "scope" => snapshot["subject"]["appliesTo"] = json!({"path":"private"}),
            _ => result.verification.as_mut().unwrap().no_new_meaning = "unknown".into(),
        }
        persist(&mut connection, &job, &snapshot, Ok((result, None))).unwrap();
        assert_eq!(status(&connection, "subject"), "active", "{case}");
        let queue_status: String = connection
            .query_row(
                "select status from landscape_curation_queue where id=?1",
                [&job.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(queue_status, "skipped");
    }
}

#[test]
fn rejects_lossy_verification_and_preserves_reverse_direction_lineage() {
    let (mut connection, job, snapshot) = setup();
    let mut lossy = decision("merge", &snapshot);
    lossy.verification.as_mut().unwrap().findings[0].checks["exceptions"] = json!("not_preserved");
    persist(
        &mut connection,
        &job,
        &snapshot,
        Ok((lossy, Some(vec![0.8, 0.2]))),
    )
    .unwrap();
    assert_eq!(status(&connection, "subject"), "active");

    let (mut connection, job, snapshot) = setup();
    let mut reverse = decision("deprecate_duplicate", &snapshot);
    reverse.survivor_knowledge_id = Some("subject".into());
    reverse.deprecated_knowledge_ids = vec!["canonical".into()];
    reverse.retained_group_ids = vec!["subject:g0".into()];
    reverse.coverage[0].target_group_ids = vec!["subject:g0".into()];
    reverse.coverage[1].disposition = "entailed".into();
    reverse.coverage[1].target_group_ids = vec!["subject:g0".into()];
    let verification = reverse.verification.as_mut().unwrap();
    verification.findings[0].target_group_ids = vec!["subject:g0".into()];
    verification.findings[1].target_group_ids = vec!["subject:g0".into()];
    verification.input_hash = repository::hash(&repository::canonical_json(&snapshot));
    assert!(persist(&mut connection, &job, &snapshot, Ok((reverse, None))).unwrap());
    assert_eq!(status(&connection, "canonical"), "deprecated");
    let supersession: String = connection.query_row("select survivor_knowledge_id from knowledge_supersessions where deprecated_knowledge_id='canonical'", [], |row| row.get(0)).unwrap();
    assert_eq!(supersession, "subject");
    let audit: (String, String) = connection.query_row("select proposal_hash,verification_hash from curation_mutations where curation_job_id=?1", [&job.id], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
    assert_eq!((audit.0.len(), audit.1.len()), (64, 64));
}

#[test]
fn provider_failure_and_missing_embedding_never_partially_mutate() {
    let (mut connection, job, snapshot) = setup();
    assert!(persist(
        &mut connection,
        &job,
        &snapshot,
        Ok((decision("merge", &snapshot), None))
    )
    .is_err());
    assert_eq!(status(&connection, "subject"), "active");
    assert!(!persist(
        &mut connection,
        &job,
        &snapshot,
        Err("embedding daemon request failed: connection refused".into())
    )
    .unwrap());
    let state: (String, i64) = connection
        .query_row(
            "select status,attempt_count from landscape_curation_queue where id=?1",
            [&job.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, ("pending".into(), 0));
    let retry_event: i64 = connection.query_row(
        "select count(*) from distillation_queue_events where queue_name='landscapeCuration' and queue_job_id=?1 and event_type='retried'",
        [&job.id],|row|row.get(0),
    ).unwrap();
    assert_eq!(retry_event, 1);
    assert_eq!(
        repository::load_knowledge(&connection, "canonical")
            .unwrap()
            .unwrap()["body"],
        snapshot["candidates"][0]["body"]
    );
}

#[test]
fn identityless_repo_jobs_finish_in_preflight_without_attempt_or_provider() {
    let (connection, job, _) = setup();
    connection.execute(
        "update knowledge_items set scope='repo',repo_key=null,repo_path=null,project_ref=null where id='subject'",
        [],
    ).unwrap();
    connection
        .execute(
            "update landscape_curation_queue set status='pending',locked_by=null where id=?1",
            [&job.id],
        )
        .unwrap();
    connection
        .execute("delete from llm_provider_leases", [])
        .unwrap();

    assert_eq!(
        repository::preflight_identityless_pending(&connection, 10).unwrap(),
        1
    );
    let state: (String,i64,String) = connection.query_row(
        "select status,attempt_count,last_outcome_kind from landscape_curation_queue where id=?1",
        [&job.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).unwrap();
    assert_eq!(state, ("skipped".into(), 0, "identity_unavailable".into()));
    let events: i64 = connection.query_row(
        "select count(*) from distillation_queue_events where queue_job_id=?1 and event_type='skipped'",
        [&job.id],|row|row.get(0),
    ).unwrap();
    assert_eq!(events, 1);
    let outcome: String = connection
        .query_row(
            "select outcome from curation_review_ledger where curation_job_id=?1",
            [&job.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(outcome, "needs_evidence");
}

#[test]
fn curation_classification_only_change_resumes_once_without_changing_revision() {
    let (connection, _, _) = setup();
    connection.execute("insert into knowledge_items(id,type,status,scope,title,body,repo_path) values ('waiting','rule','active','repo','Wait','Evidence','/work/a')",[]).unwrap();
    repository::enqueue_all(&connection).unwrap();
    let revision = repository::load_knowledge(&connection, "waiting")
        .unwrap()
        .unwrap()["contentRevision"]
        .clone();
    let state:(String,i64) = connection.query_row("select status,attempt_count from landscape_curation_queue where subject_knowledge_id='waiting'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(state, ("skipped".into(), 0));
    connection
        .execute(
            "update knowledge_items set classification_status='classified' where id='waiting'",
            [],
        )
        .unwrap();
    assert_eq!(
        repository::load_knowledge(&connection, "waiting")
            .unwrap()
            .unwrap()["contentRevision"],
        revision
    );
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 1);
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 0);
    let state:(String,i64) = connection.query_row("select status,attempt_count from landscape_curation_queue where subject_knowledge_id='waiting'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(state, ("pending".into(), 0));
    connection
        .execute(
            "update knowledge_items set classification_status='unresolved' where id='waiting'",
            [],
        )
        .unwrap();
    repository::preflight_identityless_pending(&connection, 10).unwrap();
    connection
        .execute(
            "update knowledge_items set classification_status='classified' where id='waiting'",
            [],
        )
        .unwrap();
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 1);
    assert_eq!(repository::enqueue_all(&connection).unwrap(), 0);
}

#[test]
fn curation_does_not_record_stale_classification_as_reviewed_after_llm_returns() {
    let (mut connection, job, snapshot) = setup();
    let result = Decision {
        schema_version: 2,
        action: "keep_separate".into(),
        survivor_knowledge_id: None,
        deprecated_knowledge_ids: vec![],
        retained_group_ids: vec![],
        coverage: vec![],
        reason_codes: vec!["DISTINCT".into()],
        rationale: "Keep separate.".into(),
        verification: None,
    };
    connection
        .execute(
            "update knowledge_items set classification_status='unresolved' where id='subject'",
            [],
        )
        .unwrap();
    persist(&mut connection, &job, &snapshot, Ok((result, None))).unwrap();
    let state:(String,String)=connection.query_row("select q.last_outcome_kind,l.outcome from landscape_curation_queue q join curation_review_ledger l on l.curation_job_id=q.id where q.id=?1",[&job.id],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(
        state,
        ("identity_unavailable".into(), "needs_evidence".into())
    );
}

fn identity_source(connection: &Connection, id: &str, knowledge: &str, path: &str) {
    connection.execute("insert into sources(id,source_kind,uri,body,scope,classification_status,repo_path) values (?1,'file',?1,'Evidence','repo','classified',?2)",params![id,path]).unwrap();
    connection.execute("insert into source_fragments(id,source_id,locator,content) values (?1,?1,'whole','Evidence')",[id]).unwrap();
    connection.execute("insert into knowledge_source_links(id,knowledge_id,source_fragment_id) values (?1,?2,?1)",params![id,knowledge]).unwrap();
}

fn expire_identity_scan(connection: &Connection) {
    connection.execute("update settings set updated_at='2000-01-01',value='{}' where namespace='curation' and key='identity_reconciliation'",[]).unwrap();
}

#[test]
fn curation_recovers_source_and_vibe_origins_then_blocks_conflicting_evidence() {
    let (connection, _, _) = setup();
    connection.execute_batch("insert into knowledge_items(id,type,status,scope,title,body) values
      ('source-owner','rule','active','repo','Source','Source derived'),
      ('vibe-owner','rule','active','repo','Vibe','Vibe derived');
      insert into vibe_memories(id,session_id,content,metadata) values ('memory','session','Evidence','{\"projectRoot\":\"/work/a\"}');
      insert into knowledge_origin_links(id,knowledge_id,origin_kind,origin_uri,origin_key) values ('origin','vibe-owner','vibe_memory','vibe://memory','memory');").unwrap();
    identity_source(&connection, "source-a", "source-owner", "/work/a");
    repository::enqueue_all(&connection).unwrap();
    assert_eq!(
        super::super::curation_identity::reconcile(&connection, 500).unwrap(),
        2
    );
    for id in ["source-owner", "vibe-owner"] {
        let item = repository::load_knowledge(&connection, id)
            .unwrap()
            .unwrap();
        assert_eq!(item["classificationStatus"], "classified");
        assert_eq!(item["repoPath"], "/work/a");
        let pending:i64 = connection.query_row("select count(*) from landscape_curation_queue where subject_knowledge_id=?1 and status='pending'",[id],|r|r.get(0)).unwrap();
        assert_eq!(pending, 1);
    }
    expire_identity_scan(&connection);
    assert_eq!(
        super::super::curation_identity::reconcile(&connection, 500).unwrap(),
        0
    );
    identity_source(&connection, "source-b", "source-owner", "/work/b");
    expire_identity_scan(&connection);
    assert_eq!(
        super::super::curation_identity::reconcile(&connection, 500).unwrap(),
        1
    );
    let item = repository::load_knowledge(&connection, "source-owner")
        .unwrap()
        .unwrap();
    assert_eq!(item["classificationStatus"], "conflict");
    assert_eq!(item["repoPath"], "/work/a");
    let pending:i64=connection.query_row("select count(*) from landscape_curation_queue where subject_knowledge_id='source-owner' and status='pending'",[],|r|r.get(0)).unwrap();
    assert_eq!(pending, 0);
}

#[test]
fn curation_recovery_rolls_back_identity_and_enqueue_when_audit_fails() {
    let (connection, _, _) = setup();
    connection.execute("insert into knowledge_items(id,type,status,scope,title,body) values ('recover','rule','active','repo','Recover','Evidence')",[]).unwrap();
    identity_source(&connection, "source", "recover", "/work/a");
    connection.execute_batch("create trigger fail_identity_audit before insert on audit_logs when NEW.event_type='CURATION_IDENTITY_RECOVERY' begin select raise(ABORT,'test audit failure'); end;").unwrap();
    assert!(super::super::curation_identity::reconcile(&connection, 500).is_err());
    let item = repository::load_knowledge(&connection, "recover")
        .unwrap()
        .unwrap();
    assert_eq!(item["classificationStatus"], "unresolved");
    assert!(item["repoPath"].is_null());
    connection
        .execute_batch("drop trigger fail_identity_audit;")
        .unwrap();
    assert_eq!(
        super::super::curation_identity::reconcile(&connection, 500).unwrap(),
        1
    );
}

#[test]
fn curation_recovery_normalizes_verified_aliases_and_never_replaces_conflicting_identity() {
    let (connection, _, _) = setup();
    connection.execute_batch("insert into knowledge_items(id,type,status,scope,title,body,repo_key) values
        ('aliased','rule','active','repo','Alias','Evidence','ORG/A');
        insert into project_identity_aliases(id,project_ref,alias_kind,normalized_value,source) values
        ('alias-key','project-a','repo_key','org/a','test'),('alias-path','project-a','repo_path','/work/a','test');").unwrap();
    identity_source(&connection, "source", "aliased", "/work/a");
    super::super::curation_identity::reconcile(&connection, 500).unwrap();
    let item = repository::load_knowledge(&connection, "aliased")
        .unwrap()
        .unwrap();
    assert_eq!(item["classificationStatus"], "classified");
    assert_eq!(item["repoKey"], "org/a");
    assert_eq!(item["projectRef"], "project-a");
    connection
        .execute(
            "update project_identity_aliases set project_ref='project-b' where id='alias-path'",
            [],
        )
        .unwrap();
    expire_identity_scan(&connection);
    super::super::curation_identity::reconcile(&connection, 500).unwrap();
    let item = repository::load_knowledge(&connection, "aliased")
        .unwrap()
        .unwrap();
    assert_eq!(item["classificationStatus"], "conflict");
    assert_eq!(item["projectRef"], "project-a");
}

#[test]
fn curation_identity_cursor_does_not_starve_recoverable_rows() {
    let (connection, _, _) = setup();
    connection
        .execute_batch(
            "insert into knowledge_items(id,type,status,scope,title,body) values
      ('aaa-unknown','rule','active','repo','Unknown','/work/a in free text'),
      ('zzz-recover','rule','active','repo','Recover','Evidence');",
        )
        .unwrap();
    identity_source(&connection, "source", "zzz-recover", "/work/a");
    assert_eq!(
        super::super::curation_identity::reconcile(&connection, 1).unwrap(),
        0
    );
    connection
        .execute(
            "update settings set updated_at='2000-01-01' where namespace='curation'",
            [],
        )
        .unwrap();
    assert_eq!(
        super::super::curation_identity::reconcile(&connection, 1).unwrap(),
        1
    );
    let item = repository::load_knowledge(&connection, "aaa-unknown")
        .unwrap()
        .unwrap();
    assert_eq!(item["classificationStatus"], "unresolved");
}

#[test]
#[ignore = "explicit recovery evaluation on a temporary SQLite backup; no provider calls"]
fn curation_identity_evaluate_temporary_snapshot() {
    let path =
        std::path::PathBuf::from(std::env::var("CONTEXT_STILL_CURATION_RECOVERY_TEST_DB").unwrap())
            .canonicalize()
            .unwrap();
    let temp = std::env::temp_dir().canonicalize().unwrap();
    assert!(path.starts_with(temp) && path.file_name().unwrap() == "snapshot.sqlite");
    crate::domains::vector_index::service::register_sqlite_vec();
    let connection = Connection::open(&path).unwrap();
    fn counts(connection: &Connection) -> Value {
        let mut statement = connection.prepare("select classification_status,count(*) from knowledge_items where status='active' and scope='repo' group by classification_status order by classification_status").unwrap();
        let rows = statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let pending: i64 = connection
            .query_row(
                "select count(*) from landscape_curation_queue where status='pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let reviewed:i64=connection.query_row("select count(*) from curation_review_ledger where outcome='reviewed' and curation_job_id in (select id from landscape_curation_queue where last_outcome_kind in ('identity_unavailable','identity_conflict'))",[],|r|r.get(0)).unwrap();
        json!({"classifications":rows,"pending":pending,"identityIncorrectlyReviewed":reviewed})
    }
    let before = counts(&connection);
    expire_identity_scan(&connection);
    let mut changed = 0;
    let mut done = false;
    for _ in 0..100 {
        changed += super::super::curation_identity::reconcile(&connection, 500).unwrap();
        let cursor:String=connection.query_row("select json_extract(value,'$.cursor') from settings where namespace='curation' and key='identity_reconciliation'",[],|r|r.get(0)).unwrap();
        if cursor.is_empty() {
            done = true;
            break;
        }
        connection.execute("update settings set updated_at='2000-01-01' where namespace='curation' and key='identity_reconciliation'",[]).unwrap();
    }
    assert!(done);
    println!(
        "{}",
        json!({"before":before,"after":counts(&connection),"changedKnowledge":changed})
    );
}

#[test]
fn no_candidate_finishes_without_llm_or_semantic_attempt() {
    let (mut connection, job, _) = setup();
    connection
        .execute(
            "update knowledge_items set status='deprecated' where id='canonical'",
            [],
        )
        .unwrap();
    let snapshot = repository::capture(&connection, &job.id).unwrap();
    assert_eq!(snapshot["candidates"], json!([]));

    assert!(persist_preflight_skip(&mut connection, &job, &snapshot, "no_candidate").unwrap());
    let state: (String,i64,String)=connection.query_row(
        "select status,attempt_count,last_outcome_kind from landscape_curation_queue where id=?1",
        [&job.id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
    ).unwrap();
    assert_eq!(state, ("skipped".into(), 0, "no_candidate".into()));
    let lease: (String, String) = connection
        .query_row(
            "select status,release_reason from llm_provider_leases where id='lease'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(lease, ("released".into(), "worker_finished".into()));
}

#[test]
fn stale_revision_finishes_in_preflight_without_semantic_attempt() {
    let (mut connection, job, _) = setup();
    connection
        .execute(
            "update knowledge_items set body='new revision',updated_at=CURRENT_TIMESTAMP where id='subject'",
            [],
        )
        .unwrap();
    let snapshot = repository::capture(&connection, &job.id).unwrap();
    assert_ne!(
        snapshot["subject"]["contentRevision"],
        snapshot["queuedContentRevision"]
    );

    assert!(persist_preflight_skip(&mut connection, &job, &snapshot, "stale_subject").unwrap());
    let state: (String, i64, String) = connection
        .query_row(
            "select status,attempt_count,last_outcome_kind from landscape_curation_queue where id=?1",
            [&job.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(state, ("skipped".into(), 0, "stale_subject".into()));
}

#[test]
fn curation_retry_classifier_separates_infrastructure_from_model_contracts() {
    for error in [
        "curation provider request failed: connection refused",
        "curation provider HTTP 503",
        r#"agent session HTTP 409: {"retryable":true,"retry_after_seconds":42}"#,
        "local-llm agent session stopped at turn.failed",
        "embedding daemon request failed: timed out",
    ] {
        assert!(classify_curation_error(error).is_retryable(), "{error}");
    }
    assert!(!classify_curation_error("invalid curation JSON").is_retryable());
    assert!(
        !classify_curation_error("curation explanation exceeds result schema bounds")
            .is_retryable()
    );
    assert_eq!(
        retry_after_seconds(r#"{"retry_after_seconds":42}"#),
        Some(42)
    );
}

#[test]
fn refuses_unknown_references_and_invalid_or_empty_llm_results() {
    let (_, _, mut snapshot) = setup();
    assert!(parse_decision("{}", &snapshot).is_err());
    assert!(parse_decision("null", &snapshot).is_err());
    let mut result = decision("deprecate_duplicate", &snapshot);
    result.survivor_knowledge_id = Some("unknown".into());
    assert!(parse_decision(&serde_json::to_string(&result).unwrap(), &snapshot).is_err());
    result.survivor_knowledge_id = Some("canonical".into());
    result.coverage.pop();
    assert!(parse_decision(&serde_json::to_string(&result).unwrap(), &snapshot).is_err());
    let mut third = snapshot["candidates"][0].clone();
    third["id"] = json!("third");
    third["sourceGroups"][0]["id"] = json!("third:g0");
    snapshot["candidates"].as_array_mut().unwrap().push(third);
    let mut unrelated = decision("deprecate_duplicate", &snapshot);
    unrelated.survivor_knowledge_id = Some("canonical".into());
    unrelated.deprecated_knowledge_ids = vec!["third".into()];
    unrelated.retained_group_ids = vec!["canonical:g0".into()];
    unrelated.coverage = vec![
        Coverage {
            source_group_id: "subject:g0".into(),
            disposition: "entailed".into(),
            target_group_ids: vec!["canonical:g0".into()],
        },
        Coverage {
            source_group_id: "third:g0".into(),
            disposition: "entailed".into(),
            target_group_ids: vec!["canonical:g0".into()],
        },
    ];
    assert!(parse_decision(&serde_json::to_string(&unrelated).unwrap(), &snapshot).is_err());
}

#[test]
fn runs_claimed_curation_through_http_provider_and_durable_completion() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    let (connection, job, _) = setup();
    let directory = super::super::test_support::temp_app_dir("curation-http");
    let path = directory.join("core.sqlite");
    connection
        .execute("vacuum into ?1", [path.to_string_lossy().as_ref()])
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        for request_number in 0..2 {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let request: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(request["response_format"]["type"], "json_schema");
            assert_eq!(
                request["response_format"]["json_schema"]["name"],
                if request_number == 0 {
                    "curation"
                } else {
                    "curation_verify"
                }
            );
            let input: Value =
                serde_json::from_str(request["messages"][1]["content"].as_str().unwrap()).unwrap();
            let content = if request_number == 0 {
                assert_eq!(input["subject"]["id"], "subject");
                assert_eq!(input["candidates"][0]["id"], "canonical");
                serde_json::to_string(&decision("deprecate_duplicate", &input)).unwrap()
            } else {
                let input_hash = input["inputHash"].as_str().unwrap();
                json!({"schemaVersion":2,"verdict":"supported","inputHash":input_hash,"findings":[
                    {"sourceGroupId":"subject:g0","targetGroupIds":["canonical:g0"],"checks":{"obligations":"preserved","conditions":"preserved","negation":"preserved","exceptions":"preserved","numbersAndUnits":"preserved","identifiers":"preserved","ordering":"preserved","provenance":"preserved"}},
                    {"sourceGroupId":"canonical:g0","targetGroupIds":["canonical:g0"],"checks":{"obligations":"preserved","conditions":"preserved","negation":"preserved","exceptions":"preserved","numbersAndUnits":"preserved","identifiers":"preserved","ordering":"preserved","provenance":"preserved"}}
                ],"noNewMeaning":"preserved","noUnresolvedContradiction":"preserved","rationale":"All constraints are preserved."}).to_string()
            };
            let response =
                json!({"choices":[{"finish_reason":"stop","message":{"content":content}}]})
                    .to_string();
            write!(reader.get_mut(),"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
        }
    });
    let target = LocalLlmTargetConfig {
        target_id: "target".into(),
        api_base_url: format!("http://{address}/v1"),
        api_path: "/v1/chat/completions".into(),
        model: "test".into(),
    };
    let embedding = FinalizeEmbeddingConfig {
        provider: "disabled".into(),
        daemon_url: String::new(),
        access_token: None,
        timeout_seconds: 1,
        expected_dimension: Some(2),
        openai_api_base_url: None,
        openai_api_version: None,
        openai_model: None,
        openai_api_key: None,
    };
    let executed = run_for_path(&path, job.clone(), target, None, 30, embedding).unwrap();
    if !executed {
        let debug = open_query_only_connection(&path).unwrap()
            .query_row("select decision,policy_result,postcheck_result,last_error from landscape_curation_queue where id=?1", [&job.id], |row| Ok((row.get::<_,Option<String>>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?,row.get::<_,Option<String>>(3)?)))
            .unwrap();
        panic!("curation execution was blocked: {debug:?}");
    }
    server.join().unwrap();
    let reader = open_query_only_connection(&path).unwrap();
    assert_eq!(status(&reader, "subject"), "deprecated");
    let row: (String, String) = reader
        .query_row(
            "select status,phase from landscape_curation_queue where id=?1",
            [job.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, ("completed".into(), "postcheck".into()));
    drop(reader);
    std::fs::remove_dir_all(directory).unwrap();
}

#[path = "curation_evaluation.rs"]
mod evaluation;
