import type { SetupCommandResult } from "./command-runner.js";
import { runSetupCommand } from "./command-runner.js";

export type SetupCheck = {
  name: string;
  ok: boolean;
  message: string;
};

type RunSetupChecksInput = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  envValues: Record<string, string>;
};

function summarizeCommand(checkName: string, result: SetupCommandResult): SetupCheck {
  if (result.status === "ok") {
    const suffix = result.stdout ? ` (${result.stdout})` : "";
    return { name: checkName, ok: true, message: `${checkName} available${suffix}` };
  }
  return {
    name: checkName,
    ok: false,
    message: result.stderr || `${checkName} is not available`,
  };
}

export async function runSetupChecks(input: RunSetupChecksInput): Promise<SetupCheck[]> {
  const bunResult = await runSetupCommand({
    command: "bun",
    args: ["--version"],
    cwd: input.cwd,
    env: input.env,
    dryRun: false,
  });
  const dockerResult = await runSetupCommand({
    command: "docker",
    args: ["compose", "version"],
    cwd: input.cwd,
    env: input.env,
    dryRun: false,
  });

  const databaseUrl = input.envValues.DATABASE_URL?.trim();
  const databaseCheck: SetupCheck = databaseUrl
    ? { name: "database-url", ok: true, message: "DATABASE_URL is configured" }
    : { name: "database-url", ok: false, message: "DATABASE_URL is missing in .env" };

  return [
    summarizeCommand("bun", bunResult),
    summarizeCommand("docker-compose", dockerResult),
    databaseCheck,
  ];
}
