import { createHash } from "node:crypto";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export function canonicalizeJson(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.normalize("NFC") !== value) throw new Error("canonical_json:unicode_must_be_nfc");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_json:number_must_be_finite");
    return value;
  }
  if (Array.isArray(value)) {
    if (
      Object.getOwnPropertyNames(value).length !== value.length + 1 ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new Error("canonical_json:sparse_or_extended_array_not_supported");
    }
    return value.map(canonicalizeJson);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical_json:plain_object_required");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error("canonical_json:symbol_keys_not_supported");
    }
    const result = Object.create(null) as Record<string, CanonicalJsonValue>;
    for (const key of Object.keys(value as object).sort()) {
      if (key.normalize("NFC") !== key) throw new Error("canonical_json:unicode_must_be_nfc");
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) throw new Error("canonical_json:undefined_not_supported");
      result[key] = canonicalizeJson(child);
    }
    return result;
  }
  throw new Error("canonical_json:value_must_be_json");
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function canonicalJsonSha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value)).digest("hex")}`;
}
