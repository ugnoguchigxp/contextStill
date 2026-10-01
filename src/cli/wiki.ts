import { createReadStream } from "node:fs";
import {
  BODY_LIMIT,
  WikiError,
  validateWikiBody,
  wikiExitCode,
} from "../modules/sources/wiki/wiki-contract.js";
import { wikiRequest } from "./wiki-client.js";
import { parseWikiOptions } from "./wiki-options.js";
export const wikiHelp = [
  "Usage: context-still wiki <list|get|create|update> [slug] [options]",
  "  list --json",
  "  get <slug> [--json | --format markdown]",
  "  create <slug> --title <title> (--stdin | --file <path>) (--extract | --no-extract) --request-id <UUID> [--json]",
  "  update <slug> (--stdin | --file <path>) --if-version <sha256:hash> (--extract | --no-extract) --request-id <UUID> [--title <title>] [--json]",
  "Required environment: CONTEXT_STILL_ADMIN_API_KEY",
  "API: CONTEXT_STILL_WIKI_API_URL (default http://127.0.0.1:39170)",
  "Extraction may be unsupported; queued does not mean knowledge is active.",
].join("\n");
export async function readWikiInput(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) throw new WikiError("INPUT_TOO_LARGE", 413);
    chunks.push(bytes);
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new WikiError("INVALID_UTF8", 400);
  }
  validateWikiBody(body);
  return body;
}
export async function runWiki(args: string[]): Promise<number> {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(wikiHelp);
    return 0;
  }
  try {
    const options = parseWikiOptions(args);
    let body: string | undefined;
    if (options.file || options.stdin) {
      try {
        body = await readWikiInput(options.file ? createReadStream(options.file) : process.stdin);
      } catch (error) {
        throw error instanceof WikiError ? error : new WikiError("INPUT_UNREADABLE", 400);
      }
    }
    const { status, result } = await wikiRequest(options, body);
    if (options.json) console.log(JSON.stringify(result));
    else if (status >= 200 && status < 300 && status !== 207) {
      if (options.format) {
        const page = result.page as { body: string };
        process.stdout.write(page.body);
      } else if (options.command === "list")
        for (const item of result.items as { slug: string; version: string }[])
          console.log(`${item.slug}\t${item.version}`);
      else if (options.command === "get") console.log((result.page as { body: string }).body);
      else
        console.log(`保存・索引反映完了（抽出: not_requested） operationId=${options.requestId}`);
    } else {
      const error = result.error as { code: string; retryable: boolean };
      console.error(
        `${error.code} (HTTP ${status})${result.phase ? ` phase=${result.phase} operationId=${result.operationId}` : ""}`,
      );
      if (status === 207)
        console.error(
          error.retryable
            ? "同じrequest IDと入力で再試行してください。"
            : "operation記録とGitを確認してください。",
        );
    }
    return status >= 200 && status < 300 && status !== 207 ? 0 : wikiExitCode(status);
  } catch (error) {
    const safe = error instanceof WikiError ? error : new WikiError("INTERNAL_ERROR", 500);
    const result = {
      ok: false,
      error: { code: safe.code, message: safe.code, retryable: safe.retryable },
    };
    if (args.includes("--json")) console.log(JSON.stringify(result));
    else console.error(safe.code);
    return wikiExitCode(safe.status);
  }
}
