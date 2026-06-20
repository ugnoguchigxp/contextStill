import { cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach } from "vitest";

configure({ asyncUtilTimeout: 15000 });

process.env.CONTEXT_STILL_DB_BACKEND ??= "postgres";

afterEach(() => {
  cleanup();
});
