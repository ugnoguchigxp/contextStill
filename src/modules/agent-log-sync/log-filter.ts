import { redactSecrets } from "../../shared/utils/secret-redaction.js";

export function filterSensitiveData(text: string): string {
  return redactSecrets(text);
}
