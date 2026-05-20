# Context Compiler UI 改修 実装計画

## Go / No-Go

この計画は、この版で実装に移れる状態にする。

前版のままでは No-Go。理由は、`GET /api/context/runs/:id` を足すだけでは過去の `ContextPack` を完全に復元できないため。現在の `context_pack_items` は `itemKind` / `itemId` / `section` / `score` / `rankingReason` / `sourceRefs` しか保存しておらず、`title` / `content` / `minimalTasks` / `warnings` / `diagnostics` は残っていない。後から `knowledge_items` を再検索して補うと、compile 実行時点の成果物ではなく「現在の知識状態」になってしまう。

この版では、まず新規 compile run について exact snapshot を保存し、その snapshot を UI 詳細表示の正とする。既存の legacy run は無理に復元せず、メタデータと selected item refs だけを表示する。

## 目的

`context_compile` の手動実行と MCP / CLI 経由の実行履歴を、同じ画面で追跡できる 2 カラムの運用 UI にする。

- 左: Recent Runs の縦リスト。goal、source、status、intent、retrievalMode、latency、createdAt を素早く比較できる。
- 右: 選択 run の detail、または new compile form。
- detail: compile input、retrieval / error context / agentic refine / token budget の trace、最終 `ContextPack`、warnings、source refs を表示する。
- 新規実行: UI から compile した結果を即座に右 pane に出し、左 run list と detail endpoint を同期する。

## 現状確認

### 既にあるもの

- `api/modules/context-compiler/context-compiler.routes.ts`
  - `POST /api/context/compile`
  - `GET /api/context/runs`
- `src/modules/context-compiler/context-compiler.repository.ts`
  - `insertCompileRun`
  - `insertContextPackItems`
  - `listRecentCompileRuns`
  - `getCompileRunSnapshot`
- `src/modules/context-compiler/context-compiler.service.ts`
  - `compileContextPack` が `ContextPack` を生成する。
  - `diagnostics.retrievalStats` に `knowledge`, `sources`, `tokenBudget`, `compileDurationMs`, `agenticUsed`, `agenticReasoning`, `errorContext`, `suggestedNextCalls` が入る。
- `web/src/modules/context-compiler/components/context-compiler.page.tsx`
  - 現在は single-column の compile form、Recent Runs table、Last Compile Result。
- `web/src/modules/context-compiler/repositories/context-compiler.repository.ts`
  - `compilePack`
  - `fetchRecentRuns`
- `web/src/modules/context-compiler/hooks/context-compiler.hooks.ts`
  - `useCompileRuns`
  - `useCompilePack`

### 現状の不足

- run detail API がない。
- run summary に source がないため UI / MCP / CLI の識別ができない。
- historical pack の exact snapshot が保存されていない。
- `getCompileRunSnapshot` は selected item refs の snapshot であり、UI に必要な full `ContextPack` ではない。
- frontend は run を選択して詳細を見る状態管理を持っていない。
- Current UI は table 中心で、debug cockpit として trace を追いにくい。

## スコープ

### 実装する

- compile run に `source` と `packSnapshot` を保存する。
- `GET /api/context/runs/:id` を追加する。
- frontend repository / hook に run detail fetch を追加する。
- Context Compiler page を 2 カラム UI に再構成する。
- 新規 compile 後に該当 run を選択状態にし、detail を表示する。
- Playwright smoke を新 UI に合わせて更新する。

### 実装しない

- 既存 legacy run の exact pack 復元。
- WebSocket / SSE による live streaming。
- `context_compile` の retrieval / ranking ロジック改修。
- `vibeMemoryId` link。現行 compile input / run schema に会話 ID がないため、別計画で session link field を足すまで UI に出さない。
- ガラスモフィズムや全面 dark theme。既存 app shell / shadcn-style tokens に合わせ、作業用 UI として情報密度と可読性を優先する。

## データ設計

### DB migration

追加 migration:

- `drizzle/0025_context_compile_run_snapshots.sql`
- `drizzle/meta/_journal.json`

SQL 方針:

```sql
ALTER TABLE "context_compile_runs"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS "pack_snapshot" jsonb;

ALTER TABLE "context_compile_runs"
  ADD CONSTRAINT "context_compile_runs_source_check"
  CHECK ("source" IN ('ui','mcp','cli','unknown'));

CREATE INDEX IF NOT EXISTS "context_compile_runs_source_idx"
  ON "context_compile_runs" ("source");
```

注意:

- `pack_snapshot` は nullable。migration 前の run と、万一 snapshot parse に失敗した run を扱うため。
- `source` の default は `unknown`。過去 row を MCP と誤表示しない。
- `createdAt` は現状 insert 時刻であり、compile 完了付近の記録時刻として扱う。新しい `completedAt` column は追加しない。

### Drizzle schema

対象:

- `src/db/schema.ts`

変更:

- `contextCompileRuns.source = text("source").notNull().default("unknown")`
- `contextCompileRuns.packSnapshot = jsonb("pack_snapshot")`
- `sourceIdx`
- `sourceCheck`

### Shared schema

対象:

- `src/shared/schemas/compile-run.schema.ts` を新設する。

型:

```ts
export const compileRunSourceSchema = z.enum(["ui", "mcp", "cli", "unknown"]);

export const compileRunSummarySchema = z.object({
  id: z.string().uuid(),
  goal: z.string(),
  intent: z.string(),
  retrievalMode: retrievalModeSchema,
  status: z.enum(["ok", "degraded", "failed"]),
  degradedReasons: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
  source: compileRunSourceSchema,
  createdAt: z.string().datetime(),
});

export const compileRunSelectedItemSchema = z.object({
  itemKind: z.string(),
  itemId: z.string(),
  section: z.string(),
  score: z.number(),
  rankingReason: z.string(),
  sourceRefs: z.array(z.string()),
});

export const compileRunInputSnapshotSchema = compileInputSchema
  .partial()
  .extend({ goal: z.string().optional() })
  .passthrough();

export const compileRunDetailSchema = z.object({
  run: compileRunSummarySchema.extend({
    tokenBudget: z.number().int().nonnegative(),
    input: compileRunInputSnapshotSchema,
  }),
  pack: contextPackSchema.nullable(),
  selectedItems: z.array(compileRunSelectedItemSchema),
  snapshotAvailable: z.boolean(),
});
```

API response は `{ detail: CompileRunDetail }` に固定する。

## Backend 実装

### 1. Repository

対象:

- `src/modules/context-compiler/context-compiler.repository.ts`
- `api/modules/context-compiler/context-compiler.repository.ts`

`src` repository の変更:

- `CompileRunSource` type を追加する。
- `CompileRunSummary` に `source` を追加する。
- `insertCompileRun(params)` に `source?: CompileRunSource` を追加し、default は `unknown`。
- `listRecentCompileRuns` で `source` を select / normalize する。
- `updateCompileRunSnapshot(runId, pack)` を追加する。
- `getCompileRunDetail(runId)` を追加する。

`getCompileRunDetail` の仕様:

- run がなければ `null`。
- `context_compile_runs` から `id`, `goal`, `intent`, `retrievalMode`, `status`, `degradedReasons`, `durationMs`, `source`, `createdAt`, `tokenBudget`, `input`, `packSnapshot` を select する。
- `context_pack_items` は従来通り `runId` で select し、`selectedItems` として返す。
- `packSnapshot` は `contextPackSchema.safeParse` する。
- parse 成功なら `pack` に入れ、`snapshotAvailable: true`。
- `packSnapshot` がない、または parse 失敗なら `pack: null`, `snapshotAvailable: false`。
- legacy fallback として `ContextPack` を捏造しない。`contextPackSchema` は item content を必須にしているため、空 content の fake pack を作らない。

`api` repository の変更:

- `getRunDetail(runId)` を追加し、`src` repository の `getCompileRunDetail` を呼ぶだけにする。

### 2. Compile service

対象:

- `src/modules/context-compiler/context-compiler.service.ts`
- `src/mcp/tools/context-compile.tool.ts`
- `src/cli/compile.ts`
- `src/cli/init-project.ts`
- `api/modules/context-compiler/context-compiler.repository.ts`

`compileContextPack` の signature:

```ts
export async function compileContextPack(
  rawInput: unknown,
  options?: { source?: CompileRunSource },
): Promise<{ pack: ContextPack; markdown: string }>;
```

caller source:

- API UI route: `source: "ui"`
- MCP tool: `source: "mcp"`
- CLI compile/init-project: `source: "cli"`
- tests / direct calls: default `unknown`

実装順序:

1. input parse / retrieval / ranking / agentic refine は現状維持。
2. `insertCompileRun({ ..., source: options?.source ?? "unknown" })` で `runId` を作る。
3. `insertContextPackItems` は現状維持。
4. `ContextPack` を `contextPackSchema.parse` で作る。
5. `await updateCompileRunSnapshot(runId, pack)` を呼ぶ。
6. audit log / markdown rendering は現状維持。

注意:

- `packSnapshot` 更新に失敗したら compile 自体を failed にしない。pack は caller に返す。ただし `recordAuditLogSafe` と同様に safe wrapper にするか、catch して `console.warn` 相当の扱いにする。UI の detail は `snapshotAvailable: false` になる。
- `ContextPack` は runId を含むため、run insert より前には作れない。この順序を守る。

### 3. API service / route

対象:

- `api/modules/context-compiler/context-compiler.service.ts`
- `api/modules/context-compiler/context-compiler.routes.ts`

追加:

```ts
export const getRunDetailParamSchema = z.object({
  id: z.string().uuid(),
});

export async function getRunDetailForApi(input: unknown) {
  const { id } = getRunDetailParamSchema.parse(input);
  const detail = await getRunDetail(id);
  return detail;
}
```

route:

```ts
.get("/runs/:id", zValidator("param", getRunDetailParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const detail = await getRunDetailForApi({ id });
  if (!detail) return c.json({ error: "Compile run not found." }, 404);
  return c.json({ detail });
})
```

route order:

- `GET /runs` と `GET /runs/:id` はどちらでも動くはずだが、読みやすさのため `GET /runs` の直後に `GET /runs/:id` を置く。

serialization:

- API service で `createdAt` は `toISOString()` に変換してから `compileRunDetailSchema.parse` する。
- `degradedReasons` / `sourceRefs` は配列でなければ `[]`。
- `source` は allowed values 以外なら `unknown`。

## Frontend 実装

### 1. Repository types / API functions

対象:

- `web/src/modules/context-compiler/repositories/context-compiler.repository.ts`

変更:

- `CompileRunSource = "ui" | "mcp" | "cli" | "unknown"`
- `CompileRunSummary.source`
- `CompileRunDetail`
- `CompileRunSelectedItem`
- `fetchRunDetail(runId: string): Promise<CompileRunDetail>`

API:

```ts
export async function fetchRunDetail(runId: string): Promise<CompileRunDetail> {
  const response = await fetch(`/api/context/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) throw new Error(`Fetch run detail failed: ${response.status}`);
  const json = (await response.json()) as { detail: CompileRunDetail };
  return json.detail;
}
```

### 2. Hooks

対象:

- `web/src/modules/context-compiler/hooks/context-compiler.hooks.ts`

追加:

```ts
export function useCompileRunDetail(runId: string | null) {
  return useQuery({
    queryKey: ["compile-run-detail", runId],
    queryFn: () => fetchRunDetail(runId as string),
    enabled: Boolean(runId),
  });
}
```

`useCompilePack` の onSuccess:

- `invalidateQueries({ queryKey: ["compile-runs"] })`
- `setQueryData` は必須にしない。新規 compile 後は selected run ID を page state で切り替え、detail query が取る。
- ただし UI は detail query の loading 中に `compile.data` を temporary pack として表示してよい。

### 3. Page state

対象:

- `web/src/modules/context-compiler/components/context-compiler.page.tsx`

状態:

```ts
const [activeRunId, setActiveRunId] = useState<string | null>(null);
const [mode, setMode] = useState<"new" | "detail">("new");
const [sourceFilter, setSourceFilter] =
  useState<"all" | CompileRunSource>("all");
const [statusFilter, setStatusFilter] =
  useState<"all" | "ok" | "degraded" | "failed">("all");
```

挙動:

- 初期表示は `mode = "new"`。
- Recent run click:
  - `setActiveRunId(run.id)`
  - `setMode("detail")`
- `+ New Compile`:
  - `setMode("new")`
  - `setActiveRunId(null)`
- Compile success:
  - `setActiveRunId(pack.runId)`
  - `setMode("detail")`
  - form はそのまま残してよい。次回入力を消すかどうかはこの実装では必須にしない。
- runs refetch 後、active run が list に見つからない場合も detail pane は維持する。

### 4. UI decomposition

同一 file 内で小さな helper component に分ける。新規 file 分割は必須ではない。

- `RunSidebar`
- `RunListItem`
- `CompileFormPane`
- `RunDetailPane`
- `Timeline`
- `TimelineStep`
- `PackSection`
- `SourceRefsList`
- `LegacySnapshotNotice`

lucide icons:

- `Plus`
- `Search`
- `AlertTriangle`
- `Brain`
- `Gauge`
- `FileText`
- `RefreshCw`
- `Terminal`

### 5. Detail timeline

`RunDetailPane` は `detail.pack` がある場合、次の順で timeline を作る。

1. `Input`
   - `goal`, `intent`, `retrievalMode`, `repoPath`, `files`, `includeDraft`, `tokenBudget`
   - source badge: `ui` / `mcp` / `cli` / `unknown`
2. `Retrieval`
   - `pack.rules.length`
   - `pack.procedures.length`
   - `pack.codeContext.length`
   - `retrievalStats.knowledge.textHitCount`
   - `retrievalStats.knowledge.vectorHitCount`
   - `retrievalStats.knowledge.mergedCount`
   - `retrievalStats.sources.hitCount`
   - `retrievalStats.sources.textHitCount`
   - `retrievalStats.sources.vectorHitCount`
   - scoped fallback flags if present
3. `Error Context`
   - `detail.run.input.errorKind`
   - `detail.run.input.lastErrorContext?.command`
   - `detail.run.input.lastErrorContext?.files`
   - `retrievalStats.errorContext.keywordCount`
   - `retrievalStats.errorContext.fileHintCount`
   - 入力がなければ `Not supplied`
4. `Agentic Refine`
   - `retrievalStats.agenticUsed`
   - `retrievalStats.agenticReasoning`
   - `AGENTIC_REFINE_FAILED` が `degradedReasons` にある場合は warning
5. `Budget`
   - `retrievalStats.tokenBudget`
   - `retrievalStats.compileDurationMs`
   - `TOKEN_BUDGET_SECTION_LIMIT_REACHED` がある場合は warning
6. `Output`
   - `minimalTasks`
   - `rules`
   - `procedures`
   - `codeContext`
   - `warnings`
   - `sourceRefs`

`detail.pack` がない legacy run:

- Header と selectedItems を表示する。
- `LegacySnapshotNotice` に「この run は pack snapshot 保存前の履歴のため、実行時点の title/content/diagnostics は復元できません」と出す。
- `knowledge_items` を現在値で join して本文を見せない。

### 6. Layout / CSS

対象:

- `web/src/styles.css`

追加 class:

- `.context-compiler-shell`
- `.compile-sidebar`
- `.compile-sidebar-header`
- `.compile-filter-row`
- `.compile-run-list`
- `.compile-run-item`
- `.compile-run-item.active`
- `.compile-main`
- `.compile-detail-header`
- `.compile-timeline`
- `.compile-timeline-step`
- `.compile-pack-output`
- `.compile-pack-section`
- `.compile-code-badge-list`
- `.compile-empty-state`

layout:

- desktop: `grid-template-columns: minmax(280px, 360px) minmax(0, 1fr)`
- mobile/tablet: single column。sidebar が上、detail/form が下。
- page height: `calc(100vh - 64px)` を上限にし、sidebar/list と main pane は個別 scroll。
- Cards は repeated run item と top-level pane にのみ使う。card inside card は避ける。
- Button / label text は折り返し可能にし、mobile で overflow させない。
- palette は既存 `--background`, `--foreground`, `--border`, `--muted`, `--accent`, `--destructive` を使う。新しい強い purple/blue gradient は追加しない。

## Test 計画

### Unit / API

対象:

- `test/context-compiler-repository.test.ts`
- `test/context-compiler.service.test.ts`
- `test/api.routes.test.ts`

追加ケース:

- `insertCompileRun` が `source` を保存する。
- `updateCompileRunSnapshot` が `pack_snapshot` を更新する。
- `getCompileRunDetail` が valid snapshot を parse して返す。
- `getCompileRunDetail` が missing run で `null`。
- `getCompileRunDetail` が legacy run で `pack: null`, `snapshotAvailable: false`。
- `compileContextPack(..., { source: "mcp" })` が snapshot update を呼ぶ。
- `GET /api/context/runs/:id` が `{ detail }` を返す。
- `GET /api/context/runs/:id` missing は 404。
- invalid UUID は 400。
- `GET /api/context/runs` の summary に `source` が入る。

### E2E / UI smoke

対象:

- `e2e/ui-smoke.spec.ts`

mock 追加:

- `GET **/api/context/runs/run-1`

検証:

- `/compile` で `Context Compiler Control Plane` が表示される。
- left sidebar に `sample run` と `ui` / `ok` badge が表示される。
- `sample run` click で detail pane が `Retrieval`, `Agentic Refine`, `Output` を表示する。
- `+ New Compile` click で form が表示される。
- goal 空のまま Compile click で `Goal is required.` が出て、`POST /api/context/compile` は呼ばれない。
- compile 成功 mock 後、right pane が compiled pack に切り替わる。
- legacy detail mock では `snapshot 保存前` notice が出る。

### Quality gate

実装後に最低限:

```sh
bun run typecheck
bun run lint
bun run format:check
bun run test:unit
bun run build:web
bunx playwright test e2e/ui-smoke.spec.ts
```

DB migration を触るため、環境がある場合は追加で:

```sh
DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:7889/memory_router_test} bun run db:migrate
DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:7889/memory_router_test} MEMORY_ROUTER_RUN_DB_TESTS=1 bun test --timeout=30000 --max-concurrency=1 test/*.integration.test.ts
```

## 実装順序

1. DB schema / migration を追加する。
2. shared `compile-run.schema.ts` を追加する。
3. repository に `source`, `packSnapshot`, detail read/write を追加する。
4. `compileContextPack` に source option と snapshot persistence を追加し、MCP / CLI / API caller から source を渡す。
5. `GET /api/context/runs/:id` を追加する。
6. backend / route tests を更新する。
7. frontend repository / hooks を更新する。
8. `context-compiler.page.tsx` を 2 カラム UI に置き換える。
9. `web/src/styles.css` に layout / timeline styles を追加する。
10. `e2e/ui-smoke.spec.ts` を更新する。
11. quality gate を実行し、失敗した箇所を直す。

## 受け入れ条件

- 新規 UI compile run は `context_compile_runs.source = 'ui'` と `pack_snapshot` を保存する。
- MCP 経由 run は `source = 'mcp'`、CLI 経由 run は `source = 'cli'` で保存される。
- `GET /api/context/runs/:id` は新規 run で exact `ContextPack` を返す。
- legacy run では exact pack を捏造せず、`snapshotAvailable: false` と selected item refs を返す。
- `/compile` は desktop で 2 カラム、narrow viewport で single column になる。
- Recent Runs の item click で detail pane が更新される。
- `diagnostics.retrievalStats` の retrieval / agentic / budget 情報が timeline として読める。
- warning / degraded reason / suggested next calls が detail pane から見える。
- empty state、loading、error、404、legacy snapshot unavailable の表示がある。
- `bun run verify` 相当と targeted Playwright smoke が通る。

## 注意点

- `context_pack_items` は引き続き集計・軽量履歴用として残す。UI detail の本文は `pack_snapshot` を正とする。
- `source` は compile input schema には入れない。公開 MCP input contract を増やさず、caller option と DB metadata として扱う。
- `agenticReasoning` は内部推論ではなく、agentic refine provider が返した短い選別理由だけを表示する。値がない場合は空欄にする。
- detail API は snapshot の JSON を blind trust しない。必ず `contextPackSchema.safeParse` してから返す。
- `ContextPack` schema を将来変えた場合、古い snapshot が parse できなくなる可能性がある。その場合は `snapshotAvailable: false` に落とし、UI は legacy notice と selected item refs を出す。
