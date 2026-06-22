pub fn help_text() -> String {
    [
        "context-stilld",
        "",
        "Usage:",
        "  context-stilld run [--json] [--once]",
        "  context-stilld paths [--json]",
        "  context-stilld status [--json]",
        "  context-stilld bootstrap preflight|init [--json]",
        "  context-stilld mcp status|endpoint|sessions|smoke [--json]",
        "  context-stilld mcp start|stop [--json]  # legacy endpoint-worker lifecycle",
        "  context-stilld queue start|stop|status [--json]",
        "  context-stilld agent-log-sync run|stop|status [--json]",
        "  context-stilld admin-api start|stop|status [--json]",
        "  context-stilld doctor [summary] [--json]",
        "  context-stilld backup preflight [--json]",
        "  context-stilld --version",
        "",
        "Rust owns resident lifecycle boundaries and migrates daemon runtime surfaces toward Rust-native implementations.",
    ]
    .join("\n")
}
