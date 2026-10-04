import { randomUUID } from "node:crypto";
import { canonicalJsonSha256 } from "../../shared/utils/canonical-json.js";
import { exploreWithCodex } from "./codex-research.js";
import type { CodexResearchOutcome, CodexResearchOptions } from "./codex-research.contract.js";
import type { ManualResearchResult } from "./deepstill-client.js";
import type { SqliteCoreDatabase } from "../../db/sqlite/client.js";

const owner = `${process.pid}:${randomUUID()}`;
const active = new Map<string, AbortController>();

export function cancelCodexResearch(id: string): void {
  active.get(id)?.abort();
}

export function projectCodexResearch(outcome: CodexResearchOutcome): ManualResearchResult {
  return {
    report: {
      title: "Codex探索の候補",
      body: "",
      limitations: outcome.limitations,
      openQuestions: [],
    },
    claims: outcome.candidates.map((candidate, index) => ({
      id: `codex-${index}`,
      text: candidate.knowledge,
      evidenceIds: candidate.sources.map((_, source) => `codex-${index}-source-${source}`),
    })),
    evidence: outcome.candidates.flatMap((candidate, index) =>
      candidate.sources.map((source, n) => ({
        id: `codex-${index}-source-${n}`,
        quote: source.excerpt || source.location,
        sourceTitle: source.title,
        sourceUrl: source.url,
        // No local snapshot exists. Never invent a snapshot hash for a Codex assertion.
        snapshotHash: "",
      })),
    ),
    usage: {
      queries: outcome.observedWebSearches,
      urls: null,
      tokens: outcome.usageComplete
        ? (outcome.tokenUsage.inputTokens ?? 0) + (outcome.tokenUsage.outputTokens ?? 0)
        : null,
      requests: null,
      costUsd: null,
    },
    reason: outcome.termination,
    exploration: outcome,
  };
}

export async function reconcileCodexResearch(
  run: {
    id: string;
    topic: string;
    status: string;
    result: ManualResearchResult | null;
    codex: CodexResearchOptions | null;
  },
  db: SqliteCoreDatabase["db"],
): Promise<void> {
  if (!run.codex || active.has(run.id)) return;
  const cancelRequested = () =>
    db
      .query<{ cancel_requested: number }, [string]>(
        "SELECT cancel_requested FROM manual_research_runs WHERE id=?",
      )
      .get(run.id)?.cancel_requested === 1;
  if (run.status !== "created") {
    const lease = db
      .query<{ runtime_owner: string | null }, [string]>(
        "SELECT runtime_owner FROM manual_research_explorations WHERE run_id=?",
      )
      .get(run.id);
    if (lease?.runtime_owner === owner) return;
    const pid = Number(lease?.runtime_owner?.split(":")[0]);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
      }
    }
    // Process loss is terminal: restarting the API never purchases another exploration.
    const result = run.result;
    if (result?.exploration) {
      result.exploration.termination = "interrupted";
      result.exploration.usageComplete = false;
      result.reason = "interrupted";
    }
    db.query(
      "UPDATE manual_research_runs SET status='partial',sync_error='CODEX_PROCESS_INTERRUPTED',result_json=?,result_hash=?,updated_at=? WHERE id=? AND result_hash IS NULL",
    ).run(
      result ? JSON.stringify(result) : null,
      result ? canonicalJsonSha256(result) : null,
      new Date().toISOString(),
      run.id,
    );
    return;
  }
  const controller = new AbortController();
  db.exec("BEGIN IMMEDIATE");
  try {
    const claim = db
      .query(
        "UPDATE manual_research_runs SET status='running',updated_at=? WHERE id=? AND status='created'",
      )
      .run(new Date().toISOString(), run.id);
    if (claim.changes !== 1) {
      db.exec("COMMIT");
      return;
    }
    const lease = db
      .query("UPDATE manual_research_explorations SET runtime_owner=? WHERE run_id=?")
      .run(owner, run.id);
    if (lease.changes !== 1) throw new Error("CODEX_RESEARCH_CLAIM_NOT_CONFIRMED");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  active.set(run.id, controller);
  try {
    if (cancelRequested()) controller.abort();
    const outcome = await exploreWithCodex(run.topic, run.codex, {
      signal: controller.signal,
      onCheckpoint: async (checkpoint) => {
        const result = projectCodexResearch(checkpoint);
        result.reason = null;
        const now = new Date().toISOString();
        const saved = db
          .query(
            "UPDATE manual_research_runs SET result_json=?,updated_at=?,last_synced_at=? WHERE id=? AND result_hash IS NULL AND status='running'",
          )
          .run(JSON.stringify(result), now, now, run.id);
        if (saved.changes !== 1) throw new Error("CODEX_CHECKPOINT_NOT_CONFIRMED");
        if (cancelRequested()) controller.abort();
      },
    });
    const result = projectCodexResearch(outcome);
    const status =
      outcome.termination === "completed"
        ? "completed"
        : outcome.termination === "failed"
          ? "failed"
          : outcome.termination === "invalid_result"
            ? "invalid_result"
            : outcome.termination === "cancelled"
              ? "cancelled"
              : "partial";
    const now = new Date().toISOString();
    const saved = db
      .query(
        "UPDATE manual_research_runs SET status=?,result_json=?,result_hash=?,sync_error=NULL,updated_at=?,last_synced_at=? WHERE id=? AND result_hash IS NULL AND status='running'",
      )
      .run(status, JSON.stringify(result), canonicalJsonSha256(result), now, now, run.id);
    if (saved.changes !== 1) throw new Error("CODEX_RESULT_NOT_CONFIRMED");
  } catch (error) {
    db.query(
      "UPDATE manual_research_runs SET status='failed',sync_error='CODEX_RESULT_NOT_CONFIRMED',updated_at=? WHERE id=? AND result_hash IS NULL AND status='running'",
    ).run(new Date().toISOString(), run.id);
    throw error;
  } finally {
    active.delete(run.id);
  }
}
