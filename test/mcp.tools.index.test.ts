import { beforeEach, describe, expect, test, vi } from "vitest";
import { readProjectEnv } from "../src/project-identity.js";
import { getExposedToolEntries, getCallableToolEntries } from "../src/mcp/tools/index.js";

vi.mock("../src/project-identity.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    readProjectEnv: vi.fn(),
  };
});

describe("mcp/tools/index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("uses V2 tools by default when environment is not set", () => {
    vi.mocked(readProjectEnv).mockReturnValue(undefined);

    const exposed = getExposedToolEntries();
    const callable = getCallableToolEntries();

    // Check that compile_eval exists in V2 exposed list
    expect(exposed.map((t) => t.name)).toContain("compile_eval");
    expect(callable.map((t) => t.name)).toContain("compile_eval");
    expect(callable.map((t) => t.name)).toContain("search_memory");
  });

  test("uses V2 tools when environment is explicitly enabled", () => {
    for (const val of ["1", "true", "yes", "on", "  TRUE  "]) {
      vi.mocked(readProjectEnv).mockReturnValue(val);
      const exposed = getExposedToolEntries();
      expect(exposed.map((t) => t.name)).toContain("compile_eval");
    }
  });

  test("uses V1 tools when environment is explicitly disabled", () => {
    for (const val of ["0", "false", "no", "off", "  false  "]) {
      vi.mocked(readProjectEnv).mockReturnValue(val);
      const exposed = getExposedToolEntries();
      const callable = getCallableToolEntries();

      // Check compile_eval is NOT in V1 exposed list
      expect(exposed.map((t) => t.name)).not.toContain("compile_eval");
      expect(callable.map((t) => t.name)).not.toContain("compile_eval");
      expect(exposed.map((t) => t.name)).toContain("read_file");
    }
  });
});
