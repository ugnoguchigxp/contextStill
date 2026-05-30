import { describe, it, expect } from "vitest";
import { groupedConfig } from "../src/config.js";

describe("startup-config-env wiring", () => {
  it("should ensure config structure has bedrock, localLlm and agenticCompile", () => {
    expect(groupedConfig.bedrock).toBeDefined();
    expect(groupedConfig.localLlm).toBeDefined();
    expect(groupedConfig.agenticCompile).toBeDefined();
  });

  it("should have correct types for compile provider", () => {
    const provider = groupedConfig.agenticCompile.provider;
    expect(["openai", "local-llm", "azure-openai", "bedrock", "auto"]).toContain(provider);
  });
});
