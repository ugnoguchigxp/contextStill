# Security Policy

## Supported Versions

context-still is currently pre-1.0. Security fixes are made on `main`.

## Reporting a Vulnerability

Please do not open a public issue for suspected vulnerabilities.

Report privately through GitHub Security Advisories if available, or contact the repository owner directly. Include:

- Affected version or commit.
- Reproduction steps.
- Impact and affected data.
- Whether secrets, local files, or external services are involved.

## Security Model

context-still is local-first software. It can read local source files, local wiki content, local agent logs, and configured provider credentials. Treat the admin UI, API, MCP server, and automation workers as trusted local infrastructure.

Important boundaries:

- Do not expose the admin API or MCP server to untrusted networks.
- Use `CONTEXT_STILL_ADMIN_API_KEY` when exposing the API beyond localhost.
- Keep `.env` and provider credentials out of Git.
- Review source and agent-log content before sending it to external LLM or search providers.
- Use dedicated test databases for integration tests.

## External Providers

If configured, distillation can call external LLM and search providers. Disable external providers or omit API keys for the most local setup.
