import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { detectDockerComposeRunner } from "../../cli/onboarding/checks.js";
import { type SetupCommandResult, runSetupCommand } from "../../cli/onboarding/command-runner.js";
import { closeDbPool } from "../../db/index.js";
import { runDoctor } from "../doctor/doctor.service.js";
import { buildEnvDiff, writeEnv } from "./env-writer.js";
import { checkPlanLlmHealth } from "./llm-health.service.js";
import type { StartupPlan } from "./onboarding.types.js";

export async function validateDatabaseConnection(
  url: string,
): Promise<{ ok: boolean; error?: string }> {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export type StartupStepResult = {
  step: string;
  status: "skipped" | "success" | "failed";
  message: string;
  details?: string;
};

export type StartupSummary = {
  ok: boolean;
  mode: "dry-run" | "apply";
  steps: StartupStepResult[];
  envDiff?: string;
  backupPath?: string;
  mcpSnippet?: string;
};

function commandFailureDetails(result: SetupCommandResult): string | undefined {
  return (
    result.stderr ||
    result.reason ||
    result.stdout ||
    (result.exitCode === undefined ? undefined : `exit code ${result.exitCode}`)
  );
}

export async function runStartupSeq(
  plan: StartupPlan,
  options: { dryRun: boolean; envPath: string },
): Promise<StartupSummary> {
  const steps: StartupStepResult[] = [];
  const cwd = path.resolve(process.cwd());
  const envPath = options.envPath;

  // Step 1: env diff & backup
  let envDiff = "";
  let backupPath: string | undefined;
  if (existsSync(envPath)) {
    const currentContent = await readFile(envPath, "utf8");
    envDiff = buildEnvDiff(plan, currentContent);
  } else {
    envDiff = buildEnvDiff(plan, "");
  }

  if (options.dryRun) {
    steps.push({
      step: "env-preparation",
      status: "skipped",
      message: "Dry-run: Proposed .env modifications calculated.",
    });
  } else {
    try {
      const writeRes = await writeEnv(plan, envPath);
      backupPath = writeRes.backupPath;
      steps.push({
        step: "env-preparation",
        status: "success",
        message: backupPath
          ? `Saved .env and created backup at ${path.basename(backupPath)}`
          : "Created new .env file",
      });
    } catch (err) {
      steps.push({
        step: "env-preparation",
        status: "failed",
        message: "Failed to write .env file",
        details: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, mode: "apply", steps, envDiff };
    }
  }

  // Inject env variables in-memory for subprocesses or doctor in apply mode
  const commandEnv = { ...process.env };
  if (!options.dryRun) {
    const writtenEnvContent = await readFile(envPath, "utf8");
    const assignments = writtenEnvContent.split(/\r?\n/);
    for (const line of assignments) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (match?.[1]) {
        commandEnv[match[1]] = match[2].trim();
      }
    }
  }

  // Step 2: Docker preparation
  const startDocker = plan.database.startDocker;
  let dockerCommand = "docker";
  let dockerArgs = ["compose", "up", "-d"];

  if (options.dryRun) {
    steps.push({
      step: "db-docker",
      status: "skipped",
      message: startDocker
        ? `Dry-run: Would execute ${dockerCommand} ${dockerArgs.join(" ")}`
        : "Docker startup skipped (startDocker is false)",
    });
  } else {
    const dockerComposeRunner = await detectDockerComposeRunner(cwd, commandEnv);
    dockerCommand = dockerComposeRunner?.command ?? "docker";
    dockerArgs = [...(dockerComposeRunner?.argsPrefix ?? ["compose"]), "up", "-d"];

    if (startDocker) {
      const dockerResult = await runSetupCommand({
        command: dockerCommand,
        args: dockerArgs,
        cwd,
        env: commandEnv,
        dryRun: false,
      });

      if (dockerResult.status === "failed") {
        steps.push({
          step: "db-docker",
          status: "failed",
          message: "Failed to start database via docker compose",
          details: commandFailureDetails(dockerResult),
        });
        return { ok: false, mode: "apply", steps, envDiff, backupPath };
      }
      steps.push({
        step: "db-docker",
        status: "success",
        message: "Database container verified/started via docker compose",
      });

      // Wait a few seconds for DB to warm up
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else {
      steps.push({
        step: "db-docker",
        status: "skipped",
        message: "Docker startup skipped as requested",
      });
    }
  }

  // Step 3: Database validation
  const dbUrl = plan.database.url;
  if (options.dryRun) {
    steps.push({
      step: "db-connection",
      status: "skipped",
      message: `Dry-run: Would validate connectivity to ${dbUrl}`,
    });
  } else {
    const connResult = await validateDatabaseConnection(dbUrl);
    if (!connResult.ok) {
      steps.push({
        step: "db-connection",
        status: "failed",
        message: `Database connection failed for ${dbUrl}`,
        details: connResult.error,
      });
      return { ok: false, mode: "apply", steps, envDiff, backupPath };
    }
    steps.push({
      step: "db-connection",
      status: "success",
      message: "Successfully connected to the database",
    });
  }

  // Step 4: DB Migration
  if (options.dryRun) {
    steps.push({
      step: "db-migration",
      status: "skipped",
      message: "Dry-run: Would run bun run db:migrate",
    });
  } else {
    const migrateResult = await runSetupCommand({
      command: "bun",
      args: ["run", "db:migrate"],
      cwd,
      env: commandEnv,
      dryRun: false,
    });

    if (migrateResult.status === "failed") {
      steps.push({
        step: "db-migration",
        status: "failed",
        message: "Database migrations failed",
        details: commandFailureDetails(migrateResult),
      });
      return { ok: false, mode: "apply", steps, envDiff, backupPath };
    }
    steps.push({
      step: "db-migration",
      status: "success",
      message: "Database migrations applied successfully",
    });
  }

  // Step 5: Initial project init & seed
  if (options.dryRun) {
    steps.push({
      step: "project-init",
      status: "skipped",
      message: `Dry-run: Would run bun run init:project -- --json --wiki-root ${plan.project.wikiRoot} --lang ${plan.lang}`,
    });
  } else {
    const initArgs = [
      "run",
      "init:project",
      "--",
      "--json",
      "--wiki-root",
      plan.project.wikiRoot,
      "--lang",
      plan.lang,
    ];
    if (plan.project.importSeed) {
      // If seed import is requested, we can also chain a seed command or seed within project init
      // We will follow the plan to run project init
    }
    const initResult = await runSetupCommand({
      command: "bun",
      args: initArgs,
      cwd,
      env: commandEnv,
      dryRun: false,
    });

    if (initResult.status === "failed") {
      steps.push({
        step: "project-init",
        status: "failed",
        message: "Project initialization failed",
        details: commandFailureDetails(initResult),
      });
      return { ok: false, mode: "apply", steps, envDiff, backupPath };
    }
    steps.push({
      step: "project-init",
      status: "success",
      message: "Project initialized successfully",
    });
  }

  // Step 6: LLM Health check
  if (options.dryRun) {
    steps.push({
      step: "llm-health",
      status: "skipped",
      message: `Dry-run: Would verify LLM health for ${plan.compile.provider}`,
    });
  } else {
    const healthRes = await checkPlanLlmHealth(plan);
    steps.push({
      step: "llm-health",
      status: healthRes.ok ? "success" : "failed",
      message: healthRes.ok
        ? `LLM health verified successfully for ${plan.compile.provider}`
        : `LLM health check failed for ${plan.compile.provider}: ${healthRes.message}`,
      details: healthRes.error,
    });

    if (!healthRes.ok) {
      return { ok: false, mode: "apply", steps, envDiff, backupPath };
    }
  }

  // Step 7: Compile smoke test
  if (options.dryRun) {
    steps.push({
      step: "compile-smoke",
      status: "skipped",
      message: "Dry-run: Would run compile smoke test with a small goal",
    });
  } else {
    // Run a small, non-destructive context compilation smoke check
    // We execute with a mock/empty goal to check if compile CLI works
    const smokeResult = await runSetupCommand({
      command: "bun",
      args: ["run", "compile", "--", "--goal", "Onboarding test run", "--json"],
      cwd,
      env: commandEnv,
      dryRun: false,
    });

    if (smokeResult.status === "failed") {
      steps.push({
        step: "compile-smoke",
        status: "failed",
        message: "Compile smoke test failed",
        details: commandFailureDetails(smokeResult),
      });
      // We don't abort immediately as DB works, but we flag it
    } else {
      steps.push({
        step: "compile-smoke",
        status: "success",
        message: "Compile smoke test passed",
      });
    }
  }

  // Step 8: Doctor execution
  let isDoctorOk = false;
  if (options.dryRun) {
    steps.push({
      step: "doctor-validation",
      status: "skipped",
      message: "Dry-run: Would run bun run doctor to verify all systems",
    });
  } else {
    // Run doctor in current process context by updating process.env keys temporarily or running doctor command
    // Let's run doctor CLI directly or through doctor service to be safe and close the pool
    const backupEnv: Record<string, string | undefined> = {};
    try {
      // Need to temporarily set variables in process.env so doctor inspects correct database & provider
      for (const key of Object.keys(commandEnv)) {
        backupEnv[key] = process.env[key];
        process.env[key] = commandEnv[key];
      }

      const doctorReport = await runDoctor({ strict: false });
      isDoctorOk = doctorReport.status === "ok";

      steps.push({
        step: "doctor-validation",
        status: isDoctorOk ? "success" : "failed",
        message: isDoctorOk
          ? "Doctor check returned success (ok)"
          : `Doctor check returned status: ${doctorReport.status}. Reason count: ${doctorReport.reasons.length}`,
        details: JSON.stringify(doctorReport.reasonDetails, null, 2),
      });
    } catch (err) {
      steps.push({
        step: "doctor-validation",
        status: "failed",
        message: "Doctor execution encountered an error",
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      for (const key of Object.keys(backupEnv)) {
        if (backupEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = backupEnv[key];
        }
      }
      await closeDbPool();
    }
  }

  const allPassed = steps.every((s) => s.status !== "failed");
  const mcpSnippet = `
{
  "mcpServers": {
    "memory-router": {
      "command": "bun",
      "args": ["run", "start:mcp"],
      "cwd": "${cwd}"
    }
  }
}
`;

  return {
    ok: allPassed && (options.dryRun || isDoctorOk),
    mode: options.dryRun ? "dry-run" : "apply",
    steps,
    envDiff,
    backupPath,
    mcpSnippet,
  };
}
