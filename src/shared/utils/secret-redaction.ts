const REDACTION_PLACEHOLDER = "[REMOVED SENSITIVE DATA]";

const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)* PRIVATE KEY-----/g;

const SECRET_PATTERNS: RegExp[] = [
  PRIVATE_KEY_BLOCK_PATTERN,
  /(?:^|\b)export\s+[A-Z_]*(?:PASSWORD|TOKEN|KEY)\s*=\s*.+$/gim,
  /\b(?:password|passphrase|secret(?:[_-]?key)?|api[_-]?key|auth[_-]?token)\b\s*[:=]\s*["']?[^\s"']+/gi,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\b(?:sk|rk|pk)-[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
];

const SECRET_LINE_KEYWORDS = ["password", "passphrase", "secret_key", "auth_token"];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTION_PLACEHOLDER);
  }
  return redacted
    .split("\n")
    .filter((line) => {
      const lower = line.toLowerCase();
      return !SECRET_LINE_KEYWORDS.some((keyword) => lower.includes(keyword));
    })
    .join("\n");
}
