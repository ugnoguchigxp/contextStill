import { beforeEach, describe, expect, test, vi } from "vitest";
import { promptStartupPlan } from "../src/modules/onboarding/startup-prompts.js";

let mockAnswers: string[] = [];
let sigintCallback: (() => void) | null = null;

// readline のモック
vi.mock("node:readline", () => {
  const mockRl = {
    on: vi.fn().mockImplementation((event, callback) => {
      if (event === "SIGINT") {
        sigintCallback = callback;
      }
      return mockRl;
    }),
    question: vi.fn().mockImplementation((query, callback) => {
      callback(mockAnswers.shift() ?? "");
    }),
    close: vi.fn(),
  };
  return {
    default: {
      createInterface: vi.fn(() => mockRl),
    },
  };
});

describe("startup-prompts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAnswers = [];
    sigintCallback = null;
  });

  test("runs successful configuration flow with default values (ja, openai, same distill)", async () => {
    // 1. Language Select -> "ja"
    // 2. Database URL -> "postgres://..."
    // 3. Start DB container -> "y"
    // 4. LLM Provider -> "openai"
    // 5. OpenAI Key -> "op-key"
    // 6. OpenAI Base URL -> ""
    // 7. OpenAI Model -> "gpt-4o"
    // 8. Distillation same -> "y"
    // 9. Embedding -> "auto"
    // 10. Wiki root -> "wiki/pages"
    // 11. Import seed -> "y"
    // 12. MCP client -> "generic"
    mockAnswers = [
      "ja",
      "postgres://localhost:5432/db",
      "y",
      "openai",
      "op-key",
      "",
      "gpt-4o",
      "y",
      "auto",
      "wiki/pages",
      "y",
      "generic",
    ];

    const plan = await promptStartupPlan({});

    expect(plan.lang).toBe("ja");
    expect(plan.database.url).toBe("postgres://localhost:5432/db");
    expect(plan.database.startDocker).toBe(true);
    expect(plan.compile.provider).toBe("openai");
    expect(plan.compile.openaiKey).toBe("op-key");
    expect(plan.distillation.provider).toBe("openai");
    expect(plan.project.wikiRoot).toBe("wiki/pages");
    expect(plan.project.importSeed).toBe(true);
    expect(plan.mcpClient).toBe("generic");
  });

  test("runs successful configuration flow with english and other provider (en, local-llm, different distill)", async () => {
    // 1. Language Select -> "en"
    // 2. Database URL -> "postgres://..."
    // 3. Start DB container -> "n"
    // 4. LLM Provider -> "local-llm"
    // 5. Local LLM URL -> "http://localhost:1234"
    // 6. Local LLM Key -> ""
    // 7. Local LLM Model -> "llama3"
    // 8. Distillation same -> "n"
    // 9. Distill provider -> "openai"
    // 10. Distill provider key -> "distill-key" (Wait, distill provider asks config? DistillSame = false will just prompt provider, config details are not prompted separately in promptStartupPlan prompt workflow except compile configuration details depending on compile provider, since only compile provider options branch)
    // Actually, promptStartupPlan doesn't ask config for distillation separately, it only prompts distillProvider and sets it
    // 11. Embedding -> "daemon"
    // 12. Daemon URL -> "http://daemon"
    // 13. Wiki root -> "wiki/pages"
    // 14. Import seed -> "n"
    // 15. MCP client -> "skip"
    mockAnswers = [
      "en",
      "postgres://remotedb:5432/db",
      "n",
      "local-llm",
      "http://localhost:1234",
      "",
      "llama3",
      "n",
      "openai",
      "daemon",
      "http://daemon",
      "wiki/pages",
      "n",
      "skip",
    ];

    const plan = await promptStartupPlan({});

    expect(plan.lang).toBe("en");
    expect(plan.database.startDocker).toBe(false);
    expect(plan.compile.provider).toBe("local-llm");
    expect(plan.compile.localLlmBaseUrl).toBe("http://localhost:1234");
    expect(plan.distillation.provider).toBe("openai");
    expect(plan.embedding.provider).toBe("daemon");
    expect(plan.embedding.daemonUrl).toBe("http://daemon");
    expect(plan.project.importSeed).toBe(false);
    expect(plan.mcpClient).toBe("skip");
  });

  test("runs with invalid provider falls back to default", async () => {
    // 1. Language Select -> "en"
    // 2. Database URL -> "postgres://..."
    // 3. Start DB container -> "n"
    // 4. LLM Provider -> "invalid-provider"
    // 5. Distillation same -> "y"
    // 6. Embedding -> "invalid-embed"
    // 7. Wiki root -> "wiki/pages"
    // 8. Import seed -> "y"
    // 9. MCP client -> "generic"
    mockAnswers = [
      "en",
      "postgres://localhost",
      "y",
      "invalid-provider",
      "y",
      "invalid-embed",
      "wiki/pages",
      "y",
      "generic",
    ];

    const plan = await promptStartupPlan({});
    expect(plan.compile.provider).toBe("openai"); // fallback to openai
    expect(plan.embedding.provider).toBe("auto"); // fallback to auto
  });

  test("runs with azure-openai provider", async () => {
    // 1. Language -> "en"
    // 2. Database URL -> "postgres://..."
    // 3. Start DB container -> "y"
    // 4. LLM Provider -> "azure-openai"
    // 5. Azure Key -> "key"
    // 6. Azure Base -> "http://azure"
    // 7. Azure Model -> "deployment"
    // 8. Azure Version -> "2024-02-15-preview"
    // 9. Distillation same -> "y"
    // 10. Embedding -> "disabled"
    // 11. Wiki root -> "wiki/pages"
    // 12. Import seed -> "y"
    // 13. MCP client -> "generic"
    mockAnswers = [
      "en",
      "postgres://localhost",
      "y",
      "azure-openai",
      "key",
      "http://azure",
      "deployment",
      "2024-02-15-preview",
      "y",
      "disabled",
      "wiki/pages",
      "y",
      "generic",
    ];

    const plan = await promptStartupPlan({});
    expect(plan.compile.provider).toBe("azure-openai");
    expect(plan.compile.azureKey).toBe("key");
    expect(plan.compile.azureBaseUrl).toBe("http://azure");
    expect(plan.compile.azureModel).toBe("deployment");
    expect(plan.compile.azureVersion).toBe("2024-02-15-preview");
    expect(plan.embedding.provider).toBe("disabled");
  });

  test("runs with bedrock provider and invalid distillation fallback", async () => {
    // 1. Language -> "en"
    // 2. Database URL -> "postgres://..."
    // 3. Start DB container -> "y"
    // 4. LLM Provider -> "bedrock"
    // 5. Bedrock Model -> "model-id"
    // 6. Bedrock Region -> "us-east-1"
    // 7. Bedrock Profile -> "default"
    // 8. Distillation same -> "n"
    // 9. Distill provider -> "invalid-distill"
    // 10. Embedding -> "auto"
    // 11. Wiki root -> "wiki/pages"
    // 12. Import seed -> "y"
    // 13. MCP client -> "generic"
    mockAnswers = [
      "en",
      "postgres://localhost",
      "y",
      "bedrock",
      "model-id",
      "us-east-1",
      "default",
      "n",
      "invalid-distill",
      "auto",
      "wiki/pages",
      "y",
      "generic",
    ];

    const plan = await promptStartupPlan({});
    expect(plan.compile.provider).toBe("bedrock");
    expect(plan.compile.bedrockModel).toBe("model-id");
    expect(plan.compile.bedrockRegion).toBe("us-east-1");
    expect(plan.compile.bedrockProfile).toBe("default");
    expect(plan.distillation.provider).toBe("local-llm"); // fallback
  });

  test("SIGINT triggers exit in ask function", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    const mockLog = vi.spyOn(console, "log").mockImplementation(() => {});

    // Prompt flow starts
    const promise = promptStartupPlan({});

    // Simulate SIGINT callback trigger
    if (sigintCallback) {
      sigintCallback();
    }

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("Operation cancelled"));

    mockExit.mockRestore();
    mockLog.mockRestore();
  });
});
