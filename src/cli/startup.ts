import { existsSync } from "node:fs";
import path from "node:path";
import { onboardingPromptsText, promptStartupPlan } from "../modules/onboarding/startup-prompts.js";
import { runStartupSeq } from "../modules/onboarding/startup.service.js";

async function askConfirmApply(lang: "ja" | "en"): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const t = onboardingPromptsText[lang];
    rl.question(`\n${t.confirmApply} (y/n) [n]: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isApply = args.includes("--apply");
  const isDryRun = !isApply || args.includes("--dry-run");

  console.log("=========================================");
  console.log("    memory-router Interactive Onboarding");
  console.log("=========================================");
  if (isDryRun) {
    console.log("NOTE: Running in DRY-RUN mode by default.");
    console.log("No modifications will be made to files, Docker, or DB.");
    console.log("To apply changes, run: bun run startup -- --apply\n");
  } else {
    console.log("WARNING: Running in APPLY mode.");
    console.log("Files will be mutated and resources will be started.\n");
  }

  const plan = await promptStartupPlan(process.env);
  const lang = plan.lang;

  const envPath = path.resolve(process.cwd(), ".env");

  // If dry-run, we immediately execute dry-run sequence
  if (isDryRun) {
    const summary = await runStartupSeq(plan, { dryRun: true, envPath });
    console.log("\n=========================================");
    console.log("         [DRY RUN] EXECUTION PLAN");
    console.log("=========================================");
    console.log("\n--- Proposed .env Diff (Masked) ---");
    console.log(summary.envDiff || "(No changes)");

    console.log("\n--- Execution Steps ---");
    for (const step of summary.steps) {
      console.log(`[DRY] Step [${step.step}]: ${step.message}`);
    }

    console.log("\n=========================================");
    console.log("Dry-run completed successfully.");
    console.log("No modifications were written to disk.");
    console.log("To apply this plan, run: bun run startup -- --apply");
    console.log("=========================================");
    process.exit(0);
  }

  // If apply mode, we ask for confirmation first
  const confirmed = await askConfirmApply(lang);
  if (!confirmed) {
    console.log("\nApply cancelled by user. Exiting.");
    process.exit(0);
  }

  console.log("\nApplying plan...");
  const summary = await runStartupSeq(plan, { dryRun: false, envPath });

  console.log("\n=========================================");
  console.log("          APPLY EXECUTION RESULTS");
  console.log("=========================================");

  let hasFailed = false;
  for (const step of summary.steps) {
    const icon = step.status === "success" ? "✅" : step.status === "skipped" ? "⏭️" : "❌";
    console.log(`${icon} Step [${step.step}]: ${step.message}`);
    if (step.status === "failed") {
      hasFailed = true;
      if (step.details) {
        console.log(`   Details: ${step.details}`);
      }
    }
  }

  if (hasFailed || !summary.ok) {
    console.log("\n=========================================");
    console.log("❌ ONBOARDING COMPLETED WITH ERRORS");
    console.log("=========================================");
    console.log("Please fix the blocking errors mentioned above and try again.");
    process.exit(1);
  }

  console.log("\n=========================================");
  console.log("🎉 ONBOARDING SUCCESSFUL! SYSTEM IS READY");
  console.log("=========================================");
  if (summary.backupPath) {
    console.log(`Original .env backed up to: ${path.basename(summary.backupPath)}`);
  }

  console.log("\n--- MCP Client Configuration Snippet ---");
  console.log("Paste the following config into your MCP Client (e.g. Cursor, Claude Desktop):");
  console.log(summary.mcpSnippet);
  console.log("=========================================");
  process.exit(0);
}

main().catch((error) => {
  console.error("Fatal error during startup:", error);
  process.exit(1);
});
