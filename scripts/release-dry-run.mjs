import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const cargo = await readFile("crates/context-stilld/Cargo.toml", "utf8");
const version = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
assert.equal(version, packageJson.version, "package and crate versions must agree");
const tag = process.env.CONTEXT_STILL_RELEASE_TAG ?? `v${version}`;
assert.equal(tag, `v${version}`, "release tag must match both manifests");
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 900_000 });
  assert.equal(result.status, 0, `${command} failed`);
}
run("bun", ["install", "--frozen-lockfile"]);
run("bun", ["run", "build:web"]);
run("cargo", ["build", "--locked", "--release", "-p", "context-stilld"]);
const output = path.resolve("artifacts/release", `${tag}-${process.platform}-${process.arch}`);
await mkdir(output, { recursive: true });
const filename = process.platform === "win32" ? "context-stilld.exe" : "context-stilld";
await copyFile(path.join("target/release", filename), path.join(output, filename));
const binary = await readFile(path.join(output, filename));
const sha256 = createHash("sha256").update(binary).digest("hex");
const schema = await readFile("crates/context-stilld/src/domains/sqlite_writer/schema.rs", "utf8");
const revision = Number(schema.match(/CURRENT_SCHEMA_REVISION: i64 = (\d+)/)?.[1]);
assert.ok(revision > 0);
const notes = await readFile("CHANGELOG.md", "utf8");
await writeFile(path.join(output, "RELEASE-NOTES.md"), notes);
await writeFile(path.join(output, "SHA256SUMS"), `${sha256}  ${filename}\n`);
const manifest = {
  tag,
  version,
  schemaRevision: revision,
  platform: process.platform,
  arch: process.arch,
  sha256,
  published: false,
  releaseEligible: false,
  reason:
    "Dry-run only: signing, launch identity acceptance and hosted CI results require release review before publication.",
};
await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest));
