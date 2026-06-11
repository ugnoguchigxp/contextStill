import { cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom";
import { afterEach } from "vitest";

configure({ asyncUtilTimeout: 15000 });

afterEach(() => {
  cleanup();
});
