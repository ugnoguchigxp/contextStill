import { redactSecrets } from "../../shared/utils/secret-redaction.js";

const SENSITIVE_LINE_PATTERN =
  /\b(?:password|passphrase|secret|credential|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|private[_-]?key)\b/i;

export function filterSensitiveData(text: string): string {
  return redactSecrets(text)
    .split("\n")
    .filter((line) => !SENSITIVE_LINE_PATTERN.test(line))
    .join("\n");
}
