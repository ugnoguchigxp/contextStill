# Contributing

Thank you for considering a contribution to context-still.

## Before You Start

1. Open an issue for substantial behavior changes.
2. Keep pull requests focused and reviewable.
3. Preserve local-first behavior and auditability.
4. Keep public user documentation in `spec/pub/`.
5. Keep internal implementation plans and design notes in `spec/docs/`.

## Development Setup

```bash
git clone https://github.com/ugnoguchigxp/contextStill.git
cd contextStill
bun install
docker compose up -d
cp .env.example .env
bun run db:migrate
```

## Verification

Run the daily fast gate before opening a pull request:

```bash
bun run verify
```

Run the full release gate before tagging or cutting a release:

```bash
bun run verify:full
```

For MCP changes:

```bash
bun run verify:mcp
```

For queue operational changes:

```bash
bun run verify:queue:smoke
```

`bun run verify` is intentionally limited to typecheck, lint, format check, unit tests, and web build. Integration tests and queue smoke are destructive. Use only a dedicated test database whose name includes `test`.

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
