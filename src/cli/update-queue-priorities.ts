import { sql } from "drizzle-orm";
import { db, closeDbPool } from "../db/index.js";

async function main() {
  console.log("Starting queue priority update batch job...");

  console.log("1. Updating finding_candidate_queue...");
  const findingResult = await db.execute(sql`
    update finding_candidate_queue
    set priority = case
      when source_kind = 'knowledge_candidate' then 90
      when source_kind = 'web_ingest' then 80
      when source_kind = 'wiki_file' then 70
      else 50
    end
    where status in ('pending', 'paused', 'failed')
  `);
  console.log(`Updated ${findingResult.rowCount} jobs in finding_candidate_queue.`);

  console.log("2. Updating covering_evidence_queue...");
  const coveringResult = await db.execute(sql`
    update covering_evidence_queue q
    set priority = case
      when fq.source_kind = 'knowledge_candidate' then 90
      when fq.source_kind = 'web_ingest' then 80
      when fq.source_kind = 'wiki_file' then 70
      else 50
    end
    from found_candidates c
    join finding_candidate_queue fq on fq.id = c.finding_job_id
    where q.found_candidate_id = c.id
      and q.status in ('pending', 'paused', 'failed')
  `);
  console.log(`Updated ${coveringResult.rowCount} jobs in covering_evidence_queue.`);

  console.log("3. Updating premium_covering_evidence_queue...");
  const premiumResult = await db.execute(sql`
    update premium_covering_evidence_queue q
    set priority = case
      when fq.source_kind = 'knowledge_candidate' then 90
      when fq.source_kind = 'web_ingest' then 80
      when fq.source_kind = 'wiki_file' then 70
      else 50
    end
    from found_candidates c
    join finding_candidate_queue fq on fq.id = c.finding_job_id
    where q.found_candidate_id = c.id
      and q.status in ('pending', 'paused', 'failed')
  `);
  console.log(`Updated ${premiumResult.rowCount} jobs in premium_covering_evidence_queue.`);

  console.log("4. Updating finalize_distille_queue...");
  const finalizeResult = await db.execute(sql`
    update finalize_distille_queue q
    set priority = case
      when fq.source_kind = 'knowledge_candidate' then 90
      when fq.source_kind = 'web_ingest' then 80
      when fq.source_kind = 'wiki_file' then 70
      else 50
    end
    from evidence_coverage_results e
    join found_candidates c on c.id = e.found_candidate_id
    join finding_candidate_queue fq on fq.id = c.finding_job_id
    where q.evidence_result_id = e.id
      and q.status in ('pending', 'paused', 'failed')
  `);
  console.log(`Updated ${finalizeResult.rowCount} jobs in finalize_distille_queue.`);

  console.log("All queue priorities updated successfully!");
}

main()
  .catch((error) => {
    console.error("Error running priority update batch job:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
