# Configuration

Configuration is environment-variable based. See `.env.example` for the authoritative list of supported variables and defaults.

## Essential

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:7889/context_still` | PostgreSQL connection |
| `CONTEXT_STILL_SOURCE_CONTENT_ROOT` | `./wiki` | Local wiki/source repository |
| `CONTEXT_STILL_ADMIN_API_KEY` | empty | Optional admin API key |

## LLM Providers

| Variable | Purpose |
|---|---|
| `CONTEXT_STILL_DISTILLATION_PROVIDER` | Main distillation provider: `local-llm`, `azure-openai`, `bedrock`, or `auto` |
| `CONTEXT_STILL_DISTILLATION_FIND_CANDIDATE_PROVIDER` | Optional candidate extraction provider override |
| `CONTEXT_STILL_LOCAL_LLM_API_BASE_URL` | OpenAI-compatible local LLM endpoint |
| `CONTEXT_STILL_LOCAL_LLM_MODEL` | Local LLM model name |
| `CONTEXT_STILL_AZURE_OPENAI_*` | Azure OpenAI endpoint, deployment, and key settings |
| `CONTEXT_STILL_BEDROCK_*` | AWS Bedrock region/model settings |

## Search Providers

| Variable | Purpose |
|---|---|
| `CONTEXT_STILL_DISTILLATION_SEARCH_PROVIDERS` | Ordered providers for `search_web` |
| `BRAVE_SEARCH_API_KEY` | Brave Search API key |
| `CONTEXT_STILL_EXA_API_KEY` / `EXA_API_KEY` | Exa API key |

## Embedding

| Variable | Default | Purpose |
|---|---|---|
| `CONTEXT_STILL_EMBEDDING_PROVIDER` | `auto` | `auto`, `daemon`, `cli`, or `disabled` |
| `CONTEXT_STILL_EMBEDDING_DAEMON_URL` | `http://127.0.0.1:44512` | Embedding daemon URL |
| `CONTEXT_STILL_EMBEDDING_DIMENSION` | `384` | Vector dimension |
| `CONTEXT_STILL_LOCAL_LLM_EMBEDDING_*` | varies | CLI embedding fallback settings |

## Agent Log Sync

| Variable | Purpose |
|---|---|
| `CONTEXT_STILL_CODEX_SESSION_DIR` | Primary Codex session directory |
| `CONTEXT_STILL_CODEX_SESSION_DIRS` | Additional Codex session roots |
| `CONTEXT_STILL_CODEX_ARCHIVED_SESSION_DIRS` | Additional Codex archived-session roots |
| `CONTEXT_STILL_ANTIGRAVITY_LOG_DIR` | Primary Antigravity log directory |
| `CONTEXT_STILL_ANTIGRAVITY_LOG_DIRS` | Additional Antigravity log roots |
| `CONTEXT_STILL_CLAUDE_PROJECTS_DIR` | Claude projects directory |
| `CONTEXT_STILL_AGENT_LOG_SYNC_INTERVAL_SECONDS` | LaunchAgent / scheduled sync interval |
| `CONTEXT_STILL_AGENT_LOG_INITIAL_LOOKBACK_HOURS` | Initial import lookback window |

## Local-First Notes

- Use local LLM and local embedding services to keep distillation local.
- Omit external search API keys if you do not want distillation to call external search providers.
- The wiki/source root is local filesystem content and is managed as its own Git repository when possible.
- Integration tests truncate data and must target a dedicated test database.
