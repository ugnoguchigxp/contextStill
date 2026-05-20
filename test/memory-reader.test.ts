if (typeof (globalThis as any).Bun === "undefined") {
  (globalThis as any).Bun = {
    markdown: {
      render: (markdown: string, callbacks: any) => {
        let result = markdown;
        result = result.replace(/^#\s+(.+)$/gm, (_, p1) =>
          callbacks.heading ? callbacks.heading(p1) : `${p1}\n\n`,
        );
        result = result.replace(/\*\*(.*?)\*\*/g, (_, p1) =>
          callbacks.strong ? callbacks.strong(p1) : p1,
        );
        return result;
      },
    },
  };
}

import { describe, expect, it } from "vitest";
import { prepareMemoryReaderContent } from "../src/modules/memoryReader/domain.js";

describe("prepareMemoryReaderContent", () => {
  it("should compress memory text by stripping markdown, minifying, and deduping phrases", () => {
    const result = prepareMemoryReaderContent({
      text: "# Title\nsame phrase here。same phrase here。",
      mode: "compressed",
      contentKind: "memory",
    });

    expect(result).toBe("Title same phrase here");
  });

  it("should preserve diff syntax while compressing diff whitespace", () => {
    const result = prepareMemoryReaderContent({
      text: "+++ src/example.ts\nimport value from '../../lib/value.js'\n",
      mode: "compressed",
      contentKind: "diff",
    });

    expect(result).toContain("../../lib/value.js");
    expect(result).toContain("+++ src/example.ts");
  });

  it("should return original content unchanged in original mode", () => {
    const text = "# Title\n**important**\n";
    const result = prepareMemoryReaderContent({
      text,
      mode: "original",
      contentKind: "memory",
    });

    expect(result).toBe(text);
  });
});
