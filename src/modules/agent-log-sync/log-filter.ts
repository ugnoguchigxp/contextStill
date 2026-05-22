const SECRET_PATTERNS: RegExp[] = [
  /export\s+[A-Z_]*PASSWORD=.*$/gim,
  /export\s+[A-Z_]*TOKEN=.*$/gim,
  /export\s+[A-Z_]*KEY=.*$/gim,
  /password\s*[:=]\s*\S+/gi,
  /secret[_-]?key\s*[:=]\s*\S+/gi,
  /auth[_-]?token\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /bearer\s+[a-z0-9\-_.]+/gi,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
  /xox[baprs]-\S+/gm,
  /ghp_\S+/gm,
  /ghs_\S+/gm,
  /([a-zA-Z0-9]{48,})/g,
];

const SECRET_LINE_KEYWORDS = ["password", "secret_key", "auth_token"];

export function filterSensitiveData(text: string): string {
  let filtered = text;
  for (const pattern of SECRET_PATTERNS) {
    filtered = filtered.replace(pattern, "[REMOVED SENSITIVE DATA]");
  }

  return filtered
    .split("\n")
    .filter((line) => {
      const lower = line.toLowerCase();
      return !SECRET_LINE_KEYWORDS.some((keyword) => lower.includes(keyword));
    })
    .join("\n");
}
