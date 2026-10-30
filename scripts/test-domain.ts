import { resolve } from "node:path";
import { domains, isDomain } from "./domains";

const root = resolve(import.meta.dir, "..");
const name = process.argv.slice(2).find((arg) => arg !== "--");

if (!name || !isDomain(name)) {
	console.error(
		`usage: bun run test:domain -- <${Object.keys(domains).join("|")}>`,
	);
	process.exit(2);
}

const child = Bun.spawn([process.execPath, "test", `api/domains/${name}`], {
	cwd: root,
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await child.exited);
