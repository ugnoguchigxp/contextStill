import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach } from "vitest";

process.env.MEMORY_ROUTER_ALLOW_DESTRUCTIVE_DB_TESTS ??= "1";

afterEach(() => {
  cleanup();
});
