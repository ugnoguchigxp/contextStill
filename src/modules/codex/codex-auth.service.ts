import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type CodexAuthTokenInfo = {
  authMode: string;
  email: string | null;
  expiresAt: string | null;
  isExpired: boolean;
};

export type CodexAuthStatus = {
  codexHome: string;
  cliAvailable: boolean;
  authJsonExists: boolean;
  /** @deprecated Use tokenInfo.authMode and tokenInfo.email instead. */
  accessTokenConfigured: boolean;
  /** Detailed token information parsed from auth.json */
  tokenInfo: CodexAuthTokenInfo | null;
  recommendedAction:
    | "ready"
    | "run-codex-login"
    | "set-codex-access-token"
    | "install-codex-cli";
};

type AuthJsonTokens = {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
};

type AuthJson = {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: AuthJsonTokens;
  last_refresh?: string;
};

/** Parse a JWT payload (base64url) without verifying the signature. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1];
    // base64url → base64
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(base64, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function checkCodexAuthStatus(): Promise<CodexAuthStatus> {
  const codexHome = path.join(os.homedir(), ".codex");
  const authJsonPath = path.join(codexHome, "auth.json");

  // 1. CODEX_ACCESS_TOKEN 環境変数のチェック（後方互換用）
  const accessTokenConfigured = Boolean(process.env.CODEX_ACCESS_TOKEN?.trim());

  // 2. ~/.codex/auth.json の存在チェックと中身の解析
  let authJsonExists = false;
  let tokenInfo: CodexAuthTokenInfo | null = null;

  try {
    const raw = await fs.readFile(authJsonPath, "utf-8");
    authJsonExists = true;
    const parsed = JSON.parse(raw) as AuthJson;

    const authMode = parsed.auth_mode ?? "unknown";
    const accessToken = parsed.tokens?.access_token ?? null;
    const idToken = parsed.tokens?.id_token ?? null;

    // JWT から email / exp を取得（access_token 優先、なければ id_token）
    let email: string | null = null;
    let expiresAt: string | null = null;
    let isExpired = false;

    const tokenToDecode = accessToken ?? idToken;
    if (tokenToDecode) {
      const payload = decodeJwtPayload(tokenToDecode);
      if (payload) {
        // email
        const profile = payload["https://api.openai.com/profile"] as
          | { email?: string }
          | undefined;
        email = (profile?.email ?? (payload.email as string | undefined)) ?? null;

        // exp
        const exp = payload.exp;
        if (typeof exp === "number") {
          const expDate = new Date(exp * 1000);
          expiresAt = expDate.toISOString();
          isExpired = expDate < new Date();
        }
      }
    }

    tokenInfo = { authMode, email, expiresAt, isExpired };
  } catch {
    authJsonExists = false;
    tokenInfo = null;
  }

  // 3. codex CLI の存在チェック
  let cliAvailable = false;
  try {
    const { stdout } = await execAsync("codex --version");
    cliAvailable = stdout.trim().length > 0;
  } catch {
    cliAvailable = false;
  }

  // 4. recommendedAction の判定
  //    auth.json に有効なトークンがある → ready
  //    環境変数 CODEX_ACCESS_TOKEN が設定されている → ready
  //    CLI が使えない → install-codex-cli
  //    それ以外 → run-codex-login
  const hasValidToken =
    accessTokenConfigured || (authJsonExists && tokenInfo !== null && !tokenInfo.isExpired);

  let recommendedAction: CodexAuthStatus["recommendedAction"] = "run-codex-login";
  if (hasValidToken) {
    recommendedAction = "ready";
  } else if (authJsonExists && tokenInfo?.isExpired) {
    // トークン期限切れ → 再ログインが必要
    recommendedAction = "run-codex-login";
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
    tokenInfo,
    recommendedAction,
  };
}

export function getCodexLoginCommand(): string {
  return "codex login";
}
