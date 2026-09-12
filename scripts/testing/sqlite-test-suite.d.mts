import type { SpawnOptions } from "node:child_process";

export function discoverBunTests(directory: string, prefix?: string): Promise<string[]>;
export function validateSqliteManifest(
  manifest: { version: number; tests: string[] },
  discovered: string[],
): string[];
export function sqliteTestEnvironment(
  inherited: NodeJS.ProcessEnv,
  directory: string,
): NodeJS.ProcessEnv;
export function runTestProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<number>;
