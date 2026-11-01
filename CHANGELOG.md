# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.7] - 2026-11-02

### Fixed

- `$TMPDIR` and Paperclip's scratch directories now exist inside dsh's shell sandbox. Under
  `workspace-write`, bwrap mounts an empty `/tmp` for each command, so the `/tmp/paperclip-run-*`
  directories were missing and `mktemp` failed. The `BASH_ENV` script recreates them, and it is now
  installed under `workspace-write` even when there is no credential to forward.

### Added

- A one-line prompt note for `workspace-write` runs: `/tmp` is cleared between shell commands, so
  keep multi-step file work inside one command. Agents were losing steps re-fetching files.

## [0.1.6] - 2026-11-02

### Added

- `bearerTokenEnv` (alias `bearer_token_env_var`) on MCP servers: the `Authorization: Bearer` header is built
  from an env var name at run time.

### Fixed

- A `headers.Authorization` value saved through Paperclip came back as the literal `***REDACTED***`
  (Paperclip masks values under credential-looking keys), so MCP servers answered 401. Such a header now
  skips the server with a warning that points to `bearerTokenEnv`.
- The relay reports the HTTP status and header length (never values) when its upstream connection fails.

## [0.1.5] - 2026-11-02

### Fixed

- InferX runs no longer fail on the free endpoint's short capacity outages
  (`429 … all replicas at capacity`, about a minute long). dsh's default retry policy gives up after
  about 15 seconds. The InferX route now carries a `retryPolicy` of 12 retries, backing off from 2 s
  to 30 s.

### Added

- `providerRetry`: per-route retry policy override (dsh `retryPolicy` fields), or `"default"` for
  dsh's own policy.

## [0.1.4] - 2026-11-02

### Added

- MCP tool filtering. A streamable-http server in `mcpServers` accepts `enabledTools` and
  `disabledTools`; the adapter then mounts it through the new `paperclip-dsh-mcp-filter` stdio relay,
  which hides the other tools from `tools/list` and refuses their `tools/call` locally. See
  "Restricting MCP tools" in the README.

## [0.1.3] - 2026-11-01

### Fixed

- The agent's shell commands now get `PAPERCLIP_API_KEY`. dsh 0.2.x strips variables named like
  `*KEY*`, `*TOKEN*`, `*SECRET*` and `*PASSWORD*` from its shell tool. The run token was therefore
  missing, so agent API calls went out unauthenticated and were attributed to the board user. The
  adapter now carries these values under neutral names and restores them through a `BASH_ENV`
  script in `$DSH_HOME`. The script holds no secret.

### Added

- `forwardEnv`: extra credential variables to pass to the shell tool, e.g. `GH_TOKEN`.
  `DEEPSEEK_*` and `DSH_*` are never forwarded.
- A warning when Paperclip mints no run token for a run.

## [0.1.2] - 2026-11-01

### Added

- Provider selection: `provider` (`auto` | `inferx` | `deepseek-official` | custom route name),
  `baseUrl`, `apiKeyEnv`, `providerApi`, `providerCompat`, `contextWindow`, `maxTokens`. Non-DeepSeek
  routes are declared as `llm-pi-ai` providers in the patch file and selected through
  `agent-default-model`; keys are referenced by env var name only.
- InferX preset: `https://model.inferx.net/endpoints/v1`, key `DEEPSEEK_INFERX_API_KEY`, model
  `deepseek-v4.1-flash-1017-basic`. `auto` (the default) uses it when that key is set and the model is
  a Flash model; otherwise DeepSeek's API stays the route.
- Environment test reports the chosen provider and model and checks that provider's key variable.
- Runs report `provider` / `biller` as the route (`inferx`, a custom name, or `deepseek`).
- InferX Flash's model row carries `contextWindow: 262144` (its real window; dsh assumes 1,048,576 for
  `deepseek-flash`) so compaction triggers in time. `contextWindow` / `maxTokens` are configurable.
- `maxTokens` below 8,192 is raised to 8,192 with a warning: DeepSeek Flash spends output tokens on
  reasoning first, so small caps truncate replies. Unset leaves dsh's default (32,768).
- Test that AGENTS.md never enters the stdin prompt and that resumed runs send the compact task brief.

### Changed

- `~/.paperclip-dsh/.env` now fills every `DEEPSEEK_*` variable the agent's environment leaves unset,
  not only when `DEEPSEEK_API_KEY` is missing.
- The non-DeepSeek-model warning moved from config parsing to provider resolution.

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

[0.1.7]: https://github.com/vinayakv22/paperclip-adapter-dsh/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/vinayakv22/paperclip-adapter-dsh/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/vinayakv22/paperclip-adapter-dsh/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/vinayakv22/paperclip-adapter-dsh/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/vinayakv22/paperclip-adapter-dsh/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/vinayakv22/paperclip-adapter-dsh/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/vinayakv22/paperclip-adapter-dsh/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/vinayakv22/paperclip-adapter-dsh/releases/tag/v0.1.0
