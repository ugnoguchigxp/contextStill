import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

export const steps = [
	"format:check",
	"lint",
	"typecheck",
	"boundaries",
	"test",
	"spec:check",
] as const;

/** Runs each step in order (each a foreground `bun run`), stops at the first failure. */
function main(): number {
	const results: string[] = [];
	for (const step of steps) {
		console.log(`\n[verify] ${step}`);
		const started = performance.now();
		const result = Bun.spawnSync([process.execPath, "run", step], {
			cwd: root,
			stdout: "inherit",
			stderr: "inherit",
		});
		const seconds = ((performance.now() - started) / 1000).toFixed(1);
		const ok = result.exitCode === 0;
		results.push(`${ok ? "ok  " : "FAIL"} ${step} (${seconds}s)`);
		if (!ok) {
			console.error(`\n[verify] ${step} failed (exit ${result.exitCode})`);
			break;
		}
	}
	console.log(`\n[verify] summary\n${results.join("\n")}`);
	return results.length === steps.length &&
		results.every((r) => r.startsWith("ok"))
		? 0
		: 1;
}

if (import.meta.main) process.exit(main());
