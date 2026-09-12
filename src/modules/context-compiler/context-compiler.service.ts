import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import type { CompileRunSource } from "../../shared/schemas/compile-run.schema.js";
import { compileInputSchema } from "../../shared/schemas/compile.schema.js";
import type { ContextPack } from "../../shared/schemas/context-pack.schema.js";
import type { SecurityIntelligenceShadowResult } from "../security-intelligence/shadow-retrieval.service.js";
import { compileNativeContext } from "./native-compile.client.js";

export async function compileContextPack(
  rawInput: unknown,
  options?: { source?: CompileRunSource; sessionId?: string },
): Promise<{
  pack: ContextPack;
  markdown: string;
  securityIntelligenceShadow?: SecurityIntelligenceShadowResult;
}> {
  const input = compileInputSchema.parse(rawInput);
  // Explicit compatibility paths, never a fallback after native transport/engine failure.
  if (resolveDatabaseBackendConfig().kind === "postgres" || input.securityIntelligenceShadow) {
    const legacy = await import("./context-compiler.legacy.js");
    return legacy.compileContextPack(input, options);
  }
  return compileNativeContext(input, options);
}
