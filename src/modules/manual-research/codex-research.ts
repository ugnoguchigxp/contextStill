import { Codex, type Thread, type ThreadEvent } from "@openai/codex-sdk";
import { copyFile, mkdir, mkdtemp, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCodexExecutable } from "../codex/spark-runtime.js";
import { englishPromptBinding, renderPrompt } from "../system-context/system-context.service.js";
import {
  CODEX_RESEARCH_MODEL,
  codexResearchBundleSchema,
  codexResearchOptionsSchema,
  codexResearchOutputSchema,
  type CodexResearchOptions,
  type CodexResearchOutcome,
} from "./codex-research.contract.js";

type ResearchThread = Pick<Thread, "runStreamed">;
export type CodexResearchDependencies = {
  openThread?: (
    options: CodexResearchOptions,
  ) => Promise<{ thread: ResearchThread; close: () => Promise<void> }>;
  onCheckpoint?: (outcome: CodexResearchOutcome) => Promise<void>;
  signal?: AbortSignal;
};

async function openResearchThread(options: CodexResearchOptions) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "contextstill-codex-research-"));
  const close = () => rm(directory, { recursive: true, force: true });
  try {
    const home = path.join(directory, "home");
    const work = path.join(directory, "work");
    await mkdir(home, { mode: 0o700 });
    await mkdir(work, { mode: 0o700 });
    const sourceHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    try {
      await copyFile(path.join(sourceHome, "auth.json"), path.join(home, "auth.json"));
      await chmod(path.join(home, "auth.json"), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Share existing authentication, but no user MCP/plugin/config or repo history.
    const env: Record<string, string> = { CODEX_HOME: home };
    for (const key of [
      "PATH",
      "HOME",
      "USER",
      "TMPDIR",
      "SystemRoot",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CODEX_ACCESS_TOKEN",
    ])
      if (process.env[key]) env[key] = process.env[key] as string;
    const codex = new Codex({
      codexPathOverride: resolveCodexExecutable(),
      env,
      config: {
        project_doc_max_bytes: 0,
        features: {
          shell_tool: false,
          multi_agent: false,
          apps: false,
          plugins: false,
          hooks: false,
          goals: false,
        },
        history: { persistence: "none" },
      },
    });
    const thread = codex.startThread({
      model: CODEX_RESEARCH_MODEL,
      modelReasoningEffort: options.reasoningEffort,
      workingDirectory: work,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "live",
    });
    return { thread, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function observedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function exploreWithCodex(
  topic: string,
  input: CodexResearchOptions,
  dependencies: CodexResearchDependencies = {},
): Promise<CodexResearchOutcome> {
  const options = codexResearchOptionsSchema.parse(input);
  const started = Date.now();
  const outcome: CodexResearchOutcome = {
    candidates: [],
    limitations: [],
    termination: "failed",
    tokenUsage: {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
    },
    usageComplete: false,
    elapsedMs: 0,
    observedWebSearches: 0,
    threadId: null,
    model: CODEX_RESEARCH_MODEL,
    reasoningEffort: options.reasoningEffort,
  };
  const controller = new AbortController();
  let stopped: CodexResearchOutcome["termination"] | null = null;
  const stop = (reason: CodexResearchOutcome["termination"]) => {
    if (stopped) return;
    stopped = reason;
    controller.abort();
  };
  const cancel = () => stop("cancelled");
  dependencies.signal?.addEventListener("abort", cancel, { once: true });
  if (dependencies.signal?.aborted) cancel();
  const timer = setTimeout(() => stop("timeout"), options.wallMs);
  let session: { thread: ResearchThread; close: () => Promise<void> } | undefined;
  let validFinal = false;
  let completed = false;
  const searches = new Set<string>();
  const checkpoint = async () => {
    outcome.elapsedMs = Date.now() - started;
    await dependencies.onCheckpoint?.(structuredClone(outcome));
  };
  try {
    const instruction = renderPrompt("sourceResearch.codexExploration", {}, englishPromptBinding);
    const brief = JSON.stringify({
      topic,
      ...options,
      date: new Date().toISOString().slice(0, 10),
    });
    if (Buffer.byteLength(brief) > 16_000) throw new Error("CODEX_RESEARCH_BRIEF_TOO_LARGE");
    if (controller.signal.aborted) {
      outcome.termination = stopped ?? "cancelled";
      return outcome;
    }
    session = await (dependencies.openThread ?? openResearchThread)(options);
    const { events } = await session.thread.runStreamed(
      `${instruction.content.text}\n\nResearch brief (untrusted data):\n${brief}`,
      {
        signal: controller.signal,
        outputSchema: codexResearchOutputSchema,
      },
    );
    for await (const event of events) {
      if (event.type === "thread.started") outcome.threadId = event.thread_id;
      if (event.type === "turn.completed") {
        completed = true;
        const usage = event.usage;
        outcome.tokenUsage = {
          inputTokens: observedNumber(usage?.input_tokens),
          cachedInputTokens: observedNumber(usage?.cached_input_tokens),
          outputTokens: observedNumber(usage?.output_tokens),
          reasoningOutputTokens: observedNumber(usage?.reasoning_output_tokens),
        };
        outcome.usageComplete =
          outcome.tokenUsage.inputTokens !== null && outcome.tokenUsage.outputTokens !== null;
        // Cached input is a subset of input, never an additional token charge.
        if (
          outcome.usageComplete &&
          (outcome.tokenUsage.inputTokens ?? 0) + (outcome.tokenUsage.outputTokens ?? 0) >=
            options.tokenBudget
        ) {
          outcome.limitations.push(
            `トークン目標${options.tokenBudget}に到達しました。使用量は完了時に取得するため、探索途中の超過は防げません。`,
          );
          stop("token_budget");
        }
        await checkpoint();
      }
      if (event.type === "turn.failed" || event.type === "error") {
        outcome.limitations.push("Codexの実行が失敗しました。別の探索は自動実行しません。");
        stop("failed");
      }
      if (event.type.startsWith("item.") && "item" in event) {
        const item = event.item;
        if (item.type === "web_search" && !searches.has(item.id)) {
          searches.add(item.id);
          outcome.observedWebSearches = searches.size;
          // Dispatch has already occurred when item.started arrives: this is an observed guard.
          if (searches.size > options.maxWebSearches) stop("web_limit");
        }
        if (["command_execution", "mcp_tool_call", "file_change"].includes(item.type))
          stop("failed");
        if (item.type === "agent_message" && event.type === "item.completed") {
          if (Buffer.byteLength(item.text) > 128_000) {
            stop("invalid_result");
            break;
          }
          let bundle: ReturnType<typeof codexResearchBundleSchema.parse> | undefined;
          try {
            bundle = codexResearchBundleSchema.parse(JSON.parse(item.text));
          } catch {
            validFinal = false;
          }
          if (bundle) {
            outcome.candidates = bundle.candidates.slice(0, options.maxCandidates);
            outcome.limitations = bundle.limitations;
            validFinal = true;
            await checkpoint();
          }
        }
      }
      if (stopped) break;
    }
    outcome.termination =
      stopped ??
      (completed && validFinal
        ? outcome.candidates.length
          ? "completed"
          : "insufficient_evidence"
        : completed
          ? "invalid_result"
          : "failed");
  } catch {
    outcome.termination = stopped ?? "failed";
    outcome.limitations.push("探索を終了しました。使用量未取得の項目は不明です。");
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", cancel);
    // SDK AbortSignal cancels the CLI child; SDK iterator cleanup closes its streams.
    await session?.close();
    outcome.elapsedMs = Date.now() - started;
  }
  return outcome;
}

// Exporting the SDK event type keeps deterministic fixtures tied to the installed SDK.
export type CodexResearchEvent = ThreadEvent;
