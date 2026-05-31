#!/usr/bin/env bun

const [command, ...restArgs] = process.argv.slice(2);

async function main(): Promise<void> {
  if (!command || command === "--help" || command === "-h") {
    console.log("Usage: context-still landscape [options]");
    console.log("");
    console.log("Deprecated alias: memory-router");
    return;
  }

  if (command === "landscape") {
    process.argv = [process.argv[0] ?? "bun", "landscape", ...restArgs];
    await import("./landscape.ts");
    return;
  }

  console.error("Usage: context-still landscape [options]");
  if (command) {
    console.error(`Unknown command: ${command}`);
  }
  process.exitCode = 1;
}

await main();
