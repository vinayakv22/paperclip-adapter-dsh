# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-11-01

### Fixed

- Runs failed at once on dsh 0.2.1 with `unknown option '--permission-mode'`: the headless app only
  takes `--json` and `--session-id`. The permission mode is now passed as `DSH_PERMISSION_MODE`,
  and the patch sets the `approval` policy to `never` and unmounts the interactive `permission`
  presets.
- Successful runs would have been marked failed: dsh 0.2.1 puts the stop reason on the
  `status`/`turn_end` event, not on `final`. The parser now falls back to the last `turn_end` reason.
- Permission modes now match dsh (`read-only`, `workspace-write`, `danger-full-access`); unknown
  values warn and fall back to `workspace-write`.

### Changed

- `addDirs` is no longer passed as `--add-dir` (dsh 0.2.x has no such flag and one writable root per
  session); configured paths produce a warning.
- The fake dsh used in tests now rejects unknown flags and emits the dsh 0.2.1 event shape.

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

[0.1.1]: https://github.com/vinayakv22/paperclip-adapter-dsh/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/vinayakv22/paperclip-adapter-dsh/releases/tag/v0.1.0
