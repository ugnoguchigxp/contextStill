#!/bin/bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done

SCRIPT_ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"

resolve_repo_root() {
  if [ -n "${MEMORY_ROUTER_CANDIDATE_HOOK_REPO_ROOT:-}" ]; then
    cd "$MEMORY_ROUTER_CANDIDATE_HOOK_REPO_ROOT"
    git rev-parse --show-toplevel 2>/dev/null || pwd
    return 0
  fi
  git rev-parse --show-toplevel 2>/dev/null || true
}

sanitize_repo_key() {
  local value="$1"
  printf "%s" "$value" | sed -e 's|^/||' -e 's|[^A-Za-z0-9._-]|_|g'
}

REPO_ROOT="$(resolve_repo_root)"
if [ -z "$REPO_ROOT" ]; then
  echo "[memory-router] candidate reminder skipped: not inside a git worktree"
  exit 0
fi

cd "$REPO_ROOT"

COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
if [ -z "$COMMIT_SHA" ]; then
  echo "[memory-router] candidate reminder skipped: no HEAD commit"
  exit 0
fi

SHORT_SHA="$(git rev-parse --short=12 "$COMMIT_SHA")"
SUBJECT="$(git log -1 --format=%s "$COMMIT_SHA")"
AUTHOR="$(git log -1 --format='%an <%ae>' "$COMMIT_SHA")"
COMMITTED_AT="$(git log -1 --format=%cI "$COMMIT_SHA")"
REPO_KEY="$(sanitize_repo_key "$REPO_ROOT")"
if [ -n "${MEMORY_ROUTER_CANDIDATE_HOOK_LOG_DIR:-}" ]; then
  LOG_DIR="$MEMORY_ROUTER_CANDIDATE_HOOK_LOG_DIR"
elif [ "$REPO_ROOT" = "$SCRIPT_ROOT" ]; then
  LOG_DIR="$SCRIPT_ROOT/logs/post-commit-candidate-reminders"
else
  STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/memory-router/post-commit-candidate-reminders"
  LOG_DIR="$STATE_ROOT/$REPO_KEY"
fi
PROMPT_FILE="$LOG_DIR/$SHORT_SHA.md"
LATEST_FILE="$LOG_DIR/latest.md"

mkdir -p "$LOG_DIR"

CHANGED_FILES="$(git show --name-only --format= "$COMMIT_SHA" | sed '/^$/d' | sed -n '1,80p')"
STAT_SUMMARY="$(git show --stat --format= "$COMMIT_SHA" | sed -n '1,80p')"

cat > "$PROMPT_FILE" <<EOF
# Post-commit candidate registration prompt

Commit: $SHORT_SHA
Subject: $SUBJECT
Author: $AUTHOR
Committed: $COMMITTED_AT
Repository: $REPO_ROOT

## Ask the coding agent

Review this commit and register reusable lessons, rules, or procedures through the memory-router MCP tool \`register_candidate\` when there is a durable lesson.

Do not register one-off task notes, unverified guesses, file-specific trivia, or generic best practices that are not grounded in this commit.

Prefer a \`procedure\` candidate when the lesson is operational. Use this body shape:

\`\`\`md
Use when:
- ...

Failure pattern:
- ...

Root cause:
- ...

Workflow:
1. ...
2. ...

Verification:
- ...

Avoid:
- ...

Evidence:
- Commit $SHORT_SHA
- ...
\`\`\`

If no reusable lesson exists, report that no candidate should be registered.

## Useful evidence commands

\`\`\`bash
git show --stat --oneline $COMMIT_SHA
git show --name-only --format= $COMMIT_SHA
git show --format=fuller --stat $COMMIT_SHA
\`\`\`

## Changed files

\`\`\`txt
$CHANGED_FILES
\`\`\`

## Stat summary

\`\`\`txt
$STAT_SUMMARY
\`\`\`
EOF

ln -sf "$(basename "$PROMPT_FILE")" "$LATEST_FILE"

if [ "${MEMORY_ROUTER_CANDIDATE_HOOK_QUIET:-0}" != "1" ]; then
  cat <<EOF
[memory-router] post-commit candidate reminder
  commit: $SHORT_SHA $SUBJECT
  prompt: $LATEST_FILE
  action: ask the coding agent to review the commit and call register_candidate only for durable lessons
EOF
fi
