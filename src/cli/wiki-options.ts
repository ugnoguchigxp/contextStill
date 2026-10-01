import {
  WikiError,
  strictWikiSlug,
  validateRequestId,
} from "../modules/sources/wiki/wiki-contract.js";
export type WikiOptions = {
  command: "list" | "get" | "create" | "update";
  slug?: string;
  title?: string;
  file?: string;
  stdin: boolean;
  json: boolean;
  format?: "markdown";
  ifVersion?: string;
  requestId?: string;
  extract?: boolean;
};
export function parseWikiOptions(args: string[]): WikiOptions {
  const [command, ...rest] = args;
  if (!["list", "get", "create", "update"].includes(command ?? ""))
    throw new WikiError("INVALID_ARGUMENTS", 400);
  const options: WikiOptions = {
    command: command as WikiOptions["command"],
    stdin: false,
    json: false,
  };
  const seen = new Set<string>();
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      if (options.slug) throw new WikiError("INVALID_ARGUMENTS", 400);
      options.slug = strictWikiSlug(token);
      continue;
    }
    if (seen.has(token)) throw new WikiError("INVALID_ARGUMENTS", 400);
    seen.add(token);
    if (["--json", "--stdin", "--extract", "--no-extract"].includes(token)) continue;
    if (
      !["--title", "--file", "--format", "--if-version", "--request-id"].includes(token) ||
      !rest[i + 1] ||
      rest[i + 1]?.startsWith("--")
    )
      throw new WikiError("INVALID_ARGUMENTS", 400);
    values[token] = rest[++i];
  }
  options.json = seen.has("--json");
  options.stdin = seen.has("--stdin");
  options.title = values["--title"];
  options.file = values["--file"];
  options.ifVersion = values["--if-version"];
  options.requestId = values["--request-id"];
  if (seen.has("--extract") || seen.has("--no-extract")) options.extract = seen.has("--extract");
  if (seen.has("--extract") && seen.has("--no-extract"))
    throw new WikiError("INVALID_ARGUMENTS", 400);
  const write = command === "create" || command === "update";
  if (command === "list" ? options.slug !== undefined : !options.slug)
    throw new WikiError("INVALID_ARGUMENTS", 400);
  if (write) {
    if (
      Boolean(options.file) === options.stdin ||
      options.extract === undefined ||
      !options.requestId ||
      values["--format"] ||
      (command === "create" && !options.title?.trim()) ||
      (command === "update" && !/^sha256:[a-f0-9]{64}$/.test(options.ifVersion ?? "")) ||
      (command === "create" && options.ifVersion)
    )
      throw new WikiError("INVALID_ARGUMENTS", 400);
    validateRequestId(options.requestId);
  } else if ([...seen].some((t) => !["--json", "--format"].includes(t)))
    throw new WikiError("INVALID_ARGUMENTS", 400);
  if (values["--format"]) {
    if (command !== "get" || options.json || values["--format"] !== "markdown")
      throw new WikiError("INVALID_ARGUMENTS", 400);
    options.format = "markdown";
  }
  return options;
}
