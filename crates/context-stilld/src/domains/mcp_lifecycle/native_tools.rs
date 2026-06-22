use std::path::PathBuf;

use serde_json::{json, Value};

use super::native_handlers;
use super::native_resources;

#[derive(Debug, Clone)]
pub(crate) struct NativeToolContext {
    pub(crate) project_root: PathBuf,
    pub(crate) sqlite_core_path: PathBuf,
}

pub(crate) fn handle_native_dispatch(
    method: &str,
    params: &Value,
    context: &NativeToolContext,
) -> Option<Value> {
    match method {
        "tools/list" => Some(json!({ "tools": exposed_tools() })),
        "resources/list" => Some(native_resources::list_resources()),
        "resources/read" => Some(native_resources::read_resource(params, context)),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match name {
                "initial_instructions" => Some(initial_instructions_result()),
                "context_compile" => Some(native_handlers::context_compile(params, context)),
                "doctor" => Some(native_handlers::doctor(context)),
                "compile_eval" => Some(native_handlers::compile_eval(params, context)),
                "context_decision" => Some(native_handlers::context_decision(params, context)),
                "context_decision_feedback" => {
                    Some(native_handlers::context_decision_feedback(params, context))
                }
                "search_knowledge" => Some(native_handlers::search_knowledge(params, context)),
                "register_candidates" => {
                    Some(native_handlers::register_candidates(params, context))
                }
                "search_memory" => Some(native_handlers::search_memory(params, context)),
                "fetch_memory" => Some(native_handlers::fetch_memory(params, context)),
                "search_episodes" => Some(native_handlers::search_episodes(params, context)),
                "fetch_episode" => Some(native_handlers::fetch_episode(params, context)),
                _ => None,
            }
        }
        _ => None,
    }
}

pub(crate) fn exposed_tool_count() -> usize {
    exposed_tools().as_array().map(Vec::len).unwrap_or(0)
}

pub(crate) fn tool_owner_inventory() -> Value {
    json!({
        "rustNative": [
            "initial_instructions",
            "context_compile",
            "compile_eval",
            "context_decision",
            "context_decision_feedback",
            "search_knowledge",
            "register_candidates",
            "search_memory",
            "fetch_memory",
            "search_episodes",
            "fetch_episode",
            "doctor"
        ],
        "tsSidecar": [],
        "disabled": [],
        "counts": {
            "rustNative": 12,
            "tsSidecar": 0,
            "disabled": 0
        }
    })
}

fn initial_instructions_result() -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": initial_instructions_text()
        }]
    })
}

fn exposed_tools() -> Value {
    json!([
        tool("initial_instructions", "Get concise MCP operating guidance and the recommended tool flow.", json!({"type":"object","properties":{}})),
        tool("context_compile", "Primary workflow tool. Build the minimal task context pack from knowledge + source evidence before coding.", json!({
            "type":"object",
            "properties":{
                "goal":{"type":"string"},
                "changeTypes":{"type":"array","items":{"type":"string"}},
                "technologies":{"type":"array","items":{"type":"string"}},
                "domains":{"type":"array","items":{"type":"string"}}
            },
            "required":["goal"]
        })),
        tool("compile_eval", "Evaluate returned context from a context_compile run. Do not call this tool when context_compile returned No Content.", json!({
            "type":"object",
            "properties":{
                "runId":{"type":"string","format":"uuid"},
                "outcome":{"type":"string","enum":["useful","partial","misleading","unused"]},
                "title":{"type":"string","maxLength":160},
                "body":{"type":"string","maxLength":10000},
                "relevance":{"type":"integer","minimum":0,"maximum":100,"description":"目的に合っていたか (0-100)"},
                "actionability":{"type":"integer","minimum":0,"maximum":100,"description":"実装・判断に使えたか (0-100)"},
                "coverage":{"type":"integer","minimum":0,"maximum":100,"description":"必要情報を網羅していたか (0-100)"},
                "clarity":{"type":"integer","minimum":0,"maximum":100,"description":"Context clarity (100 = clean, 0 = noisy)."},
                "specificity":{"type":"integer","minimum":0,"maximum":100,"description":"抽象すぎなかったか (0-100)"}
            },
            "required":["outcome","body","relevance","actionability","coverage","clarity","specificity"]
        })),
        tool("context_decision", "Use as an autonomous GO/NO-GO pre-question gate before you would otherwise ask the user when blocked, before PR creation, after failed tests/review, or when unfinished Todo/status remains. Returns a decision, not options. Estimate operational impact from metadata and Knowledge evidence; do not ask the user by default. Treat reject as a stop condition, but reserve it for obvious blocking danger or directly forbidden actions; prefer execute or revise_and_execute when safe autonomous progress remains possible. Escalate only when autonomous progress is not possible.", json!({
            "type":"object",
            "properties":{
                "decisionPoint":{"type":"string"},
                "retrievalHints":{"type":"object","properties":{
                    "technologies":{"type":"array","items":{"type":"string"}},
                    "changeTypes":{"type":"array","items":{"type":"string"}},
                    "domains":{"type":"array","items":{"type":"string"}}
                }},
                "sessionId":{"type":"string"},
                "metadata":{"type":"object"}
            },
            "required":["decisionPoint"]
        })),
        tool("context_decision_feedback", "Record Good/Bad human feedback or AI/system outcome feedback for a context_decision decisionId.", json!({
            "type":"object",
            "properties":{
                "decisionId":{"type":"string"},
                "source":{"type":"string","enum":["human","ai","system"]},
                "value":{"type":"string","enum":["good","bad"]},
                "outcome":{"type":"string","enum":["success","failed","discarded_pr","user_overrode","regression_found","still_unknown"]},
                "reason":{"type":"string"},
                "metadata":{"type":"object"}
            },
            "required":["decisionId","source"]
        })),
        tool("search_knowledge", "Inspect raw knowledge candidates with scores and source refs. Prefer context_compile for normal workflows.", json!({
            "type":"object",
            "properties":{
                "query":{"type":"string"},
                "repoPath":{"type":"string"},
                "changeTypes":{"type":"array","items":{"type":"string"}},
                "technologies":{"type":"array","items":{"type":"string"}},
                "domains":{"type":"array","items":{"type":"string"}},
                "includeGeneral":{"type":"boolean","default":true},
                "statuses":{"type":"array","items":{"type":"string","enum":["draft","active","deprecated"]}},
                "polarities":{"type":"array","items":{"type":"string","enum":["positive","negative","neutral"]}},
                "intentTags":{"type":"array","items":{"type":"string"}},
                "types":{"type":"array","items":{"type":"string","enum":["rule","procedure"]}},
                "limit":{"type":"number","default":10},
                "includeDraft":{"type":"boolean","default":false}
            },
            "required":["query"]
        })),
        tool("register_candidates", "Bulk-register lightweight rule/procedure candidates for later distillation. Use when multiple durable lessons should be registered from the same task. In Japanese-operated contexts, write title/body/avoid/prefer natural language in Japanese except identifiers, commands, API names, URLs, and error messages.", json!({
            "type":"object",
            "additionalProperties":false,
            "properties":{"items":{"type":"array","minItems":1,"maxItems":10,"items":{"type":"object"}}},
            "required":["items"]
        })),
        tool("search_memory", "Search past vibe memories and captured agent diffs (Gnosis compatible).", json!({
            "type":"object",
            "properties":{
                "query":{"type":"string","description":"The search term or topic."},
                "sessionId":{"type":"string","description":"Optional session ID to filter results."},
                "limit":{"type":"number","default":10,"description":"Maximum number of results to return."},
                "includeContent":{"type":"boolean","default":false,"description":"Include preview content in results. Defaults to false."},
                "previewChars":{"type":"number","description":"Preview length when includeContent=true. Default is 320 chars."}
            },
            "required":["query"]
        })),
        tool("fetch_memory", "Fetch a specific vibe memory with optional range or search context (Gnosis compatible).", json!({
            "type":"object",
            "properties":{
                "id":{"type":"string","description":"Specific memory ID to fetch."},
                "start":{"type":"number","description":"Start character index."},
                "end":{"type":"number","description":"End character index."},
                "maxChars":{"type":"number","description":"Maximum characters to return."},
                "query":{"type":"string","description":"Fetch context around this query within the memory."},
                "includeAgentDiffs":{"type":"boolean","default":false,"description":"Include agent diff entries. Defaults to false."},
                "returnMetaOnly":{"type":"boolean","default":false,"description":"Return metadata only without content text."}
            },
            "required":["id"]
        })),
        tool("search_episodes", "Search EpisodeCards, compact past-work precedents with refs back to raw evidence.", json!({
            "type":"object",
            "properties":{
                "query":{"type":"string","description":"Search text for title, situation, lesson, refs."},
                "status":{"type":"string","enum":["active","deprecated"],"description":"Single status filter. Defaults to active."},
                "statuses":{"type":"array","items":{"type":"string","enum":["active","deprecated"]},"description":"Multiple status filters."},
                "domains":{"type":"array","items":{"type":"string"}},
                "technologies":{"type":"array","items":{"type":"string"}},
                "changeTypes":{"type":"array","items":{"type":"string"}},
                "tools":{"type":"array","items":{"type":"string"}},
                "repoPath":{"type":"string"},
                "repoKey":{"type":"string"},
                "outcomeKinds":{"type":"array","items":{"type":"string","enum":["success","failure","mixed","unknown"]}},
                "limit":{"type":"number","default":10,"description":"Maximum results, up to 100."}
            }
        })),
        tool("fetch_episode", "Fetch one EpisodeCard with refs for raw evidence drill down.", json!({
            "type":"object",
            "properties":{"id":{"type":"string","description":"EpisodeCard id."}},
            "required":["id"]
        })),
        tool("doctor", "Run diagnostic checks on the contextStill system (Gnosis compatible).", json!({"type":"object","properties":{}}))
    ])
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema
    })
}

fn initial_instructions_text() -> &'static str {
    match resolve_locale() {
        "en" => INITIAL_INSTRUCTIONS_EN,
        _ => INITIAL_INSTRUCTIONS_JA,
    }
}

fn resolve_locale() -> &'static str {
    let input = std::env::var("CONTEXT_STILL_LANG")
        .or_else(|_| std::env::var("MEMORY_ROUTER_LANG"))
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if input == "en" || input.starts_with("en-") {
        "en"
    } else {
        "ja"
    }
}

const INITIAL_INSTRUCTIONS_JA: &str = concat!(
    "## 常用ルール\n",
    "- 常に日本語で返答する。\n",
    "- まず `context_compile` を呼び、作業の主導線とする。`goal` を必ず渡し、適切な `changeTypes` / `technologies` を指定する。\n",
    "- `goal` は達成したい状態を1-3文で具体的に書き、設計書パスや `design.md` などの文書参照は含めない。\n",
    "- 次の応答がユーザーへの確認質問になりそうで、かつ自律的に続行できる余地がある場合は、質問する前に `context_decision` を pre-question gate として呼ぶ。\n",
    "- ブロッカー由来の判断が必要な場合、ユーザーに質問する前に `context_decision` を呼ぶ。例: このまま進めるか、修正して進めるか、reject/rollback/discard/escalate すべきか、PR作成前の判断、危険操作や未完了Todoの扱い。\n",
    "- `context_decision` が `reject` を返した場合は、その判断を停止条件として扱い、実装・変更・PR作成などの対象アクションを継続しない。必要な報告や確認待ちに切り替える。\n",
    "- `context_decision` に従った作業が完了し、結果が分かったら `context_decision_feedback` を保存する。成功/失敗/ユーザー上書き/回帰検出などの outcome は、完了直後または pre-commit 時点で分かる範囲で記録する。\n",
    "- ユーザーに情報を提示する際、それが本当に有用であるかを厳格に評価し、不確実な情報やノイズでコンテキストを圧迫しない。\n",
    "- 作業中に再利用可能なルールや手順（手続き）を確立した場合は、プロジェクト依存の記述を除いて汎用化し、`register_candidates` で登録する。\n",
    "- candidate 登録時は、単なる作業記録ではなく、他の文脈でも再利用できる知識として体裁を整える。\n",
    "- candidate 登録時の title / body / avoid / prefer の自然文は日本語で書く。識別子、API名、コマンド、URL、エラーメッセージは原文を保持してよい。\n",
    "- 手続き候補は SKILL.md 相当の形式が必須であり、`Use when:` / `Workflow:` / `Verification:` / `Avoid:` の見出しをこの順に含めないと登録できない。\n",
    "- 完了報告の前に、`context_compile` の実行回数と `compile_eval` の実行回数を自己申告する。また、各 runId ごとに `compile_eval` を1件以上保存する。ただし、`context_compile` が `No Content` を返した runId には保存しない。\n\n",
    "## MCPツール種別\n",
    "- `context_compile`: 作業前の最小コンテキスト生成（主導線）。\n",
    "- `context_decision`: ブロッカー由来の判断が必要な時に、ユーザーへ質問する前の実行/修正/拒否/巻き戻し等を判断。`reject` は停止条件として扱う。\n",
    "- `context_decision_feedback`: `context_decision` 後の作業結果を Good/Bad または system/AI outcome として保存。\n",
    "- `register_candidates`: 複数 candidate の一括登録。\n",
    "- `compile_eval`: `No Content` 以外の `context_compile` の作業後評価を保存。\n",
    "- `search_memory` / `fetch_memory`: 過去会話・差分の参照（補助）。\n",
    "- `doctor`: DB / embedding / automation / run health の診断。"
);

const INITIAL_INSTRUCTIONS_EN: &str = concat!(
    "## Operational Rules\n",
    "- Always respond in Japanese.\n",
    "- First call `context_compile` as the main baseline of the task. Always provide `goal`, and specify appropriate `changeTypes` / `technologies`.\n",
    "- Keep the `goal` focused on 1-3 specific sentences describing the desired outcome. Do not include path references like `design.md` or implementation plans.\n",
    "- If the next response would ask the user for confirmation and autonomous progress may still be possible, call `context_decision` as a pre-question gate before asking.\n",
    "- When a blocker-derived judgment is needed, call `context_decision` before asking the user. Examples: whether to proceed, revise and proceed, reject, rollback, discard, escalate, create a PR, handle a risky operation, or handle unfinished Todo/status.\n",
    "- If `context_decision` returns `reject`, treat it as a stop condition and do not continue the target action, such as implementation, file changes, or PR creation. Switch to reporting or waiting for confirmation.\n",
    "- After work based on a `context_decision` is complete and the outcome is known, record `context_decision_feedback`. Record success, failure, user override, regression, or still-unknown outcome as soon as it is known, including at pre-commit time when appropriate.\n",
    "- Strictly evaluate if the presented information to the user is truly useful and specific to avoid context pollution.\n",
    "- If reusable rules, guidelines, or procedures are established, remove project-specific wording, generalize them, and register them using `register_candidates`.\n",
    "- When registering candidates, shape them as reusable knowledge rather than a task log.\n",
    "- When registering candidates, write title / body / avoid / prefer natural language in Japanese. Preserve identifiers, API names, commands, URLs, and error messages as-is.\n",
    "- Procedure candidates must use a SKILL.md-like shape and cannot be registered unless the body includes `Use when:` / `Workflow:` / `Verification:` / `Avoid:` headings in that order.\n",
    "- Before announcing completion, self-report the count of `context_compile` and `compile_eval` executions. Record at least one `compile_eval` for each runId in the session, except when `context_compile` returned `No Content`.\n\n",
    "## MCP Tool Reference\n",
    "- `context_compile`: Generates the baseline minimal context before working.\n",
    "- `context_decision`: Resolves blocker-derived proceed/revise/reject/rollback/discard/escalate judgments before asking the user. Treat `reject` as a stop condition.\n",
    "- `context_decision_feedback`: Records Good/Bad or system/AI outcome feedback after work based on a decision completes.\n",
    "- `register_candidates`: Batch registers multiple candidates.\n",
    "- `compile_eval`: Saves post-task evaluation metrics for `context_compile` runs that returned content.\n",
    "- `search_memory` / `fetch_memory`: Reference past conversations or diff history.\n",
    "- `doctor`: Diagnostic checkup for DB, embedding, and automation health."
);
