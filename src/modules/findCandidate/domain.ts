import { access, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { groupedConfig } from "../../config.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { recordAuditLogSafe, auditEventTypes } from "../audit/audit-log.service.js";
import type { DistillationDomainSmokeResult } from "../distillation-domain.types.js";
import {
  runDistillationCompletion,
  resolveDistillationModel,
  type DistillationProviderSetting,
  type DistillationMessage,
  type DistillationRuntimeToolDefinition,
  type DistillationToolExecutor,
} from "../distillation/distillation-runtime.service.js";
import { readVibeMemoryByTokenWindow } from "../memoryReader/reader.service.js";
import { readFileDomain } from "../readFile/domain.js";
import {
  getDistillationTargetStateById,
  type DistillationTargetStateRow,
} from "../selectDistillationTarget/repository.js";
import { parseStorageCandidatesFromLlmOutput } from "./parser.js";
import {
  candidateHash,
  insertFindCandidateResult,
  selectFindCandidateResultByHash,
  type CandidateOrigin,
  type CandidateRecord,
} from "./repository.js";

export type FindCandidateCallerMode = "cli_text" | "storage";

export type FindCandidateInput = {
  targetStateId: string;
  provider?: DistillationProviderSetting;
  callerMode?: FindCandidateCallerMode;
  fromToken?: number;
  readTokens?: number;
  wikiMinify?: boolean;
  memoryReaderMode?: "compressed" | "original";
  maxReads?: number;
};

export type FindCandidateResult = {
  targetStateId: string;
  targetKind: "wiki_file" | "vibe_memory";
  targetKey: string;
  inputHash: string;
  callerMode: FindCandidateCallerMode;
  provider: DistillationProviderSetting;
  model: string;
  rawOutput: string;
  candidates: CandidateRecord[];
  insertedIds?: string[];
  existingIds?: string[];
  readRanges: Array<{ from: number; toExclusive: number }>;
};

function parseToolArgs(raw: string): Record<string, unknown> {
  const parsed = parseLlmJsonLike(raw)?.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.floor(value);
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function maxReads(input: FindCandidateInput): number {
  return Math.max(
    1,
    Math.min(20, Math.floor(input.maxReads ?? groupedConfig.distillationTools.readerMaxReads)),
  );
}

function readTokens(input: FindCandidateInput): number {
  return Math.max(1, Math.floor(input.readTokens ?? groupedConfig.readFile.defaultTokens));
}

function desiredCandidateLimit(): number {
  return Math.max(32, groupedConfig.distillationTools.maxCandidates);
}

function candidateOutputMaxTokens(): number {
  return Math.max(4096, groupedConfig.vibeDistillation.maxOutputTokens);
}

function defaultFindCandidateProvider(
  targetKind: "wiki_file" | "vibe_memory",
): DistillationProviderSetting {
  if (targetKind === "wiki_file") {
    return "azure-openai";
  }
  return "local-llm";
}

function buildToolDefinitionForTarget(
  targetKind: "wiki_file" | "vibe_memory",
): DistillationRuntimeToolDefinition {
  if (targetKind === "wiki_file") {
    return {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read more content from the current document by token window. Use only when additional content is required.",
        parameters: {
          type: "object",
          properties: {
            fromToken: { type: "number", description: "Start token offset (0-based)." },
            readTokens: { type: "number", description: "Token length to read." },
            minify: { type: "boolean", description: "Whether to use compressed text." },
          },
          required: [],
          additionalProperties: false,
        },
      },
    };
  }

  return {
    type: "function",
    function: {
      name: "memory_reader",
      description:
        "Read more content from the current vibe memory by token window. Use only when additional content is required.",
      parameters: {
        type: "object",
        properties: {
          fromToken: { type: "number", description: "Start token offset (0-based)." },
          readTokens: { type: "number", description: "Token length to read." },
          mode: {
            type: "string",
            description: "Reader mode: compressed or original.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  };
}

function systemPrompt(): string {
  return [
    "あなたの仕事は文章 content だけを見て、有用な知識候補を選ぶことです。",
    "候補選出以外のことはしないでください。",
    "厳守ルール:",
    "- 1候補 = 1知識（1ルール または 1手続き）",
    "- 複数のルール/手続きを1候補に混ぜない",
    "- 文書全体をそのまま1候補にしない",
    "- 複数の有用知識がある場合は候補を分割して複数出す",
    "- 候補件数は内容に応じて決める。件数合わせはしない",
    "最終出力は JSON のみで、次の形だけを返してください:",
    '{"candidates":[{"title":"...","content":"..."}]}',
    "候補がない場合は必ず次を返してください:",
    '{"candidates":[]}',
    "title/content 以外の field を返さないでください。",
  ].join("\n");
}

function userPrompt(): string {
  return [
    "まず tool で本文を読んでください。",
    "必要なら複数回読み、最終的に JSON だけを返してください。",
    "候補は必ず知識単位で分割してください（1候補=1ルール or 1手続き）。",
  ].join("\n");
}

function formatCliTextCandidates(candidates: CandidateRecord[]): string {
  if (candidates.length === 0) return "NO_CANDIDATE";
  return candidates
    .map((candidate) => `TITLE: ${candidate.title}\nCONTENT:\n${candidate.content}`)
    .join("\n---\n");
}

function isLikelyLocalLlmConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return false;
  const lowered = message.toLowerCase();
  return (
    lowered.includes("unable to connect") ||
    lowered.includes("fetch failed") ||
    lowered.includes("econnrefused") ||
    lowered.includes("enotfound") ||
    lowered.includes("ehostunreach") ||
    lowered.includes("econnreset") ||
    lowered.includes("connection refused") ||
    lowered.includes("couldn't connect")
  );
}

async function resolveLocalLlmPython(): Promise<{ python: string; localLlmRoot: string }> {
  const localLlmRoot = path.resolve(process.cwd(), "../local-llm");
  const preferred = path.resolve(localLlmRoot, ".venv/bin/python");
  try {
    await access(preferred);
    return { python: preferred, localLlmRoot };
  } catch {
    return { python: "python3", localLlmRoot };
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function listLocalLlmPids(localLlmRoot: string): Promise<number[]> {
  return new Promise<number[]>((resolve, reject) => {
    const child = spawn("ps", ["-ax", "-o", "pid=", "-o", "command="], {
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`failed to list processes: ${stderr.trim() || `exit code ${code}`}`));
        return;
      }
      const pids: number[] = [];
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(\d+)\s+(.+)$/);
        if (!match) continue;
        const pid = Number(match[1]);
        const command = match[2];
        if (!Number.isInteger(pid) || pid < 1) continue;
        if (pid === process.pid) continue;
        if (!command.includes(localLlmRoot)) continue;
        if (
          command.includes("run_openai_api.sh") ||
          command.includes("api.main:app") ||
          command.includes("main.py") ||
          command.includes("scripts/gemma4") ||
          command.includes("scripts/qwen") ||
          command.includes("scripts/bonsai")
        ) {
          pids.push(pid);
        }
      }
      resolve([...new Set(pids)]);
    });
  });
}

async function terminateExistingLocalLlmProcesses(localLlmRoot: string): Promise<number[]> {
  const pids = await listLocalLlmPids(localLlmRoot);
  if (pids.length === 0) return [];

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }

  const graceDeadline = Date.now() + 5000;
  while (Date.now() < graceDeadline) {
    const alive = pids.filter((pid) => pidIsAlive(pid));
    if (alive.length === 0) break;
    await sleep(200);
  }

  const remaining = pids.filter((pid) => pidIsAlive(pid));
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return pids;
}

async function withLocalLlmFallbackLock<T>(task: () => Promise<T>): Promise<T> {
  const lockPath = path.resolve(process.cwd(), "logs/find-candidate-local-llm.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : "";
    if (code === "EEXIST") {
      throw new Error("local-llm fallback is already running");
    }
    throw error;
  }

  try {
    return await task();
  } finally {
    try {
      await handle?.close();
    } catch {}
    try {
      await unlink(lockPath);
    } catch {}
  }
}

async function runLocalLlmCliFallback(params: {
  messages: DistillationMessage[];
  model: string;
  maxTokens: number;
}): Promise<string> {
  const { python, localLlmRoot } = await resolveLocalLlmPython();
  const script = [
    "import json",
    "import sys",
    "from core.model import MLXModelManager",
    "from core.chat_engine import ChatEngine",
    "payload = json.load(sys.stdin)",
    "manager = MLXModelManager()",
    "engine = ChatEngine(model_manager=manager, verbose=False, max_tool_rounds=0)",
    "content = engine.run_chat(",
    "    messages=payload.get('messages', []),",
    "    model=payload.get('model'),",
    "    max_tokens=int(payload.get('max_tokens', 1024)),",
    "    temperature=float(payload.get('temperature', 0.0)),",
    "    tools=[],",
    ")",
    "print(json.dumps({'content': content}, ensure_ascii=False))",
  ].join("\n");

  const timeoutMs = Math.max(60_000, groupedConfig.distillation.timeoutMs);
  const payload = JSON.stringify({
    model: params.model,
    max_tokens: params.maxTokens,
    temperature: 0,
    messages: params.messages,
  });

  return new Promise<string>((resolve, reject) => {
    const child = spawn(python, ["-c", script], {
      cwd: localLlmRoot,
      env: {
        ...process.env,
        PYTHONPATH: process.env.PYTHONPATH
          ? `${localLlmRoot}${path.delimiter}${process.env.PYTHONPATH}`
          : localLlmRoot,
      },
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`local-llm CLI fallback timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? "unknown"}`;
        reject(new Error(`local-llm CLI fallback failed: ${detail}`));
        return;
      }
      const lines = stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const parsed = JSON.parse(lines[index]) as { content?: unknown };
          if (typeof parsed.content === "string") {
            resolve(parsed.content);
            return;
          }
        } catch {}
      }
      reject(new Error("local-llm CLI fallback returned no parsable content"));
    });

    child.stdin.write(payload);
    child.stdin.end();
  });
}

function fallbackUserPrompt(content: string): string {
  return [
    "以下は対象本文です。候補選定だけを実施してください。",
    "1候補=1知識（1ルール or 1手続き）を厳守してください。",
    "文書全体をそのまま1候補にすることは禁止です。",
    "最終出力は JSON のみで、次の形だけを返してください:",
    '{"candidates":[{"title":"...","content":"..."}]}',
    '候補が無い場合は {"candidates":[]} を返してください。',
    "",
    content,
  ].join("\n");
}

async function runFindCandidateWithLocalCliFallback(params: {
  target: DistillationTargetStateRow;
  input: FindCandidateInput;
  callerMode: FindCandidateCallerMode;
  model: string;
  readLimit: number;
}): Promise<{
  rawOutput: string;
  candidates: CandidateRecord[];
  readRanges: Array<{ from: number; toExclusive: number }>;
}> {
  const { localLlmRoot } = await resolveLocalLlmPython();
  return withLocalLlmFallbackLock(async () => {
    await terminateExistingLocalLlmProcesses(localLlmRoot);

    const readRanges: Array<{ from: number; toExclusive: number }> = [];
    const selectedCandidates: CandidateRecord[] = [];
    const candidateSet = new Set<string>();
    let cursor = Math.max(0, Math.floor(params.input.fromToken ?? 0));
    const tokenWindow = Math.min(readTokens(params.input), 400);
    const fallbackMaxOutputTokens = Math.min(groupedConfig.vibeDistillation.maxOutputTokens, 1200);
    const maxCandidates = desiredCandidateLimit();

    for (let index = 0; index < params.readLimit; index += 1) {
      const result =
        params.target.targetKind === "wiki_file"
          ? await readFileDomain({
              path: params.target.targetKey,
              fromToken: cursor,
              readTokens: tokenWindow,
              minify: params.input.wikiMinify ?? true,
            })
          : await readVibeMemoryByTokenWindow({
              vibeMemoryId: params.target.targetKey,
              fromToken: cursor,
              readTokens: tokenWindow,
              mode: params.input.memoryReaderMode ?? "compressed",
            });

      readRanges.push({ from: result.from, toExclusive: result.toExclusive });
      const chunk = result.content.trim();
      if (chunk) {
        const chunkRawOutput = (
          await runLocalLlmCliFallback({
            model: params.model,
            maxTokens: fallbackMaxOutputTokens,
            messages: [
              { role: "system", content: systemPrompt() },
              { role: "user", content: fallbackUserPrompt(chunk) },
            ],
          })
        ).trim();
        const chunkCandidates = parseStorageCandidatesFromLlmOutput(chunkRawOutput);
        for (const candidate of chunkCandidates) {
          const hash = candidateHash(candidate);
          if (candidateSet.has(hash)) continue;
          candidateSet.add(hash);
          selectedCandidates.push(candidate);
          if (selectedCandidates.length >= maxCandidates) break;
        }
      }
      const progressed = result.toExclusive > cursor;
      cursor = result.toExclusive;
      if (selectedCandidates.length >= maxCandidates) break;
      if (!progressed || result.returnedTokens <= 0 || result.toExclusive >= result.totalTokens) {
        break;
      }
    }

    const rawOutput =
      params.callerMode === "storage"
        ? JSON.stringify({ candidates: selectedCandidates })
        : formatCliTextCandidates(selectedCandidates);

    return {
      rawOutput,
      candidates: selectedCandidates,
      readRanges,
    };
  });
}

export async function runFindCandidate(input: FindCandidateInput): Promise<FindCandidateResult> {
  const targetStateId = input.targetStateId.trim();
  if (!targetStateId) {
    throw new Error("targetStateId is required");
  }

  const target = await getDistillationTargetStateById(targetStateId);
  if (!target) {
    throw new Error(`distillation target state not found: ${targetStateId}`);
  }

  if (target.targetKind !== "wiki_file" && target.targetKind !== "vibe_memory") {
    throw new Error(`unsupported target kind for findCandidate: ${target.targetKind}`);
  }

  const callerMode = input.callerMode ?? "cli_text";
  const provider = input.provider ?? defaultFindCandidateProvider(target.targetKind);
  const model = resolveDistillationModel(provider);
  const candidateLimit = desiredCandidateLimit();
  const toolDefinition = buildToolDefinitionForTarget(target.targetKind);
  const readLog: Array<{ from: number; toExclusive: number }> = [];
  const readLimit = maxReads(input);
  let reads = 0;

  const toolExecutor: DistillationToolExecutor = async (toolCall) => {
    const args = parseToolArgs(toolCall.function.arguments);
    if (reads >= readLimit) {
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: false,
        content: "",
        error: `read limit exceeded (${readLimit})`,
      };
    }

    if (target.targetKind === "wiki_file") {
      if (toolCall.function.name !== "read_file") {
        return {
          callId: toolCall.id,
          name: toolCall.function.name,
          ok: false,
          content: "",
          error: "unknown tool",
        };
      }

      const result = await readFileDomain({
        path: target.targetKey,
        fromToken: Math.max(0, asInt(args.fromToken, asInt(input.fromToken, 0))),
        readTokens: Math.max(1, asInt(args.readTokens, readTokens(input))),
        minify: asBool(args.minify, input.wikiMinify ?? true),
      });
      reads += 1;
      readLog.push({ from: result.from, toExclusive: result.toExclusive });
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: true,
        content: result.content,
      };
    }

    if (toolCall.function.name !== "memory_reader") {
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: false,
        content: "",
        error: "unknown tool",
      };
    }

    const modeRaw = typeof args.mode === "string" ? args.mode.trim() : "";
    const mode =
      modeRaw === "original" || modeRaw === "compressed"
        ? modeRaw
        : (input.memoryReaderMode ?? "compressed");
    const result = await readVibeMemoryByTokenWindow({
      vibeMemoryId: target.targetKey,
      fromToken: Math.max(0, asInt(args.fromToken, asInt(input.fromToken, 0))),
      readTokens: Math.max(1, asInt(args.readTokens, readTokens(input))),
      mode,
    });
    reads += 1;
    readLog.push({ from: result.from, toExclusive: result.toExclusive });
    return {
      callId: toolCall.id,
      name: toolCall.function.name,
      ok: true,
      content: result.content,
    };
  };

  await recordAuditLogSafe({
    eventType: auditEventTypes.findCandidateStarted,
    actor: "system",
    payload: {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      provider,
      callerMode,
    },
  });

  try {
    let rawOutput = "";
    let candidates: CandidateRecord[] = [];
    let usedLocalCliFallback = false;

    try {
      const completion = await runDistillationCompletion(
        {
          model,
          maxTokens: candidateOutputMaxTokens(),
          messages: [
            { role: "system", content: systemPrompt() },
            { role: "user", content: userPrompt() },
          ],
        },
        {
          providerSetting: provider,
          toolDefinitions: [toolDefinition],
          toolExecutor,
          enableTools: true,
          maxToolRounds: readLimit,
          requireToolCall: true,
          requireToolCallReminder: [
            "まだ本文を読んでいません。",
            "まず tool を呼び出して本文 content を読んでください。",
            "その後に候補のみを返してください。",
          ],
          blankResponseReminder: [
            '空の応答です。{"candidates":[]} または {"candidates":[{"title":"...","content":"..."}]} を返してください。',
          ],
        },
      );

      rawOutput = completion.content.trim();
      candidates = parseStorageCandidatesFromLlmOutput(rawOutput);
    } catch (error) {
      if (provider !== "local-llm" || !isLikelyLocalLlmConnectionError(error)) {
        throw error;
      }
      const fallback = await runFindCandidateWithLocalCliFallback({
        target,
        input,
        callerMode,
        model,
        readLimit,
      });
      rawOutput = fallback.rawOutput;
      candidates = fallback.candidates;
      readLog.splice(0, readLog.length, ...fallback.readRanges);
      usedLocalCliFallback = true;
    }

    candidates = candidates.slice(0, candidateLimit);
    const canonicalCliOutput = formatCliTextCandidates(candidates);

    await recordAuditLogSafe({
      eventType: auditEventTypes.findCandidateReaderUsed,
      actor: "system",
      payload: {
        targetStateId: target.id,
        readCount: readLog.length,
        readRanges: readLog,
        localCliFallback: usedLocalCliFallback,
      },
    });

    if (callerMode === "cli_text") {
      await recordAuditLogSafe({
        eventType: auditEventTypes.findCandidateCompleted,
        actor: "system",
        payload: {
          targetStateId: target.id,
          candidateCount: candidates.length,
          readCount: readLog.length,
          localCliFallback: usedLocalCliFallback,
        },
      });

      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        inputHash: target.inputHash,
        callerMode,
        provider,
        model,
        rawOutput: canonicalCliOutput,
        candidates,
        readRanges: readLog,
      };
    }

    const origin: CandidateOrigin = {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      sourceUri: target.sourceUri,
      inputHash: target.inputHash,
      readRanges: readLog,
    };

    const insertedIds: string[] = [];
    const existingIds: string[] = [];

    for (const [index, candidate] of candidates.entries()) {
      const hash = candidateHash(candidate);
      const existing = await selectFindCandidateResultByHash({
        targetStateId: target.id,
        inputHash: target.inputHash,
        hash,
      });
      if (existing) {
        existingIds.push(existing.id);
        continue;
      }
      const inserted = await insertFindCandidateResult({
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        sourceUri: target.sourceUri,
        inputHash: target.inputHash,
        provider,
        model,
        candidateIndex: index,
        candidate,
        origin,
        rawOutput,
      });
      insertedIds.push(inserted.id);
    }

    await recordAuditLogSafe({
      eventType: auditEventTypes.findCandidateCompleted,
      actor: "system",
      payload: {
        targetStateId: target.id,
        candidateCount: candidates.length,
        insertedCount: insertedIds.length,
        existingCount: existingIds.length,
        localCliFallback: usedLocalCliFallback,
      },
    });

    return {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      inputHash: target.inputHash,
      callerMode,
      provider,
      model,
      rawOutput,
      candidates,
      insertedIds,
      existingIds,
      readRanges: readLog,
    };
  } catch (error) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.findCandidateFailed,
      actor: "system",
      payload: {
        targetStateId: target.id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function runFindCandidateSmoke(
  input: Record<string, unknown>,
): Promise<DistillationDomainSmokeResult> {
  return {
    domain: "findCandidate",
    implemented: false,
    status: "prepared",
    checkedAt: new Date().toISOString(),
    message:
      "findCandidate domain smoke remains scaffold-only. Use find-candidate CLI for runtime.",
    receivedInput: input,
    nextContracts: [
      "findCandidate runtime is implemented via runFindCandidate",
      "coverEvidence/finalizeDistille contracts remain pending",
      "distill-domain smoke will be replaced after all domains migrate",
    ],
  };
}
