import type {
  ResearchAcknowledgeRequest,
  ResearchAcknowledgeResponse,
  ResearchEngineCapabilities,
  ResearchJobRef,
  ResearchJobStatus,
  ResearchResult,
  ResearchSubmitRequest,
  SourceConnectorCapabilities,
  SourceFetchRequest,
  SourceSearchRequest,
  SourceSearchResponse,
  SourceSnapshot,
} from "../../shared/schemas/research-plugin-v1.schema.js";

export interface ResearchEnginePort {
  capabilities(): Promise<ResearchEngineCapabilities>;
  submit?(request: ResearchSubmitRequest): Promise<ResearchJobRef>;
  status?(pluginJobId: string): Promise<ResearchJobStatus>;
  result?(pluginJobId: string): Promise<ResearchResult>;
  cancel?(pluginJobId: string): Promise<ResearchJobStatus>;
  acknowledge?(request: ResearchAcknowledgeRequest): Promise<ResearchAcknowledgeResponse>;
}

export interface SourceConnectorPort {
  capabilities(): Promise<SourceConnectorCapabilities> | SourceConnectorCapabilities;
  search?(request: SourceSearchRequest, signal: AbortSignal): Promise<SourceSearchResponse>;
  fetch?(request: SourceFetchRequest, signal: AbortSignal): Promise<SourceSnapshot>;
}
