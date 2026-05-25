import type { DistillationSearchProvider } from "../../config.types.js";

export type DistillationToolResult = {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  metadata?: Record<string, unknown>;
  error?: string;
};

export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

export type SearchProviderName = DistillationSearchProvider;

export type SearchProviderRateLimit = {
  status?: number;
  limit?: string;
  remaining?: string;
  reset?: string;
  policy?: string;
  retryAfter?: string;
  retryAfterSeconds?: number;
};

export type SearchProviderResponse = {
  provider: SearchProviderName;
  results: SearchResult[];
  rateLimit?: SearchProviderRateLimit;
};

export type SearchProviderErrorState = {
  message: string;
  status?: number;
  rateLimited?: boolean;
  retryAfterSeconds?: number;
  rateLimit?: SearchProviderRateLimit;
};

export type SearchProviderCooldownEntry = {
  cooldownUntil?: string;
  updatedAt?: string;
  lastError?: string;
  lastRateLimit?: SearchProviderRateLimit;
};

export type SearchProviderCooldownState = Partial<
  Record<SearchProviderName, SearchProviderCooldownEntry>
>;

export const distillationSearchProviderStateId = "distillation_search_providers";
export const providerNames: SearchProviderName[] = ["brave", "exa", "duckduckgo"];

export class SearchProviderException extends Error {
  readonly provider: SearchProviderName;
  readonly status?: number;
  readonly rateLimited: boolean;
  readonly retryAfterSeconds?: number;
  readonly rateLimit?: SearchProviderRateLimit;

  constructor(params: {
    provider: SearchProviderName;
    message: string;
    status?: number;
    rateLimited?: boolean;
    retryAfterSeconds?: number;
    rateLimit?: SearchProviderRateLimit;
  }) {
    super(params.message);
    this.name = "SearchProviderException";
    this.provider = params.provider;
    this.status = params.status;
    this.rateLimited = params.rateLimited ?? false;
    this.retryAfterSeconds = params.retryAfterSeconds;
    this.rateLimit = params.rateLimit;
  }
}
