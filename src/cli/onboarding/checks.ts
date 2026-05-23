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
  requireDockerCompose: boolean;
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

export type DockerComposeRunner = {
  command: string;
  argsPrefix: string[];
} | null;

export async function detectDockerComposeRunner(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<DockerComposeRunner> {
  const dockerComposeResult = await runSetupCommand({
    command: "docker",
    args: ["compose", "version"],
    cwd,
    env,
    dryRun: false,
  });
  if (dockerComposeResult.status === "ok") {
    return { command: "docker", argsPrefix: ["compose"] };
  }

  const legacyDockerComposeResult = await runSetupCommand({
    command: "docker-compose",
    args: ["version"],
    cwd,
    env,
    dryRun: false,
  });
  if (legacyDockerComposeResult.status === "ok") {
    return { command: "docker-compose", argsPrefix: [] };
  }
  return null;
}

export async function runSetupChecks(input: RunSetupChecksInput): Promise<SetupCheck[]> {
  const bunResult = await runSetupCommand({
    command: "bun",
    args: ["--version"],
    cwd: input.cwd,
    env: input.env,
    dryRun: false,
  });
  const dockerComposeRunner = await detectDockerComposeRunner(input.cwd, input.env);
  const dockerCheck: SetupCheck = dockerComposeRunner
    ? {
        name: "docker-compose",
        ok: true,
        message:
          dockerComposeRunner.command === "docker"
            ? "docker compose is available"
            : "docker-compose is available",
      }
    : {
        name: "docker-compose",
        ok: !input.requireDockerCompose,
        message: input.requireDockerCompose
          ? "docker compose or docker-compose is required but not available"
          : "docker compose not found (optional unless --start-db is used)",
      };

  const databaseUrl = input.envValues.DATABASE_URL?.trim();
  const databaseCheck: SetupCheck = databaseUrl
    ? { name: "database-url", ok: true, message: "DATABASE_URL is configured" }
    : { name: "database-url", ok: false, message: "DATABASE_URL is missing in .env" };

  return [summarizeCommand("bun", bunResult), dockerCheck, databaseCheck];
}
