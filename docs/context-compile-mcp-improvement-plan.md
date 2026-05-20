# Context Compile / MCP 利用導線 改善計画

## 目的

`memory-router` の中核価値は、wiki source、vibe memory、agent diff、distilled knowledge を分離し、次の作業に必要な最小コンテキストを MCP から取り出せることにある。

現状は DB、CLI、MCP、UI、distillation の骨格は揃っているが、`context_compile` がまだ「作業前に信頼して呼ぶ主導線」には届いていない。特に repo 境界、source provenance、MCP tool の使い分け、初回利用時の案内が弱い。

この計画のゴールは、MCP client から次の標準フローで使える状態にすること。

```text
initial_instructions
  -> context_compile(goal, repoPath, files, changeTypes, intent)
  -> 必要時のみ search_knowledge / list_knowledge / update_knowledge / memory_search / memory_fetch
  -> 作業
  -> 再利用可能な学びを register_knowledge
  -> doctor で状態確認
```

## 現状認識

### 既にあるもの

- `context_compile` MCP tool
- `memory_search` / `memory_fetch`
- `register_knowledge` / `list_knowledge` / `update_knowledge`
- `doctor`
- `initial_instructions`
- `context_compile_runs` / `context_pack_items`
- `knowledge_items` / `source_fragments` / `knowledge_source_links`
- vibe/source distillation と draft knowledge

### 弱いところ

1. `context_compile` が repo 境界を扱い切れていない。
   - `repoPath` は schema にあるが、knowledge/source retrieval の主フィルタになっていない。
   - draft を含めると別プロジェクト由来の knowledge が混ざり得る。

2. source provenance が弱い。
   - pack item の `sourceRefs` は source overlap 推定に寄っており、`knowledge_source_links` を十分に使えていない。
   - source 更新・rename・delete 後の stale source / stale fragment が残るリスクがある。

3. MCP 利用パスが薄い。
   - tool 一覧はあるが、どの順番で何を呼ぶべきかが `initial_instructions` から十分に分からない。
   - Gnosis の `initial_instructions` にあるような「使う時 / 避ける時」の短い判断軸がない。

4. `context_compile` の出力が実作業にまだ浅い。
   - selected knowledge の理由、根拠、適用範囲、不足理由が弱い。
   - `files` / `changeTypes` / `technologies` の重みが retrieval に十分反映されていない。
   - no-hit 時に「何が不足しているか」は出るが、次にどの tool を呼ぶべきかが弱い。

5. MCP contract / smoke が薄い。
   - `tools/list` の public surface snapshot がない。
   - `initial_instructions -> context_compile -> doctor` の最小 MCP smoke がない。

## 方針

### Public MCP Surface

短期の canonical surface は次に固定する。

- `initial_instructions`
- `context_compile`
- `search_knowledge`
- `register_knowledge`
- `list_knowledge`
- `update_knowledge`
- `memory_search`
- `memory_fetch`
- `doctor`

既存の `initial_instructions` はあるが、中身を Gnosis 風の短い運用ガイドへ強化する。ユーザー発話にある `initial_instruction` は singular だが、Gnosis 側の実 tool 名は `initial_instructions` なので、この repo でも canonical は plural に揃える。どうしても client 側の typo/alias が必要なら、短期互換 alias を入れる前に public surface の重複コストを評価する。

### Tool の役割

`initial_instructions`
: 最初に一度だけ呼ぶ。常用ルールと MCP tool の使い分けを短く返す。長い API reference や全ルール dump は返さない。

`context_compile`
: 通常の主導線。作業 goal、repoPath、files、changeTypes、technologies、intent を受け取り、実作業に使う最小 pack を返す。

`search_knowledge`
: raw knowledge 候補、score、status、source provenance を見たい時の補助 tool。通常は `context_compile` を優先する。

`memory_search` / `memory_fetch`
: context 圧縮後に raw conversation の具体根拠が必要な時だけ使う。検索して候補を見て、必要な memory だけ fetch する。

`register_knowledge`
: 作業後、次回も使える rule / procedure が得られた時に登録する。まずは `draft` で登録し、必要に応じて `list_knowledge` / `update_knowledge` で運用する。

`doctor`
: DB、pgvector、embedding、LaunchAgent、distillation、MCP public surface、recent compile health を確認する。

## 実装計画

### Phase 1: `context_compile` の正しさを先に直す

対象:

- `src/modules/context-compiler/context-compiler.service.ts`
- `src/modules/knowledge/knowledge.service.ts`
- `src/modules/knowledge/knowledge.repository.ts`
- `src/modules/sources/source-retrieval.service.ts`
- `src/modules/sources/source.repository.ts`
- `src/db/schema.ts`
- `test/context-compiler.integration.test.ts`
- `test/repositories.integration.test.ts`

実装:

1. repo scope を検索条件に入れる。
   - `repoPath` から `repoKey` を正規化する。
   - `knowledge_items.appliesTo` または `metadata` に `repoPath` / `repoKey` / `sourceProject` を保存する。
   - `context_compile` は `repoPath` がある場合、同一 repo / global のみを優先する。
   - no scoped hit の時だけ explicit degraded reason 付きで fallback する。

2. `files` / `changeTypes` / `technologies` を retrieval query に反映する。
   - goal だけではなく、file basename、directory、extension、changeTypes、technologies を query text に含める。
   - file path match は semantic score より強く扱う。

3. ranking を修正する。
   - `rankAndDedupe` は confidence / importance 加味後の score で sort する。
   - source-linked knowledge は同点時に優先する。
   - stale / deprecated / low-confidence は明示的に下げる。

4. source update の整合性を直す。
   - `sources.uri` を unique key とし、同じ URI は同じ source row として更新する。
   - body が変わった時は source row を更新し、fragments を replace する。
   - `reindex` は存在しない source を削除または deprecated/stale 扱いにする。
   - folder rename/delete 時に DB source URI も更新/削除する。

受け入れ条件:

- memory-router の compile で別 repo 由来の draft knowledge が混ざらない。
- 同じ URI の source 更新後、DB 上の source は 1 件に保たれる。
- Source rename/delete 後に Graph / compile へ stale source が出ない。
- `bun run test:integration` に repo scope と source update の回帰テストが入る。

### Phase 2: source provenance を pack の第一級要素にする

対象:

- `src/modules/context-compiler/context-compiler.service.ts`
- `src/modules/context-compiler/pack-renderer.ts`
- `src/modules/context-compiler/context-compiler.repository.ts`
- `src/modules/sources/distillation.repository.ts`
- `src/shared/schemas/context-pack.schema.ts`

実装:

1. `knowledge_source_links` から source refs を引く。
   - overlap 推定は fallback に下げる。
   - source fragment URI、locator、heading を pack item に持たせる。

2. pack に `evidence` / `provenance` を追加する。
   - item ごとに `sourceRefs`, `sourceKind`, `sourceUri`, `locator`, `confidence` を返す。
   - pack-level `sourceRefs` は selected item に紐づくものを優先する。

3. markdown renderer を作業向けにする。
   - `Rules`
   - `Procedures`
   - `Relevant Source Evidence`
   - `File Hints`
   - `Warnings / Missing Context`
   - `Suggested Next MCP Calls`

受け入れ条件:

- source-distilled knowledge が `context_compile` に入った時、どの wiki fragment 由来か追える。
- fallback ref だけの pack は degraded reason を出す。
- `memory-router://packs/latest` で provenance が読める。

### Phase 3: MCP public surface を Gnosis 風に整える

対象:

- `src/mcp/tools/system.tool.ts`
- `src/mcp/tools/context-compile.tool.ts`
- `src/mcp/tools/index.ts`
- `src/mcp/server.ts`
- `test/mcp.contract.test.ts`
- `docs/mcp-tools.md`
- `README.md`

実装:

1. `initial_instructions` を強化する。
   - 出力は `## 常用ルール` と `## MCPツール種別` の 2 セクションにする。
   - 内容は短く固定する。
   - `context_compile` を主導線として明記する。
   - `register_knowledge` / `list_knowledge` / `update_knowledge` の使い分けを明記する。
   - 毎タスク前に長文 rule dump しない。

2. `search_knowledge` tool を追加する。
   - `query`, `repoPath`, `files`, `changeTypes`, `technologies`, `statuses`, `types`, `limit`, `includeDraft`
   - raw 候補確認用であり、通常主導線ではないことを description と docs に明記する。
   - `context_compile` と同じ repo scope / ranking を使う。

3. `context_compile` tool description を usage-first にする。
   - 入力例を docs に追加する。
   - `intent` ごとの使い分けを明記する。
   - no-hit / degraded の時に次に呼ぶ tool を返す。

4. MCP contract test を強化する。
   - `tools/list` の expected names を固定する。
   - `initial_instructions` の主要文言を固定する。
   - `context_compile` の schema と degraded response shape を固定する。
   - `search_knowledge` の raw-result shape を固定する。

受け入れ条件:

- `initial_instructions` を読めば、MCP client が最初に何を呼ぶべきか分かる。
- public surface の増減が test で検知される。
- README と `docs/mcp-tools.md` の tool list がコードと一致する。

### Phase 4: MCP 利用パスの実行可能性を証明する

対象:

- `scripts/`
- `package.json`
- `test/mcp.contract.test.ts`
- `docs/mcp-tools.md`

実装:

1. `mcp:smoke` を追加する。
   - stdio server を起動する。
   - `tools/list` を確認する。
   - `initial_instructions` を呼ぶ。
   - `context_compile` を no-hit / hit の両方で呼ぶ。
   - `doctor` を呼ぶ。

2. `doctor` に MCP surface 診断を追加する。
   - exposed tool names
   - missing primary tools
   - latest compile run status
   - source/knowledge stale count

3. `verify:mcp` を追加する。
   - MCP contract
   - MCP smoke
   - doctor

受け入れ条件:

- Codex / IDE に登録する前に repo-local で MCP 利用パスを再現できる。
- `doctor` だけで tool surface の欠落を見つけられる。
- MCP runtime 変更時に「コードは通るが client から使えない」を減らせる。

### Phase 5: context quality の評価基盤を作る

対象:

- `test/fixtures/context-compile/`
- `test/context-compiler.eval.test.ts`
- `src/modules/context-compiler/*`

実装:

1. 固定 fixture を用意する。
   - repo scoped rule
   - global procedure
   - unrelated repo knowledge
   - source linked knowledge
   - deprecated knowledge
   - raw vibe memory

2. expected pack snapshot を作る。
   - edit / review / debug / architecture / finish
   - includeDraft true/false
   - files あり/なし
   - no source / stale source

3. quality metrics を保存する。
   - selected count
   - sourceRef coverage
   - repo scoped coverage
   - degraded reason
   - foreign knowledge contamination

受け入れ条件:

- `context_compile` の改善が感覚ではなく snapshot と metric で追える。
- foreign knowledge contamination が 0 であることを gate にできる。
- sourceRef coverage が一定未満なら degraded または test failure にできる。

### Phase 6: distillation と MCP をつなぐ

対象:

- `src/modules/distillation/*`
- `src/modules/sources/distillation.service.ts`
- `src/modules/vibe-memory/distillation.service.ts`
- `src/modules/doctor/doctor.service.ts`
- `web/src/modules/admin/components/knowledge.page.tsx`

実装:

1. distillation safety を上げる。
   - `fetch_content` の SSRF 対策を入れる。
   - private IP / localhost / link-local / metadata endpoint を拒否する。
   - redirect 後 URL も検証する。
   - candidate の `evidenceRefs` と実 fetch URL を照合する。

2. draft review loop を MCP と UI へつなぐ。
   - draft knowledge を promote/deprecate する操作を明確化する。
   - `context_compile` は default では active のみ、`includeDraft` は明示時のみ。
   - draft を使った場合は pack warning に出す。

3. 作業後登録の標準化。
   - `initial_instructions` に「verify 後、次回も使える rule/procedure だけ record」方針を入れる。
   - 新規知識登録は `register_knowledge` を主導線とし、運用更新は `list_knowledge` / `update_knowledge` に集約する。

受け入れ条件:

- 外部 URL を含む knowledge は fetch evidence と一致していない限り保存されない。
- draft が勝手に実作業指示へ混ざらない。
- MCP client が作業後に何を保存すべきか判断できる。

## 実装順の推奨

1. Phase 1: repo scope / source update / ranking
2. Phase 3 の `initial_instructions` 強化だけ先行
3. Phase 2: source provenance
4. Phase 3 の `search_knowledge` と docs / contract
5. Phase 4: MCP smoke / doctor
6. Phase 5: context quality eval
7. Phase 6: distillation safety / review loop

`initial_instructions` はすぐ改善してよい。ただし、それだけでは `context_compile` の弱さは隠せないため、Phase 1 を最初の本体作業にする。

## 変更時の品質ゲート

最低限:

```bash
bun run verify
DATABASE_URL=postgres://postgres:postgres@localhost:7889/memory_router_test bun run test:integration
```

Phase 4 以降:

```bash
bun run verify:mcp
bun run doctor
```

UI を触る場合:

```bash
bun run test:e2e
```

Playwright browser が未導入の場合は、先に browser install を済ませる。e2e が実行不能な環境では、代替として dev server の `/`, `/api/health`, `/api/doctor`, `/api/graph` を実リクエストで確認する。

## 非ゴール

- `context_compile` が弱い状態のまま、大きな `agentic_search` 風 orchestrator を先に足さない。
- MCP tool を増やして問題を隠さない。
- raw transcript を compile pack に直接混ぜない。
- wiki source をそのまま active knowledge として扱わない。
- public surface と docs/test がずれた状態で終わらせない。

## 完了判定

この計画が完了したと言える条件:

- MCP client が `initial_instructions` だけで標準利用順序を理解できる。
- `context_compile` が repo scoped で、別 repo knowledge を混ぜない。
- pack item の主要 knowledge に source provenance が付く。
- no-hit / degraded が失敗ではなく、次の行動を示す structured result になる。
- `search_knowledge` は raw 確認用として使え、主導線は `context_compile` に保たれる。
- MCP public surface が contract test と docs で固定される。
- `doctor` が MCP surface と context health を診断できる。
