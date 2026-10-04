import type {
  ConnectionInput,
  ConnectionRow,
  ProviderRuntime,
  ProviderTestResult,
  SectionPatch,
} from "../../../../../../src/modules/settings/connection-contracts";
import { getJson, requestJson } from "./http";
export type {
  ConnectionInput,
  ConnectionRow,
  ProviderRuntime,
  ProviderTestResult,
  SectionPatch,
  CredentialUpdate,
  ConnectionKind,
} from "../../../../../../src/modules/settings/connection-contracts";
export type ConnectionListing = {
  connections: ConnectionRow[];
  revision: number;
  tests: Record<string, ProviderTestResult>;
};
const root = "/api/settings";
export const fetchConnections = () => getJson<ConnectionListing>(`${root}/connections`);
export const fetchConnectionRuntime = (id: string) =>
  getJson<ProviderRuntime>(`${root}/connections/${encodeURIComponent(id)}/runtime`);
export const saveConnection = (input: ConnectionInput, id?: string) =>
  requestJson<{ revision: number; value: { id: string } }>(
    id ? `${root}/connections/${encodeURIComponent(id)}` : `${root}/connections`,
    id ? "PATCH" : "POST",
    input,
  );
export const removeConnection = (id: string, revision: number, operationId: string) =>
  requestJson(`${root}/connections/${encodeURIComponent(id)}`, "DELETE", {
    expectedRevision: revision,
    operationId,
  });
export const saveSection = (input: SectionPatch) =>
  requestJson<{ revision: number }>(`${root}/sections`, "PATCH", input);
export const startTest = (
  id?: string,
  draft?: ConnectionInput,
  operationId = crypto.randomUUID(),
) =>
  requestJson<ProviderTestResult>(`${root}/connection-tests`, "POST", { id, draft, operationId });
export const fetchTest = (id: string) =>
  getJson<ProviderTestResult>(`${root}/connection-tests/${encodeURIComponent(id)}`);
export const cancelTest = (id: string) =>
  requestJson<ProviderTestResult>(`${root}/connection-tests/${encodeURIComponent(id)}`, "DELETE");
export type AgentPolicy = {
  windowCeiling: number;
  hardWindowCeiling: number;
  outputTokens: number;
  finalReserve: number;
  runTarget: number;
  runHard: number;
  researchTarget: number;
  researchHard: number;
  maxCalls: number;
  explorationCalls: number;
  revision: string;
  noGainLimit: number;
  fetchFailureLimit: number;
  maxDelegations: number;
  estimate: string;
};
export const fetchAgentPolicy = () => getJson<AgentPolicy>(`${root}/agent-policy`);
export const fetchOperation = (id: string) =>
  getJson<{ revision: number; value: { id?: string } }>(`${root}/operations/${id}`);
