# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-01

### Added

- `dsh_local` Paperclip adapter: runs `dsh --profile headless --json` with the task on stdin.
- Per-agent `DSH_HOME` (default `~/.paperclip-dsh/agents/<agentId>`) holding dsh sessions,
  `AGENTS.md` (synced from the agent's instructions file), symlinked Paperclip skills and a
  generated `paperclip.patch.yml`.
- Model selection (`deepseek-flash`, `deepseek-v4-pro`, aliases `flash` / `pro`) via the patch file.
- MCP servers (`streamable-http` and `stdio`) through `@deepseek-ai/dsh-mcp-client`, with
  `${ENV_NAME}` references so secrets never land on disk.
- Session resume with `--session-id` when cwd and `DSH_HOME` match; automatic fresh retry when
  dsh no longer knows the session.
- Per-run usage reporting (input includes cache reads/writes; cached = cache reads), DeepSeek
  billing metadata and final-answer summary.
- Telemetry off by default: `session-log-deepseek` disabled and `DSH_TELEMETRY_MODE=DISABLED`.
- Codex fallback compatibility: a Codex agent's adapterConfig runs unchanged after switching
  `adapterType` and `model`; a shared `~/.paperclip-dsh/.env` can supply the DeepSeek key.
- Zero-import UI parser for readable run transcripts (thinking, tool calls, results, usage).
- Environment test: dsh version, Node >= 24.9, DeepSeek key presence, writable `DSH_HOME`.

[0.1.0]: https://github.com/vinayakv22/paperclip-adapter-dsh/releases/tag/v0.1.0
