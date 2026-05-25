import { describe, expect, it } from "vitest";
import { resolveCostRate } from "../src/modules/llm/llm-cost-config.js";

describe("llm-cost-config", () => {
  it("resolves gpt-5.4-mini pricing", () => {
    expect(resolveCostRate("gpt-5-4-mini")).toEqual({
      inputJpyPerM: 112.5,
      outputJpyPerM: 675,
    });
  });

  it("resolves gpt-5.4-nano pricing", () => {
    expect(resolveCostRate("gpt-5.4-nano")).toEqual({
      inputJpyPerM: 30,
      outputJpyPerM: 187.5,
    });
  });

  it("resolves claude haiku aliases", () => {
    expect(resolveCostRate("claude-haiku-4-5")).toEqual({
      inputJpyPerM: 150,
      outputJpyPerM: 750,
    });
    expect(resolveCostRate("claude-4.6-haiku")).toEqual({
      inputJpyPerM: 150,
      outputJpyPerM: 750,
    });
  });
});
