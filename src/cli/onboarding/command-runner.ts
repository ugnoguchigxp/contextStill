import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandStatus = "planned" | "ok" | "failed" | "skipped";

export type SetupCommandResult = {
  command: string;
  args: string[];
  status: CommandStatus;
  skipped: boolean;
  reason?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

export type RunSetupCommandInput = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  dryRun: boolean;
  skipReason?: string;
};

export async function runSetupCommand(input: RunSetupCommandInput): Promise<SetupCommandResult> {
  if (input.skipReason) {
    return {
      command: input.command,
      args: input.args,
      status: "skipped",
      skipped: true,
      reason: input.skipReason,
    };
  }
  if (input.dryRun) {
    return {
      command: input.command,
      args: input.args,
      status: "planned",
      skipped: false,
    };
  }

  try {
    const result = await execFileAsync(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      encoding: "utf8",
    });
    return {
      command: input.command,
      args: input.args,
      status: "ok",
      skipped: false,
      exitCode: 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    const commandError = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      command: input.command,
      args: input.args,
      status: "failed",
      skipped: false,
      exitCode: typeof commandError.code === "number" ? commandError.code : 1,
      stdout: (commandError.stdout ?? "").trim(),
      stderr: (commandError.stderr ?? commandError.message ?? "").trim(),
    };
  }
}
