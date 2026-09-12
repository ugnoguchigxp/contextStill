import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { readSparkAvailability } from "../src/modules/codex/spark-runtime.js";
afterEach(() => vi.restoreAllMocks());

it("rejects the next RPC if the process exits between replies and waits for cleanup", async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", 0));
    return true;
  });
  child.stdin.on("data", (buffer) => {
    const event = JSON.parse(buffer.toString());
    if (event.method === "initialize") {
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ id: event.id, result: {} })}\n`);
        child.emit("exit", 0);
      });
    }
  });
  mocks.spawn.mockReturnValue(child);
  await expect(readSparkAvailability("codex")).rejects.toThrow("process exited");
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});
