@AGENTS.md

## Claude Code
context-still MCP は `architect` と `coder` サブエージェント専用(メインセッションや他のagentには接続されない)。
AGENTS.md の `initial_instructions` は **context-still** の `initial_instructions`(Serena の同名ツールではない)を指す。architect / coder は作業開始時に最初に1回実行する。
