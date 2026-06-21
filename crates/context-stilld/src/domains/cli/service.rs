pub fn help_text() -> String {
    [
        "context-stilld",
        "",
        "Usage:",
        "  context-stilld paths [--json]",
        "  context-stilld status [--json]",
        "  context-stilld bootstrap preflight|init [--json]",
        "  context-stilld mcp start|stop|status [--json]",
        "  context-stilld queue start|stop|status [--json]",
        "  context-stilld agent-log-sync run|stop|status [--json]",
        "  context-stilld admin-api start|stop|status [--json]",
        "  context-stilld doctor [summary] [--json]",
        "  context-stilld backup preflight [--json]",
        "  context-stilld --version",
        "",
        "Rust supervises/delegates lifecycle boundaries; TypeScript remains the source of truth for product logic.",
    ]
    .join("\n")
}
