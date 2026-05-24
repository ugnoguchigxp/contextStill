#!/usr/bin/env bun

const [command, ...restArgs] = process.argv.slice(2);

async function main(): Promise<void> {
  if (command === "landscape") {
    process.argv = [process.argv[0] ?? "bun", "landscape", ...restArgs];
    await import("./landscape.ts");
    return;
  }

  console.error("Usage: memory-router landscape [options]");
  if (command) {
    console.error(`Unknown command: ${command}`);
  }
  process.exitCode = 1;
}

await main();
