import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("legacy claims and stale recovery exclude resident generations while retaining old schemas", () => {
  const script = `
    import {Database} from 'bun:sqlite';
    import {legacyProtocolPredicate} from './src/modules/queue/core/legacy-protocol.ts';
    const db=new Database(':memory:');
    db.exec("create table finding_candidate_queue(id text,protocol_version integer,status text); insert into finding_candidate_queue values('old',1,'pending'),('agent',3,'pending'),('future',4,'running'); create table covering_evidence_queue(id text); create table finalize_distille_queue(id text,protocol_version integer); insert into finalize_distille_queue values('old-final',1),('pinned-final',2);");
    const predicate=legacyProtocolPredicate(db,'findingCandidate');
    const picked=db.query("select id from finding_candidate_queue where status='pending' and "+predicate).all();
    db.exec("update finding_candidate_queue set status='paused' where status='running' and "+predicate);
    const native=db.query("select status from finding_candidate_queue where id='future'").get();
    const pinned=db.query("select id from finalize_distille_queue where "+legacyProtocolPredicate(db,'finalizeDistille')).all();
    console.log(JSON.stringify({picked,native,pinned,oldSchema:legacyProtocolPredicate(db,'coveringEvidence')}));
  `;
  const result = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: process.cwd() });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    picked: [{ id: "old" }],
    native: { status: "running" },
    pinned: [{ id: "old-final" }],
    oldSchema: "1 = 1",
  });
});

test("finding ingress preserves resident claims and budgets across duplicate enqueue and pin races", () => {
  const script = `
    import {Database} from 'bun:sqlite';
    import {enqueueSqliteFindingJob} from './src/modules/queue/core/finding-enqueue.ts';
    const db=new Database(':memory:');
    db.exec("create table finding_candidate_queue(id text primary key,input_kind text,source_kind text,source_key text,distillation_version text,source_uri text,payload text,metadata text,priority integer,status text,protocol_version integer default 1,locked_by text,locked_at text,heartbeat_at text,next_run_at text,completed_at text,created_at text,updated_at text,unique(input_kind,source_kind,source_key,distillation_version));");
    const input={inputKind:'source_target',sourceKind:'wiki_file',sourceKey:'s',sourceUri:'wiki://s',distillationVersion:'v1',priority:50};
    const first=enqueueSqliteFindingJob(db,input);
    db.exec("update finding_candidate_queue set protocol_version=3,status='running',locked_by='owner',payload='{\\\"original\\\":true}',metadata='{\\\"budget\\\":1234}'");
    const duplicate=enqueueSqliteFindingJob(db,{...input,payload:{replacement:true}});
    const running=db.query('select status,locked_by,payload,metadata from finding_candidate_queue').get();
    db.exec("update finding_candidate_queue set status='completed'");
    const terminal=enqueueSqliteFindingJob(db,input);
    db.exec("update finding_candidate_queue set protocol_version=1,status='running'");
    const legacyRunning=enqueueSqliteFindingJob(db,input);
    db.exec("update finding_candidate_queue set status='pending'");
    const proxy={query(sql){
      if(sql.startsWith('update finding_candidate_queue')) {
        db.exec("update finding_candidate_queue set protocol_version=3,status='running'");
      }
      return db.query(sql);
    }};
    const raced=enqueueSqliteFindingJob(proxy,input);
    const afterRace=db.query('select status,locked_by,payload,metadata from finding_candidate_queue').get();
    console.log(JSON.stringify({first:first.changed,duplicate:duplicate.changed,terminal:terminal.changed,terminalStatus:terminal.row.status,raced:raced.changed,legacyRunning:legacyRunning.changed,running,afterRace}));
  `;
  const result = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: process.cwd() });
  expect(result.status, result.stderr).toBe(0);
  const saved = {
    status: "running",
    locked_by: "owner",
    payload: '{"original":true}',
    metadata: '{"budget":1234}',
  };
  expect(JSON.parse(result.stdout)).toEqual({
    first: true,
    duplicate: false,
    terminal: false,
    terminalStatus: "completed",
    raced: false,
    legacyRunning: false,
    running: saved,
    afterRace: saved,
  });
});
