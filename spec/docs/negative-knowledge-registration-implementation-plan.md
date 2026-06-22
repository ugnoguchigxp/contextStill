# Negative Knowledge Registration 実装計画

## 背景

`register_review_corrections` は review correction を negative candidate として登録する専用 MCP tool だが、Postgres 前提の queue / JSON query に依存しており、SQLite backend では duplicate check が失敗する。

一方で、`register_candidate` / `register_candidates` は既に `polarity: "negative"` を受け取れる。SQLite backend では既存経路で直接 Knowledge 登録できるため、negative knowledge 登録はこの I/F に統合する。

## 目的

- `register_review_corrections` を削除する。
- negative knowledge は `register_candidate(s)` の `polarity: "negative"` で登録する。
- positive knowledge の既存 I/F と挙動には極力影響を与えない。
- negative knowledge として成立する最低限の情報だけを追加する。

## 非目的

- positive knowledge の登録フローを再設計しない。
- review correction 専用の詳細 schema を維持しない。
- `finding`、`impact`、`trigger`、`fix`、`verification`、`decisionSignal`、`severity`、`status` のような詳細フィールドを negative knowledge の必須入力にしない。
- `register_candidate` に review system 固有の duplicate check を持ち込まない。

## 最小 I/F

`register_candidate` と `register_candidates` に、negative のときだけ使える最小フィールドを追加する。

```ts
{
  title: string,
  polarity: "negative",
  avoid: string,
  prefer: string,
  technologies: string[],
  changeTypes: string[],
  domains: string[],
  intentTags?: string[],
  appliesTo?: object,
  general?: boolean,
  metadata?: object
}
```

意味:

- `avoid`: 避けるべき判断、実装、運用。
- `prefer`: 代わりに取るべき判断、実装、運用。
- `technologies`: この negative knowledge が適用される具体的な stack、runtime、language、library。
- `changeTypes`: この negative knowledge が適用される変更種別。例: `implementation`、`configuration`、`testing`、`diagnosis`。
- `domains`: この negative knowledge が適用されるプロダクトまたは技術領域。例: `queue`、`database`、`docs`、`security`。
- `general`: 明示的に cross-repository の知識として扱う場合だけ `true` にする。
- `appliesTo`: 呼び出し側が既存形式で適用範囲を渡したい場合に使える。ただし `polarity: "negative"` では `technologies` / `changeTypes` / `domains` と同等の情報を含む必要がある。
- `metadata`: 呼び出し側が必要なら `source` や `reviewFindingId` を任意で残す。

negative knowledge は「何を避けるか」だけではなく、「どの条件で避けるか」がないと LLM に過剰適用されやすい。そのため `polarity: "negative"` では applicability を最低限の成立条件として扱う。

例:

```ts
register_candidate({
  title: "Avoid restoring obsolete linked docs blindly",
  polarity: "negative",
  avoid: "Restoring an obsolete document only because README still links to it.",
  prefer: "If the document is obsolete, delete it and update README links in the same change.",
  technologies: ["markdown"],
  changeTypes: ["docs"],
  domains: ["documentation-maintenance"],
  intentTags: ["docs", "decision-quality"],
  repoPath: "/Users/y.noguchi/Code/contextStill",
  metadata: {
    source: "human-review",
    reviewFindingId: "decision-obsolete-doc-rollback-2026-06-21"
  }
})
```

## Validation

既存 positive path への影響を避けるため、追加 validation は `polarity: "negative"` のときだけ適用する。

- `polarity` が未指定または `"positive"` の場合:
  - 従来通り `body` または `text` を必須にする。
  - `avoid` / `prefer` が指定されていたら schema error にする。
- `polarity: "negative"` の場合:
  - `body` / `text` がない場合は `avoid` と `prefer` を必須にする。
  - `avoid` と `prefer` は trim 後に空であってはならない。
  - `avoid` と `prefer` が同一なら error にする。
  - `technologies` / `changeTypes` / `domains` は、top-level または `appliesTo` のどちらかで必須にする。
  - `technologies` / `changeTypes` / `domains` は trim 後に空でない配列でなければならない。
  - `general: true` は cross-repository の適用を表すが、`domains` / `changeTypes` の省略理由にはしない。一般知識でも適用領域と変更種別は明示する。
  - `type` は常に `"rule"` に正規化する。
  - `type: "procedure"` が指定された場合も negative knowledge では `"rule"` に落とす。

## Body 生成

`polarity: "negative"` かつ `body` / `text` がない場合だけ、`avoid` / `prefer` から body を生成する。

```text
避けること: <avoid>
推奨: <prefer>
```

この形式により、negative knowledge の意味を簡潔に保つ。review correction の詳細ログではなく、将来の判断で使える最小の反証知識として保存する。

## 実装手順

1. `register_review_corrections` MCP tool を削除する。
   - `src/mcp/tools/knowledge.tool.ts` から tool 定義と import を削除する。
   - `src/mcp/tools/index.ts` の exposed / callable tool list から削除する。
   - `src/modules/registerCandidate/register-review-corrections.service.ts` を削除する。
   - 専用 test を削除する。

2. `registerCandidateInputSchema` と bulk schema に `avoid` / `prefer` と applicability fields を追加する。
   - positive path では使用不可にする。
   - negative path で `body` / `text` がない場合だけ body 生成に使う。
   - negative path では `technologies` / `changeTypes` / `domains` を top-level または `appliesTo` から必ず正規化する。
   - `general: true` の場合でも `domains` / `changeTypes` は必須にし、LLM が無条件の禁止事項として誤用しないようにする。

3. `register-candidate.service.ts` の normalize 処理を更新する。
   - negative minimal input を `避けること:` / `推奨:` body に変換する。
   - negative の `type` は `"rule"` に正規化する。
   - negative の applicability は既存の `appliesTo` 正規化 helper に寄せ、SQLite 直接登録 path と Postgres queue path の両方で同じ `appliesTo` を保存する。
   - 既存 SQLite / Postgres 登録経路は変更しない。

4. MCP schema を更新する。
   - `register_candidate` と `register_candidates` に `avoid` / `prefer` / `technologies` / `changeTypes` / `domains` / `general` を公開する。
   - `register_review_corrections` は公開しない。

5. tests を更新する。
   - negative candidate が `avoid` / `prefer` と `technologies` / `changeTypes` / `domains` で登録できる。
   - generated body が `避けること:` / `推奨:` になる。
   - positive candidate は従来通り `body` または `text` 必須。
   - positive candidate に `avoid` / `prefer` を渡すと error。
   - negative candidate で `avoid` または `prefer` が欠けると error。
   - negative candidate で `technologies` / `changeTypes` / `domains` が欠けると error。
   - negative candidate で `appliesTo` 側に `technologies` / `changeTypes` / `domains` を渡しても同じ正規化結果になる。
   - negative candidate の SQLite 直接登録 path で `appliesTo` が保存される。
   - negative candidate の Postgres queue path で payload / origin / found candidate metadata に applicability が流れる。
   - negative candidate の `type: "procedure"` は `"rule"` に正規化される。
   - MCP exposed tools に `register_review_corrections` が含まれない。

## 移行方針

既存の positive knowledge 登録は変更しない。negative review correction を残したい場合は、以後 `register_candidate(s)` を使う。

旧:

```ts
register_review_corrections({
  items: [{
    title,
    finding,
    fix,
    status,
    origin
  }]
})
```

新:

```ts
register_candidate({
  title,
  polarity: "negative",
  avoid,
  prefer,
  technologies,
  changeTypes,
  domains,
  metadata: {
    source: "human-review",
    reviewFindingId
  }
})
```

## 検証

- `bunx vitest run test/register-candidate.service.test.ts test/mcp.tools.test.ts`
- `bun run typecheck`
- `bun run verify`
