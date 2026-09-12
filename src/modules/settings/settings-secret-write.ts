export function assertSecretReferenceWrite(input: {
  namespace: string;
  value: Record<string, unknown>;
  valueKind?: string;
  secretRef?: string | null;
  isSecret?: boolean;
}): void {
  if (input.namespace !== "runtime.secret" && !input.isSecret) return;
  const keys = Object.keys(input.value);
  const disabled = keys.length === 1 && input.value.disabled === true && !input.secretRef;
  const environment = keys.length === 1 && input.value.environment === true && !input.secretRef;
  const reference =
    keys.length === 1 &&
    typeof input.secretRef === "string" &&
    /^cs-secret:v1:[a-f0-9]{64}:[a-zA-Z0-9]+:[a-f0-9]{32}$/.test(input.secretRef) &&
    input.value.secretRef === input.secretRef;
  if (input.valueKind !== "secret_ref" || (!disabled && !environment && !reference)) {
    throw new Error("secret_plaintext_write_forbidden");
  }
}
