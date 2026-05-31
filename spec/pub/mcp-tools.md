# MCP Tools

context-still exposes a compact MCP surface for coding agents. The tools are designed around a repeatable workflow:

```text
initial_instructions -> vibe_memory_peek -> context_compile -> work -> vibe_memory_* -> compile_eval -> register_candidate(s)
```

## Tool Inventory

| Tool | Primary use |
|---|---|
| `initial_instructions` | Load operating rules and hook guidance once per project session |
| `context_compile` | Compile task-specific context before work |
| `compile_eval` | Record post-task usefulness of compiled context |
| `search_knowledge` | Inspect raw knowledge candidates and retrieval behavior |
| `register_candidate` | Register one reusable rule/procedure candidate |
| `register_candidates` | Register multiple candidates in one call |
| `vibe_memory_peek` | Read Goal Room brief and open loops before work |
| `vibe_memory_say` | Add a Capsule to a Goal Room |
| `vibe_memory_reply` | Reply to an existing Capsule |
| `vibe_memory_mark` | Mark Capsule state such as resolved or pinned |
| `search_memory` | Search past sessions and diffs |
| `fetch_memory` | Fetch one memory item |
| `doctor` | Diagnose DB, embedding, sync, queue, provider, and compile health |

Deprecated hidden aliases remain for compatibility but are not listed:

- `memory_search` -> `search_memory`
- `memory_fetch` -> `fetch_memory`

The old slot-based `session_memo` workflow has been replaced by Goal Room Memory through the `vibe_memory_*` tools.

## Recommended Agent Workflow

1. Call `initial_instructions` once when starting work in this project.
2. Call `vibe_memory_peek` for the relevant `goalId`.
3. Call `context_compile` with the actual task goal.
4. Do the work and verify changes.
5. Use `vibe_memory_say`, `vibe_memory_reply`, or `vibe_memory_mark` for findings, decisions, questions, and resolved loops.
6. Call `compile_eval` for the compile run used during the task.
7. Call `register_candidate` or `register_candidates` for durable lessons discovered during the task.
8. Call `doctor` if compile output is weak, stale, degraded, or failed.

## Tool Contracts

### `initial_instructions`

Purpose: Return project operating guidance for agents.

Input: none.

Output:

- Common rules.
- Goal Room Memory usage guidance.
- MCP tool categories.
- Hook/compile evaluation reminders.

Use once at project-session start. Do not call before every small subtask unless the session context has been lost.

### `context_compile`

Purpose: Produce a task-specific context pack.

Input:

| Field | Required | Description |
|---|---:|---|
| `goal` | yes | Natural-language task goal. Use a milestone or problem statement, not a document path. |
| `changeTypes` | no | Tags such as `bugfix`, `docs`, `backend`, `plan`. |
| `technologies` | no | Technology tags such as `typescript`, `bun`, `react`. |
| `domains` | no | Domain tags such as `context-compiler`, `onboarding`, `queue`. |

Output:

- Markdown context pack.
- Compile run metadata.
- Diagnostics and degraded reasons when available.

Behavior:

- The result emphasizes implementation focus, steps, and verification points.
- If no useful knowledge is selected, output can be `No Content`.
- A weak compile result should not stop the workflow. Use `doctor`, docs, and direct repository inspection to supplement it.

### `compile_eval`

Purpose: Persist a post-task evaluation of a compile run.

Input:

| Field | Required | Description |
|---|---:|---|
| `score` | yes | Integer from `0` to `100`. |
| `outcome` | yes | `useful`, `partial`, `misleading`, or `unused`. |
| `body` | yes | Short rationale. |
| `runId` | no | Explicit compile run ID. If omitted, latest session compile is used when resolvable. |
| `title` | no | Short label for the evaluation. |

Use after completing the task that used `context_compile`.

### `search_knowledge`

Purpose: Inspect raw retrieval candidates when compile output needs investigation.

Input:

| Field | Required | Description |
|---|---:|---|
| `query` | yes | Search query. |
| `repoPath` | no | Scope search to a repository path. |
| `changeTypes` | no | Change-type tags. |
| `technologies` | no | Technology tags. |
| `domains` | no | Domain tags. |
| `types` | no | Knowledge types such as `rule` or `procedure`. |
| `statuses` | no | Knowledge statuses. |
| `limit` | no | Maximum result count. |
| `includeDraft` | no | Include draft knowledge. |

Output includes candidates, scores, status, scope, source refs, metadata, degraded reasons, and stats.

### `register_candidate`

Purpose: Register one reusable lesson as a distillation candidate.

Input:

| Field | Required | Description |
|---|---:|---|
| `title` + `body` | conditional | Structured candidate text. |
| `text` | conditional | Free-form candidate text. Use when the candidate is easier to express as one note. |
| `type` | no | `rule` or `procedure`. |
| `confidence` | no | Confidence score. |
| `importance` | no | Importance/value score. |
| `metadata` | no | Additional trace metadata. |

At least `title` + `body` or `text` is required.

Behavior:

- Writes a `knowledge_candidate` target.
- Writes candidate content into `find_candidate_results`.
- Returns immediately; draft knowledge creation happens asynchronously through the distillation pipeline.

### `register_candidates`

Purpose: Register multiple candidates.

Input:

| Field | Required | Description |
|---|---:|---|
| `items` | yes | Array of 1 to 10 candidate objects using the `register_candidate` shape. |

Behavior is best-effort. Inspect the result for per-item failures.

### `vibe_memory_peek`

Purpose: Preview Goal Room context before work.

Input:

| Field | Required | Description |
|---|---:|---|
| `goalId` | yes | Stable Goal Room identifier. |
| `profile` | no | Capability/profile hints such as `code-review` or `implementation`. |

Output:

- Brief.
- Open loops.
- Relevant recent Capsules.

Use before starting work when the task belongs to an ongoing goal.

### `vibe_memory_say`

Purpose: Add a Capsule to a Goal Room timeline.

Input:

| Field | Required | Description |
|---|---:|---|
| `goalId` | yes | Goal Room identifier. |
| `intent` | yes | Intent such as `ask`, `note`, `finding`, `review`, `decision`. |
| `text` | yes | Capsule body. |
| `goalUri` | no | External or repository URI for the goal. |
| `goalAnchorRef` | no | File/path/anchor reference. |
| `wants` | no | Requested follow-up. |
| `refs` | no | Supporting references. |
| `confidence` | no | Confidence score. |
| `actorId` | no | Actor identifier. |
| `ttlHours` | no | Optional time-to-live hint. |

### `vibe_memory_reply`

Purpose: Reply to an existing Capsule.

Input:

| Field | Required | Description |
|---|---:|---|
| `goalId` | yes | Goal Room identifier. |
| `parentId` | yes | Parent Capsule ID. |
| `intent` | yes | Reply intent. |
| `text` | yes | Reply body. |
| `subject` | no | Short subject. |
| `wants` | no | Requested follow-up. |
| `refs` | no | Supporting references. |
| `confidence` | no | Confidence score. |
| `actorId` | no | Actor identifier. |

### `vibe_memory_mark`

Purpose: Attach deterministic state to a Capsule.

Input:

| Field | Required | Description |
|---|---:|---|
| `goalId` | yes | Goal Room identifier. |
| `targetMemoryId` | yes | Capsule ID. |
| `mark` | yes | Mark such as `resolved`, `stale`, or `pinned`. |
| `note` | no | Short explanation. |
| `actorId` | no | Actor identifier. |

Use when an open loop is resolved, a checkpoint should be pinned, or stale work should be marked.

### `search_memory`

Purpose: Search past conversations and diffs.

Input:

| Field | Required | Description |
|---|---:|---|
| `query` | yes | Search query. |
| `sessionId` | no | Restrict to a session. |
| `limit` | no | Maximum result count. |
| `includeContent` | no | Include full content instead of previews. |
| `previewChars` | no | Preview length. |

### `fetch_memory`

Purpose: Fetch a specific memory item.

Input:

| Field | Required | Description |
|---|---:|---|
| `id` | yes | Memory ID. |
| `start` | no | Start offset or line boundary. |
| `end` | no | End offset or line boundary. |
| `maxChars` | no | Maximum returned characters. |
| `query` | no | Highlight/search hint. |
| `includeAgentDiffs` | no | Include related diff entries. |
| `returnMetaOnly` | no | Return metadata without content. |

### `doctor`

Purpose: Diagnose system health.

Input: none.

Output includes:

- DB and expected table status.
- pgvector status.
- Embedding provider status.
- LLM provider health.
- Agent log sync state.
- Queue and distillation state.
- Compile run health.
- Knowledge lifecycle warnings.

Use when task context is unexpectedly empty, stale, degraded, or when automation appears stopped.

## Failure Handling

| Condition | Recommended response |
|---|---|
| `context_compile` returns `No Content` | Run `doctor`, inspect docs/code, and continue with direct repository evidence. |
| `doctor` reports DB failure | Check `DATABASE_URL`, Docker containers, and migrations. |
| Search tools return no matches | Broaden query/tags, inspect source imports, and check knowledge status. |
| Candidate registration succeeds but no draft appears | Check queue status and distillation logs. |
| Goal Room is noisy | Use `vibe_memory_mark` to resolve/stale old Capsules and `vibe_memory_say` to pin a new decision. |

## Client Configuration

Generic MCP client configuration:

```json
{
  "mcpServers": {
    "context-still": {
      "command": "bun",
      "args": ["run", "start:mcp"],
      "cwd": "/path/to/contextStill"
    }
  }
}
```

Call `initial_instructions` once after the client connects to this project.
