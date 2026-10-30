# Contributing

Thank you for considering a contribution to context-still.

## Before You Start

1. Open an issue for substantial behavior changes.
2. Keep pull requests focused and reviewable.
3. Preserve local-first behavior and auditability.
4. Keep public user documentation in `spec/docs/pub/` (Markdown).
5. Keep internal design notes and implementation plans in `spec/docs/` (Spec HTML).

## Development Setup

Requirements: Bun 1.4.4 only.

```bash
git clone https://github.com/ugnoguchigxp/contextStill.git
cd contextStill
bun install
```

## Verification

Run the gate before opening a pull request:

```bash
bun run verify
```

It runs, in order and stopping at the first failure: `format:check`, `lint`, `typecheck`, `boundaries`, `test`, `spec:check`. Run the tests of one domain with:

```bash
bun run test:domain -- <name>
```

Tests never start a server or reach the network: `scripts/test-preload.ts` blocks `fetch` and `Bun.serve`, so use `app.request()`, temporary directories, and injected `fetch` fixtures. Do not point a test at a real database.

After editing a Spec HTML document under `spec/docs/`, run `bun run spec:fix` and then `bun run spec:check`.

## Pull Request Checklist

- The change is scoped to one topic.
- Tests or focused verification were run.
- Public docs were updated when user-facing behavior changed.
- Internal design docs were updated when architecture or implementation plans changed.
- Secrets, API keys, and local personal paths were not committed.

## Commit Style

Use clear imperative commit messages, for example:

```text
Add queue supervisor retry status
Fix GitHub Pages project base URL
Document MCP compile_eval workflow
```
