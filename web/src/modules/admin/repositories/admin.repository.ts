export type KnowledgeItem = {
  id: string;
  type: string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  metadata?: Record<string, unknown>;
  updatedAt: string;
};

export type SourceDocument = {
  id: string;
  sourceKind: string;
  uri: string;
  title: string | null;
  body?: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
  updatedAt: string;
  lastIndexedAt?: string | null;
};

export type SourceFragment = {
  id: string;
  sourceId: string;
  sourceUri: string;
  locator: string;
  heading?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type VibeMemory = {
  id: string;
  sessionId: string;
  content: string;
  memoryType: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type AiArtifact = {
  id: string;
  vibeMemoryId: string | null;
  artifactType: string;
  filePath: string | null;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type ArtifactSymbol = {
  id: string;
  artifactId: string;
  symbolName: string;
  symbolKind: string;
  signature: string | null;
  content: string | null;
  startLine: number | null;
  endLine: number | null;
  metadata?: Record<string, unknown>;
  updatedAt: string;
};

export type KnowledgeWriteInput = Omit<KnowledgeItem, "id" | "updatedAt">;
export type SourceWriteInput = {
  sourceKind: string;
  uri: string;
  title?: string | null;
  body: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
};
export type SourceFragmentWriteInput = {
  sourceId: string;
  locator: string;
  heading?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
};

export type DoctorReport = {
  status: "ok" | "degraded" | "failed";
  checkedAt: string;
  reasons: string[];
  db: { reachable: boolean; durationMs: number };
  vector: { installed: boolean };
  embedding?: {
    configured: boolean;
    provider: string;
    daemon: { url: string; reachable: boolean; error?: string };
    cli: { python: string; root: string; modelDir: string; usable: boolean; error?: string };
  };
  runs: {
    totalRuns: number;
    degradedRuns: number;
    degradedRate: number;
    lastRunAt: string | null;
  };
};

export type GraphNode = {
  id: string;
  label: string;
  kind: "knowledge" | "source" | "activity";
  group: string;
  detail: string;
  weight: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relationType: string;
  weight: number;
};

export type GraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    knowledgeCount: number;
    sourceCount: number;
    activityCount: number;
    relationCount: number;
  };
};

export type SourceTreeItem = {
  slug: string;
  title: string;
  path: string;
  updatedAt: string;
};

export type SourceFolderItem = {
  path: string;
};

export type SourceTreeResponse = {
  items: SourceTreeItem[];
  folders: SourceFolderItem[];
};

export type SourcePageDocument = {
  slug: string;
  title: string;
  body: string;
  path: string;
  meta: Record<string, unknown>;
};

export type SourceMutationResponse = {
  ok: true;
  slug?: string;
  path?: string;
  from?: string;
  commit: string | null;
  hash?: string;
  movedPages?: Array<{ from: string; to: string }>;
  deletedSlugs?: string[];
};

export type SourceHistoryItem = {
  commit: string;
  author: string;
  date: string;
  message: string;
};

export type SourceHealth = {
  app: string;
  version: string;
  git: {
    branch: string;
    commit: string;
  } | null;
};

export type SourceSearchItem = {
  slug: string;
  excerpt: string;
};

export type SourceReindexResponse = {
  ok: true;
  indexed: number;
  removed: number;
};

export type PageTreeItem = SourceTreeItem;
export type FolderTreeItem = SourceFolderItem;
export type PageTreeResponse = SourceTreeResponse;
export type PageDocument = SourcePageDocument;
export type PageMutationResponse = SourceMutationResponse;
export type FolderMutationResponse = SourceMutationResponse;
export type PageHistoryItem = SourceHistoryItem;
export type HealthResponse = SourceHealth;
export type SearchResultItem = SourceSearchItem;
export type ReindexResponse = SourceReindexResponse;

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function requestJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${url} failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

const encodeSlug = (slug: string): string =>
  slug
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

export async function fetchKnowledgeItems(limit = 80): Promise<KnowledgeItem[]> {
  const json = await getJson<{ items: KnowledgeItem[] }>(`/api/knowledge?limit=${limit}`);
  return json.items;
}

export async function createKnowledgeItem(input: KnowledgeWriteInput): Promise<void> {
  await requestJson("/api/knowledge", "POST", input);
}

export async function updateKnowledgeItem(id: string, input: KnowledgeWriteInput): Promise<void> {
  await requestJson(`/api/knowledge/${id}`, "PUT", input);
}

export async function deleteKnowledgeItem(id: string): Promise<void> {
  await requestJson(`/api/knowledge/${id}`, "DELETE");
}

export async function fetchSources(limit = 80): Promise<SourceDocument[]> {
  const json = await getJson<SourceTreeResponse>("/api/sources/tree");
  return json.items.slice(0, limit).map((item) => ({
    id: item.path,
    sourceKind: "markdown",
    uri: item.path,
    title: item.title,
    body: undefined,
    contentHash: undefined,
    metadata: {},
    updatedAt: item.updatedAt,
    lastIndexedAt: undefined,
  }));
}

export async function createSource(input: SourceWriteInput): Promise<void> {
  await createSourcePage({
    slug: input.uri.replace(/\.md$/i, ""),
    title: input.title?.trim() || input.uri,
    body: input.body,
    meta: input.metadata,
  });
}

export async function updateSource(id: string, input: SourceWriteInput): Promise<void> {
  await updateSourcePage(id.replace(/\.md$/i, ""), {
    slug: input.uri.replace(/\.md$/i, ""),
    title: input.title?.trim() || input.uri,
    body: input.body,
    meta: input.metadata,
  });
}

export async function deleteSource(id: string): Promise<void> {
  await deleteSourcePage(id.replace(/\.md$/i, ""));
}

export async function fetchSourceFragments(limit = 80): Promise<SourceFragment[]> {
  return [];
}

export async function createSourceFragment(input: SourceFragmentWriteInput): Promise<void> {
  throw new Error("source fragment API is disabled");
}

export async function updateSourceFragment(
  id: string,
  input: SourceFragmentWriteInput,
): Promise<void> {
  throw new Error("source fragment API is disabled");
}

export async function deleteSourceFragment(id: string): Promise<void> {
  throw new Error("source fragment API is disabled");
}

// Legacy compatibility for the old Evidence page. New UI should use Source APIs.
export type EvidenceSource = SourceDocument;
export type EvidenceFragment = SourceFragment;
export type EvidenceSourceWriteInput = {
  sourceKind: string;
  uri: string;
  title?: string | null;
  contentHash?: string;
  metadata?: Record<string, unknown>;
};
export type EvidenceFragmentWriteInput = SourceFragmentWriteInput;

export async function fetchEvidenceSources(limit = 80): Promise<EvidenceSource[]> {
  const json = await getJson<{ sources: EvidenceSource[] }>(`/api/evidence/sources?limit=${limit}`);
  return json.sources;
}

export async function createEvidenceSource(input: EvidenceSourceWriteInput): Promise<void> {
  await requestJson("/api/evidence/sources", "POST", input);
}

export async function updateEvidenceSource(
  id: string,
  input: EvidenceSourceWriteInput,
): Promise<void> {
  await requestJson(`/api/evidence/sources/${id}`, "PUT", input);
}

export async function deleteEvidenceSource(id: string): Promise<void> {
  await requestJson(`/api/evidence/sources/${id}`, "DELETE");
}

export async function fetchEvidenceFragments(limit = 80): Promise<EvidenceFragment[]> {
  const json = await getJson<{ fragments: EvidenceFragment[] }>(
    `/api/evidence/fragments?limit=${limit}`,
  );
  return json.fragments;
}

export async function createEvidenceFragment(input: EvidenceFragmentWriteInput): Promise<void> {
  await requestJson("/api/evidence/fragments", "POST", input);
}

export async function updateEvidenceFragment(
  id: string,
  input: EvidenceFragmentWriteInput,
): Promise<void> {
  await requestJson(`/api/evidence/fragments/${id}`, "PUT", input);
}

export async function deleteEvidenceFragment(id: string): Promise<void> {
  await requestJson(`/api/evidence/fragments/${id}`, "DELETE");
}

export async function fetchVibeMemories(limit = 120): Promise<VibeMemory[]> {
  const json = await getJson<{ memories: VibeMemory[] }>(`/api/activity?limit=${limit}`);
  return json.memories;
}

export async function deleteVibeMemory(id: string): Promise<void> {
  await requestJson(`/api/activity/${id}`, "DELETE");
}

export async function fetchAiArtifacts(limit = 100): Promise<AiArtifact[]> {
  const json = await getJson<{ artifacts: AiArtifact[] }>(`/api/artifacts?limit=${limit}`);
  return json.artifacts;
}

export async function fetchArtifactSymbols(limit = 120): Promise<ArtifactSymbol[]> {
  const json = await getJson<{ symbols: ArtifactSymbol[] }>(`/api/artifacts/symbols?limit=${limit}`);
  return json.symbols;
}

export async function fetchDoctorReport(): Promise<DoctorReport> {
  return getJson<DoctorReport>("/api/doctor");
}

export async function fetchGraphSnapshot(limit = 120): Promise<GraphSnapshot> {
  return getJson<GraphSnapshot>(`/api/graph?limit=${limit}`);
}

export async function fetchSourceTree(): Promise<SourceTreeResponse> {
  return getJson<SourceTreeResponse>("/api/sources/tree");
}

export async function fetchSourceHealth(): Promise<SourceHealth> {
  return getJson<SourceHealth>("/api/sources/health");
}

export async function fetchSourcePage(slug: string): Promise<SourcePageDocument> {
  return getJson<SourcePageDocument>(`/api/sources/pages/${encodeSlug(slug)}`);
}

export async function createSourcePage(input: {
  slug: string;
  title: string;
  body: string;
  meta?: Record<string, unknown>;
}): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>("/api/sources/pages", "POST", input);
}

export async function updateSourcePage(
  slug: string,
  input: {
    slug?: string;
    title?: string;
    body: string;
    meta?: Record<string, unknown>;
    commitMessage?: string;
  },
): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(
    `/api/sources/pages/${encodeSlug(slug)}`,
    "PUT",
    input,
  );
}

export async function deleteSourcePage(slug: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/pages/${encodeSlug(slug)}`, "DELETE");
}

export async function createSourceFolder(path: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>("/api/sources/folders", "POST", { path });
}

export async function renameSourceFolder(
  path: string,
  nextPath: string,
): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/folders/${encodeSlug(path)}`, "PUT", {
    path: nextPath,
  });
}

export async function deleteSourceFolder(path: string): Promise<SourceMutationResponse> {
  return requestJson<SourceMutationResponse>(`/api/sources/folders/${encodeSlug(path)}`, "DELETE");
}

export async function fetchSourceHistory(slug: string): Promise<SourceHistoryItem[]> {
  const json = await getJson<{ slug: string; items: SourceHistoryItem[] }>(
    `/api/sources/history/${encodeSlug(slug)}`,
  );
  return json.items;
}

export async function fetchSourceDiff(slug: string, from: string, to: string): Promise<string> {
  const json = await getJson<{ diff: string }>(
    `/api/sources/diff/${encodeSlug(slug)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  return json.diff;
}

export async function searchSourcePages(query: string): Promise<SourceSearchItem[]> {
  const encoded = encodeURIComponent(query.trim());
  const json = await getJson<{ items: SourceSearchItem[] }>(`/api/sources/search?q=${encoded}`);
  return json.items;
}

export async function runSourceReindex(): Promise<SourceReindexResponse> {
  return requestJson<SourceReindexResponse>("/api/sources/reindex", "POST");
}

// Wiki-compatible aliases for the Sources page.
export const fetchHealth = fetchSourceHealth;
export const fetchPageTree = fetchSourceTree;
export const fetchPage = fetchSourcePage;
export const createPage = createSourcePage;
export const updatePage = updateSourcePage;
export const deletePage = deleteSourcePage;
export const fetchPageHistory = fetchSourceHistory;
export const fetchPageDiff = fetchSourceDiff;
export const searchPages = searchSourcePages;
export const runReindex = runSourceReindex;

export async function createFolder(payload: { path: string }): Promise<FolderMutationResponse> {
  return createSourceFolder(payload.path);
}

export async function renameFolder(
  path: string,
  payload: { path: string },
): Promise<FolderMutationResponse> {
  return renameSourceFolder(path, payload.path);
}

export async function deleteFolder(path: string): Promise<FolderMutationResponse> {
  return deleteSourceFolder(path);
}
