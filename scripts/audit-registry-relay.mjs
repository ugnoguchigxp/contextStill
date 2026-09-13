import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const advisoryUrl = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
// Keep Bun's lockfile parsing and advisory format. Only the outbound HTTPS transport changes.
export function startAuditRegistryRelay(env) {
  const prefix = `/${randomBytes(24).toString("hex")}`;
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 45,
    maxRequestBodySize: 8 * 1024 * 1024,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== `${prefix}/-/npm/v1/security/advisories/bulk` ||
        requests !== 0
      )
        return new Response("Not found", { status: 404 });
      requests++;
      const body = Buffer.from(await request.arrayBuffer());
      const encoding = request.headers.get("content-encoding");
      if (encoding && encoding !== "gzip")
        return new Response("Unsupported encoding", { status: 415 });
      const args = [
        "--disable",
        "--silent",
        "--show-error",
        "--fail-with-body",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        "--proto",
        "=https",
        "--request",
        "POST",
        "--header",
        "Content-Type: application/json",
        "--header",
        "Accept: application/json",
      ];
      if (encoding) args.push("--header", `Content-Encoding: ${encoding}`);
      args.push("--data-binary", "@-", advisoryUrl);
      return new Promise((resolve) => {
        const child = spawn("curl", args, { env, stdio: ["pipe", "pipe", "pipe"] });
        const chunks = [];
        let bytes = 0;
        const timer = setTimeout(() => child.kill("SIGKILL"), 35_000);
        child.stdout.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) child.kill("SIGKILL");
          else chunks.push(chunk);
        });
        child.stderr.resume();
        child.stdin.on("error", () => {});
        child.on("error", () => {
          clearTimeout(timer);
          resolve(new Response("Audit transport unavailable", { status: 502 }));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(
            code === 0
              ? new Response(Buffer.concat(chunks), {
                  headers: { "content-type": "application/json" },
                })
              : new Response("Audit transport unavailable", { status: 502 }),
          );
        });
        child.stdin.end(body);
      });
    },
  });
  return {
    registry: `${server.url.origin}${prefix}`,
    close: () => server.stop(true),
    requests: () => requests,
  };
}
