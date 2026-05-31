import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type CodexAuthStatus = {
  codexHome: string;
  cliAvailable: boolean;
  authJsonExists: boolean;
  accessTokenConfigured: boolean;
  recommendedAction:
    | "ready"
    | "run-codex-login"
    | "set-codex-access-token"
    | "install-codex-cli";
};

export async function checkCodexAuthStatus(): Promise<CodexAuthStatus> {
  const codexHome = path.join(os.homedir(), ".codex");
  const authJsonPath = path.join(codexHome, "auth.json");

  // 1. CODEX_ACCESS_TOKENのチェック
  const accessTokenConfigured = Boolean(process.env.CODEX_ACCESS_TOKEN?.trim());

  // 2. ~/.codex/auth.jsonの存在チェック
  let authJsonExists = false;
  try {
    await fs.access(authJsonPath);
    authJsonExists = true;
  } catch {
    authJsonExists = false;
  }

  // 3. codex CLIの存在チェック
  let cliAvailable = false;
  try {
    // Note: We use a short execution to test command availability
    const { stdout } = await execAsync("codex --version");
    cliAvailable = stdout.trim().length > 0;
  } catch {
    cliAvailable = false;
  }

  // 4. recommendedAction の判定
  let recommendedAction: CodexAuthStatus["recommendedAction"] = "run-codex-login";
  if (accessTokenConfigured || authJsonExists) {
    recommendedAction = "ready";
  } else if (!cliAvailable) {
    recommendedAction = "install-codex-cli";
  } else {
    recommendedAction = "run-codex-login";
  }

  return {
    codexHome,
    cliAvailable,
    authJsonExists,
    accessTokenConfigured,
    recommendedAction,
  };
}

export function getCodexLoginCommand(): string {
  return "codex login";
}
