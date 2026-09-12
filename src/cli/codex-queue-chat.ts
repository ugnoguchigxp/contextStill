import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SPARK_MODEL,
  readSparkAvailability,
  resolveCodexExecutable,
} from "../modules/codex/spark-runtime.js";
import type { LlmChatRequest } from "../modules/llm/llm-provider.js";
import { createCodexProvider } from "../modules/llm/providers/codex.provider.js";

// A single bounded request over stdio. This process never claims jobs or writes queue state.
async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 4_000_000) throw new Error("Codex queue input too large");
  }
  const request = JSON.parse(input) as LlmChatRequest & { timeoutMs: number };
  if (request.model !== SPARK_MODEL || !Array.isArray(request.messages))
    throw new Error("Invalid Spark queue request");
  if (
    !Number.isFinite(request.timeoutMs) ||
    request.timeoutMs < 1000 ||
    request.timeoutMs > 3_600_000
  )
    throw new Error("Invalid timeout");
  const executable = resolveCodexExecutable();
  const quota = await readSparkAvailability(executable);
  if (!quota.available) return { error: { code: "quota_exhausted", retryAt: quota.retryAt } };
  const workspace = await mkdtemp(path.join(os.tmpdir(), "contextstill-spark-"));
  try {
    const provider = createCodexProvider({
      model: SPARK_MODEL,
      sparkOnly: true,
      timeoutMs: request.timeoutMs,
      codexPath: executable,
      workingDirectory: workspace,
    });
    const response = await provider.chat(request);
    if (request.responseFormat === "json") JSON.parse(response.content);
    return { content: response.content, model: SPARK_MODEL, usage: response.usage };
  } catch (error) {
    // Re-read quota on failure, including exhaustion reached during this turn.
    const current = await readSparkAvailability(executable).catch(() => null);
    if (current && !current.available)
      return { error: { code: "quota_exhausted", retryAt: current.retryAt } };
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
main()
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ error: { code: "provider_error", message: error instanceof Error ? error.message : String(error) } })}\n`,
    );
    process.exitCode = 1;
  });
