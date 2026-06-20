#!/bin/bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done

SCRIPT_ROOT="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"
MODE="${1:-post-commit}"

timestamp_utc() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

resolve_log_file() {
  if [ -n "${CONTEXT_STILL_CANDIDATE_HOOK_LOG_FILE:-}" ]; then
    printf "%s" "$CONTEXT_STILL_CANDIDATE_HOOK_LOG_FILE"
    return 0
  fi
  printf "%s" "${XDG_STATE_HOME:-$HOME/.local/state}/context-still/hook-events.log"
}

append_hook_log() {
  local message="$1"
  local log_file
  log_file="$(resolve_log_file)"
  mkdir -p "$(dirname "$log_file")"
  printf "%s [%s] %s\n" "$(timestamp_utc)" "$MODE" "$message" >> "$log_file" 2>/dev/null || true
}

if [ "$MODE" = "pre-commit" ]; then
  append_hook_log "pre-commit reminder emitted"
  echo "[context-still] pre-commit reminder"
  echo "  if this task used context_compile and it returned content, compile_eval is required before final completion report"
  echo "  if this task followed context_decision, record context_decision_feedback when outcome is known"
  echo "  if compile_eval is needed, ask user first: Fill compile_eval now? (Yes/No)"
  exit 0
fi

resolve_repo_root() {
  if [ -n "${CONTEXT_STILL_CANDIDATE_HOOK_REPO_ROOT:-}" ]; then
    cd "$CONTEXT_STILL_CANDIDATE_HOOK_REPO_ROOT"
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
  append_hook_log "skipped: not inside a git worktree"
  echo "[context-still] candidate reminder skipped: not inside a git worktree"
  exit 0
fi

cd "$REPO_ROOT"

COMMIT_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
if [ -z "$COMMIT_SHA" ]; then
  append_hook_log "skipped: no HEAD commit"
  echo "[context-still] candidate reminder skipped: no HEAD commit"
  exit 0
fi

SHORT_SHA="$(git rev-parse --short=12 "$COMMIT_SHA")"
SUBJECT="$(git log -1 --format=%s "$COMMIT_SHA")"
AUTHOR="$(git log -1 --format='%an <%ae>' "$COMMIT_SHA")"
COMMITTED_AT="$(git log -1 --format=%cI "$COMMIT_SHA")"
REPO_KEY="$(sanitize_repo_key "$REPO_ROOT")"
if [ -n "${CONTEXT_STILL_CANDIDATE_HOOK_LOG_DIR:-}" ]; then
  LOG_DIR="$CONTEXT_STILL_CANDIDATE_HOOK_LOG_DIR"
elif [ "$REPO_ROOT" = "$SCRIPT_ROOT" ]; then
  LOG_DIR="$SCRIPT_ROOT/logs/post-commit-candidate-reminders"
else
  STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/context-still/post-commit-candidate-reminders"
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

## コーディングエージェントに必要なアクション

このコミットを確認し、将来にわたって再利用可能なレッスン、ルール、または手順（手続き）が含まれているかを判断してください。

再利用可能な知見が存在する場合は、context-still の MCP ツール \`register_candidates\` を呼び出して登録してください。コミット内容の要約だけで終わらせないでください。

一回限りのタスクメモ、未検証の仮説、ファイル固有のトリビア、またはこのコミットに裏付けられていない一般的なベストプラクティスは登録しないでください。

レッスンが運用手順である場合は、\`procedure\` タイプの候補を優先し、以下の構成で記述してください：

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
- コミット $SHORT_SHA
- ...
\`\`\`

再利用可能なレッスンが存在しない場合は、登録すべき候補がない旨を報告してください。

【重要】\`context_compile\` を利用したコーディング作業が完了した後は、\`No Content\` 以外の runId について MCP ツール \`compile_eval\` を実行し、以下を保存してください：
- 5つの詳細評価指標: \`relevance\`, \`actionability\`, \`coverage\`, \`clarity\`, \`specificity\` (すべて 0〜100 の数値)
- 評価結果 (\`useful\` / \`partial\` / \`misleading\` / \`unused\`)
- 評価コメントである \`body\` (※極力、日本語を用いて具体的かつ詳細に記述することが強く推奨されます)
- 同一セッション内に複数の \`context_compile\` 実行がある場合は、直近の tool 実行結果や作業ログで runId を確認し、\`No Content\` 以外の runId に対して個別に評価を保存してください（\`runId\` を明示的に渡してください）
- \`No Content\` 以外の評価対象がある場合、完了前にまずユーザーへ確認してください: 「今から compile_eval を入力しますか？ (Yes/No)」 Yes なら直ちに実行します。
- 完了報告の前に、以下の件数を自己申告してください：
  - このタスクでの \`context_compile\` の実行回数
  - このタスクでの \`compile_eval\` の実行回数
  - \`No Content\` 以外の runId で評価回数が不足している場合は、先に不足分の \`compile_eval\` を追加実行してから完了報告を行ってください

【重要】\`context_decision\` を利用した判断に従って作業した場合は、作業結果が分かった時点で MCP ツール \`context_decision_feedback\` を保存してください。pre-commit 時点で検証結果が分かっている場合は、そのタイミングで記録してください：
- 成功した場合: \`source\` は \`system\` または \`ai\`、\`outcome\` は \`success\`
- 失敗、回帰検出、ユーザー上書き、PR破棄などの場合: \`outcome\` は \`failed\` / \`regression_found\` / \`user_overrode\` / \`discarded_pr\`
- まだ結果不明の場合: \`outcome\` は \`still_unknown\`
- \`context_decision\` の戻り値に含まれる \`decisionId\` または \`feedbackHandle\` を使って対象判断へ紐付けてください

候補登録の前に、\`register_candidates\` のための選出準備を行ってください：
- 再利用可能な手順やルールのみを含めること
- 汎用的に使える知識として体裁を整えること
- プロジェクト固有の事実、個人名、パス名、一回限りのインシデント詳細は除外すること
- 次のラウンドで迅速に登録できるよう、候補を整えておくこと

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
append_hook_log "wrote prompt=$PROMPT_FILE latest=$LATEST_FILE commit=$SHORT_SHA"

if [ "${CONTEXT_STILL_CANDIDATE_HOOK_QUIET:-0}" != "1" ]; then
  cat <<EOF
[context-still] post-commit candidate reminder
  commit: $SHORT_SHA $SUBJECT
  prompt: $LATEST_FILE
  action: ask the coding agent to review the commit, call register_candidates for durable lessons, call compile_eval for context_compile quality, and call context_decision_feedback for completed decisions
EOF
fi
