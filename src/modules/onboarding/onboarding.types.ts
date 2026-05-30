import type { SupportedLocale } from "../../shared/locales/locale.js";
import type {
  AgenticCompileProvider,
  DistillationProvider,
  EmbeddingProvider,
} from "../../config.types.js";

export interface StartupPlan {
  lang: SupportedLocale;
  database: {
    provider: "postgres"; // SQLite is Slice 2
    url: string;
    startDocker: boolean;
  };
  compile: {
    provider: AgenticCompileProvider;
    openaiKey?: string;
    openaiBaseUrl?: string;
    openaiModel?: string;
    azureKey?: string;
    azureBaseUrl?: string;
    azureModel?: string;
    azureVersion?: string;
    bedrockModel?: string;
    bedrockRegion?: string;
    bedrockProfile?: string;
    localLlmBaseUrl?: string;
    localLlmKey?: string;
    localLlmModel?: string;
  };
  distillation: {
    provider: DistillationProvider;
    findCandidateProvider: DistillationProvider;
  };
  embedding: {
    provider: EmbeddingProvider;
    daemonUrl?: string;
    accessToken?: string;
  };
  project: {
    wikiRoot: string;
    importSeed: boolean;
  };
  mcpClient: "generic" | "cursor" | "cline" | "claude-desktop" | "skip";
}

export interface LlmHealthResult {
  ok: boolean;
  provider: AgenticCompileProvider;
  message: string;
  error?: string;
}
