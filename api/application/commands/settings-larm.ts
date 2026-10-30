import { exitWith, parseArgs, runCommand, UsageError } from "./shared";

const OPTIONS = { "base-url": "value", clear: "flag" } as const;

function parse(argv: string[]) {
	const args = parseArgs(argv, OPTIONS);
	const baseUrl = args.values.get("base-url");
	const clear = args.flags.has("clear");
	if ((baseUrl === undefined) === !clear)
		throw new UsageError("give exactly one of --base-url <url> or --clear");
	return { baseUrl: clear ? null : (baseUrl as string) };
}

export const settingsLarm = (argv: string[]) =>
	runCommand(
		"settings:larm",
		argv,
		async (runtime) => {
			const { larm } = await runtime.settings.setLarm(parse(argv));
			return { larm };
		},
		{ validate: parse },
	);

if (import.meta.main) exitWith(settingsLarm(process.argv.slice(2)));
