<div align="center">

# paperclip-adapter-dsh

**Run [Paperclip](https://github.com/paperclipai/paperclip) agents on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) with your own DeepSeek API key.**

[![CI](https://github.com/vinayakv22/paperclip-adapter-dsh/actions/workflows/ci.yml/badge.svg)](https://github.com/vinayakv22/paperclip-adapter-dsh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Adapter type](https://img.shields.io/badge/adapter-dsh__local-6f42c1)
![Paperclip](https://img.shields.io/badge/paperclip-2026.1012-111)
![Node](https://img.shields.io/badge/node-%E2%89%A524.11-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)

</div>

`dsh_local` is an external adapter plugin for Paperclip. It gives a Paperclip agent the same
first-class treatment the built-in `codex_local` and `claude_local` adapters get: a config form with
a model picker, readable run transcripts, session resume, skills, managed `AGENTS.md`
instructions, token accounting and an environment check. The work runs on DeepSeek models through
`dsh`'s own tools (shell, files, web, skills, subagents, MCP).

> [!NOTE]
> **This is a stopgap.** Upstream Paperclip work
> ([paperclipai/paperclip#18273](https://github.com/paperclipai/paperclip/pull/18273)) adds native
> dsh support through Paperclip's Runner/ACP path. It is not merged yet. When it ships in a
> Paperclip release, prefer the built-in support and retire this plugin.

## Contents

- [Why](#why)
- [How it works](#how-it-works)
- [Features](#features)
- [Install on a Paperclip host](#install-on-a-paperclip-host)
- [Configure an agent](#configure-an-agent)
- [Fallback for Codex agents](#fallback-for-codex-agents)
- [Models, MCP and permissions](#models-mcp-and-permissions)
- [Sessions, skills and AGENTS.md](#sessions-skills-and-agentsmd)
- [Telemetry and secrets](#telemetry-and-secrets)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Development](#development)

## Why

Before this adapter, the usual way to run dsh under Paperclip was the generic `process` adapter
plus a wrapper script. That works, but the process adapter only passes four environment variables
and an exit code, so the bridge has to rebuild everything else:

| | `process` adapter + bridge script | `dsh_local` (this plugin) | Upstream #18273 |
|---|---|---|---|
| Config form, model picker | No | Yes | Yes |
| Task context and wake prompt | Re-fetched over the API | Paperclip's own prompt sections | Native |
| Readable transcript (thinking, tools) | Raw JSON lines | Yes (UI parser) | Yes |
| Token usage and cost attribution | No | Yes, per run | Yes |
| Success check | Exit code only | Exit 0 **and** `final.reason.kind == "completed"` | Native |
| Session resume / reset from Paperclip | Private state file | Paperclip session params | Native |
| Skills and `AGENTS.md` bundle | Pasted into the prompt | Synced into `DSH_HOME` | Native |
| Available today | Yes | Yes | Not merged |

## How it works

```mermaid
flowchart LR
    subgraph Paperclip server
        HB[Heartbeat run] --> EX["dsh_local execute()"]
    end
    subgraph "DSH_HOME (per agent)"
        AG[AGENTS.md]
        SK[skills/*]
        PA[paperclip.patch.yml]
        SE[(dsh sessions)]
    end
    EX -- writes --> AG & SK & PA
    EX -- "prompt on stdin<br/>env: PAPERCLIP_*, DEEPSEEK_API_KEY" --> DSH["dsh --profile headless<br/>--patch … --json -"]
    DSH -- reads --> AG & SK & PA
    DSH <--> SE
    DSH -- HTTPS --> DS[(DeepSeek API)]
    DSH -- curl + run JWT --> API[(Paperclip API)]
    DSH -- NDJSON events --> EX
    EX -- "usage · session · summary" --> HB
```

Each run:

1. Resolves the workspace `cwd` from Paperclip, builds the `PAPERCLIP_*` environment (run id, task,
   wake reason, workspace, run-scoped API token) and merges the agent's `env`, including resolved
   secrets such as `DEEPSEEK_API_KEY`.
2. Prepares the agent's `DSH_HOME`: copies the instructions file to `AGENTS.md`, symlinks the
   agent's Paperclip skills into `skills/`, and writes `paperclip.patch.yml` (model, telemetry, MCP).
3. Builds the prompt from Paperclip's standard sections (wake prompt, task context, handoff,
   heartbeat template) plus a short note on calling the Paperclip API with `curl`.
4. Runs `dsh --profile headless --patch <file> --json --permission-mode <mode> --approval-policy never [--add-dir …] [--session-id …] -`
   with the prompt on stdin, streaming the NDJSON events to the run log.
5. Parses the stream into usage, session id and the final answer, and reports them to Paperclip.

## Features

- **DeepSeek models**: `deepseek-flash` (default) and `deepseek-v4-pro`, picked per agent.
- **Session resume** with `--session-id` when the workspace and `DSH_HOME` match; if dsh no longer
  knows the session, the run retries fresh automatically and Paperclip's session is cleared.
- **Managed instructions**: Paperclip's instructions bundle editor works; the file is synced to
  `$DSH_HOME/AGENTS.md`, which dsh loads as user-global instructions.
- **Skills**: Paperclip skills appear in dsh's skill tool, with list/sync from the Paperclip UI.
- **MCP servers** over `streamable-http` or `stdio`, with `${ENV}` secret references.
- **Accurate usage**: dsh reports Anthropic-style counters (input excludes cache); the adapter reports
  `inputTokens = input + cacheRead + cacheWrite` and `cachedInputTokens = cacheRead`, per run.
- **Readable transcripts**: a zero-dependency UI parser renders thinking, tool calls, tool results and
  the final result with token totals.
- **Telemetry off by default**: session-log upload to DeepSeek is disabled.
- **Environment test**: checks dsh, Node version, DeepSeek key presence and a writable `DSH_HOME`.
- **Codex fallback**: a Codex agent can switch to `dsh_local` by changing only `adapterType` and `model`.

## Install on a Paperclip host

### 1. Install dsh for the user that runs Paperclip

dsh needs **Node.js ≥ 24.9** on that user's `PATH`.

```sh
sudo -u paperclip -H bash -lc 'npm install -g --prefix "$HOME/.local" @deepseek-ai/dsh && "$HOME/.local/bin/dsh" --version'
```

### 2. Build the adapter

```sh
sudo -u paperclip -H bash -lc '
  mkdir -p ~/.paperclip/adapter-src && cd ~/.paperclip/adapter-src &&
  git clone https://github.com/vinayakv22/paperclip-adapter-dsh.git && cd paperclip-adapter-dsh &&
  npm install --ignore-scripts && npm run build'
```

`--ignore-scripts` skips esbuild's postinstall, which the build does not need.

### 3. Register it with Paperclip

Through the API (add `-H "Authorization: Bearer <board token>"` unless the instance runs in
`local_trusted` mode):

```sh
curl -X POST http://127.0.0.1:3100/api/adapters \
  -H 'Content-Type: application/json' \
  -d '{"localPath": "/home/paperclip/.paperclip/adapter-src/paperclip-adapter-dsh"}'
```

Or add an entry to `~/.paperclip/adapter-plugins.json` and restart Paperclip:

```json
[
  {
    "packageName": "paperclip-adapter-dsh",
    "localPath": "/home/paperclip/.paperclip/adapter-src/paperclip-adapter-dsh",
    "type": "dsh_local",
    "installedAt": "2026-11-01T00:00:00.000Z"
  }
]
```

Paperclip picks up rebuilt local adapters on restart. To update: `git pull && npm install --ignore-scripts && npm run build`, then restart.

### 4. Give agents a DeepSeek key

Create a Paperclip secret holding the key and bind it as `DEEPSEEK_API_KEY` in the agent's
environment. For a host-wide default (useful for [Codex fallback](#fallback-for-codex-agents)),
put it in `~/.paperclip-dsh/.env` instead:

```sh
sudo -u paperclip -H bash -c 'umask 077; mkdir -p ~/.paperclip-dsh; read -rsp "DeepSeek key: " k; echo; printf "DEEPSEEK_API_KEY=%s\n" "$k" > ~/.paperclip-dsh/.env'
```

The adapter only reads `DEEPSEEK_*` lines from that file, only when the agent has no key of its own,
and refuses the file unless it is mode `600`.

## Configure an agent

Pick **DeepSeek Harness (local)** as the agent's adapter, or set it through the API:

```json
{
  "adapterType": "dsh_local",
  "adapterConfig": {
    "model": "deepseek-flash",
    "permissionMode": "workspace-write",
    "addDirs": ["/home/paperclip/sites/example.com/.git"],
    "mcpServers": {
      "openseo": {
        "transport": "streamable-http",
        "url": "https://app.openseo.so/mcp",
        "headers": { "Authorization": "Bearer ${OPENSEO_API_KEY}" }
      }
    },
    "timeoutSec": 3600,
    "env": {
      "DEEPSEEK_API_KEY": { "type": "secret_ref", "secretId": "<secret id>" },
      "OPENSEO_API_KEY": { "type": "secret_ref", "secretId": "<secret id>" }
    }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `model` | `deepseek-flash` | `deepseek-flash`, `deepseek-v4-pro`, or aliases `flash` / `pro`. Non-DeepSeek ids fall back to the default. |
| `permissionMode` | `workspace-write` | `workspace-write`, `read-only` or `auto`. Approval policy is always `never`. |
| `addDirs` | none | Extra writable directories (array, or one per line), each passed as `--add-dir`. |
| `mcpServers` | none | JSON object `name → {transport, url, headers, command, args, env}`. |
| `instructionsFilePath` | managed by Paperclip | Copied to `$DSH_HOME/AGENTS.md` before each run. |
| `cwd` | Paperclip workspace | Fallback working directory. |
| `env` | none | Environment for dsh, including secret bindings. Set it with Paperclip's environment editor. |
| `promptTemplate`, `bootstrapPromptTemplate` | Paperclip defaults | Prompt overrides. |
| `command` | `dsh` | dsh executable. A command that is not dsh (e.g. a Codex launcher) is ignored. |
| `dshHome` | `~/.paperclip-dsh/agents/{agentId}` | Per-agent home; `~` and `{agentId}` are expanded. |
| `disableTelemetry` | `true` | Disable session-log upload to DeepSeek. |
| `timeoutSec` / `graceSec` | `0` / `15` | Run timeout (0 = none) and SIGTERM→SIGKILL grace. |
| `dshExtraArgs` | none | Extra dsh arguments, one per line. |

## Fallback for Codex agents

The adapter is designed so a Codex agent can be moved to DeepSeek when Codex hits its usage limit,
and moved back when Codex resets, **by changing only `adapterType` and `model`**:

```json
{ "adapterType": "dsh_local", "adapterConfig": { "...everything the Codex agent already had...": "", "model": "deepseek-flash" } }
```

What carries over and what is ignored:

| Codex `adapterConfig` key | Under `dsh_local` |
|---|---|
| `instructionsFilePath`, `cwd`, `env`, `timeoutSec`, `graceSec`, `promptTemplate`, `bootstrapPromptTemplate` | Used as-is |
| `model` (a GPT/Codex id left behind) | Replaced by `deepseek-flash`, with a warning in the run log |
| `command` pointing at `codex` / `codex-lb` | Ignored; `dsh` runs instead |
| `extraArgs` (Codex `-c …` flags) | Ignored; dsh arguments live in `dshExtraArgs` |
| `modelReasoningEffort`, `engine`, other Codex-only keys | Ignored |
| Codex session (thread id in Paperclip's session params) | Never passed to dsh; the first dsh run starts fresh |

Things the swapping process should take care of:

- **DeepSeek key.** Codex agents have no `DEEPSEEK_API_KEY` binding. Either add one, or provide the
  host-wide `~/.paperclip-dsh/.env` described in [Install](#4-give-agents-a-deepseek-key).
- **Save and restore the original** `adapterType` + `adapterConfig`; this adapter does not write
  them back.
- **Reset the session on each swap** (`POST /api/agents/:id/runtime-state/reset-session`). The
  adapter already refuses foreign sessions, but resetting keeps Codex from trying to resume a dsh
  session id when it comes back.
- **Tools differ.** MCP servers configured through Codex `-c` flags do not carry over; give the
  agent `mcpServers` if it needs them under dsh.

## Models, MCP and permissions

**Models.** The model is pinned with a dsh patch row, which replaces the
`agent-default-model` plugin's config:

```yaml
- id: agent-default-model
  config:
    provider: deepseek-official
    model: "deepseek-v4-pro"
```

**MCP.** Each server becomes an inserted `@deepseek-ai/dsh-mcp-client` row. Any `${NAME}` inside a
URL, header, command, argument or env value is written as a `!!js` template literal that dsh evaluates
against its environment, so the generated file never contains the secret:

```yaml
- insert:
    - id: "mcp-openseo"
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: "openseo"
        transport: streamable-http
        url: "https://app.openseo.so/mcp"
        headers:
          "Authorization": !!js "`Bearer ${process.env.OPENSEO_API_KEY ?? \"\"}`"
```

**Permissions.** `permissionMode` maps to `--permission-mode`. No one is present to approve tool
calls, so `--approval-policy never` is always set: dsh denies what the mode does not allow instead
of waiting. When the workspace is a git worktree whose object store lives elsewhere, add that
`.git` directory to `addDirs` so commits work.

## Sessions, skills and AGENTS.md

**Per-agent `DSH_HOME`.** Every agent gets its own home (default `~/.paperclip-dsh/agents/<agentId>`).
dsh keeps its session store there, and the adapter manages three entries:

| Path | Managed by | Purpose |
|---|---|---|
| `AGENTS.md` | adapter, every run | Copy of the agent's instructions; dsh loads it as user-global instructions |
| `skills/<name>` | adapter + Paperclip skill sync | Symlinks to Paperclip skills; dsh's skill-filesystem plugin scans them |
| `paperclip.patch.yml` | adapter, every run | Model, telemetry and MCP overlay passed with `--patch` |

Edit instructions in Paperclip, not in `AGENTS.md`: the copy is overwritten on the next run. A
user-written `AGENTS.md` (without the adapter's marker comment) is never deleted.

**Sessions.** dsh binds a session to one `DSH_HOME` and one cwd. The adapter stores both next to the
session id and resumes only when they match, so moving an agent to another workspace starts a fresh
session instead of failing. If dsh still refuses the id (the session was deleted, for example), the
run retries once without it. Resetting the session in Paperclip starts fresh on the next run.

## Telemetry and secrets

- `disableTelemetry` (default `true`) disables dsh's `session-log-deepseek` plugin in the patch and
  sets `DSH_TELEMETRY_MODE=DISABLED`. Transcripts stay in `DSH_HOME` on your host.
- Model calls go to the DeepSeek API and are billed to your key; usage is reported to Paperclip with
  `provider: "deepseek"`, `biller: "deepseek"`, `billingType: "api"`.
- The adapter never logs secret values. Keys reach dsh only through the process environment; the
  generated patch uses `${ENV}` references; Paperclip's invocation log redacts the environment.
- The agent receives a run-scoped Paperclip token as `PAPERCLIP_API_KEY` and is told to send
  `X-Paperclip-Run-Id` on writes so Paperclip can attribute its actions to the run.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Environment test: `Cannot run "dsh --version"` | Install dsh for the Paperclip user, or set `command` to the absolute path (e.g. `/home/paperclip/.local/bin/dsh`). |
| `node … is older than 24.9.0` | The `node` on the Paperclip user's `PATH` is too old for dsh. Upgrade Node or put a newer one first on `PATH`. |
| `authentication_required` / DeepSeek 401 | `DEEPSEEK_API_KEY` is missing or wrong. Check the secret binding or `~/.paperclip-dsh/.env` (mode 600). |
| `rate_limited` / `insufficient_balance` | DeepSeek returned 429 / 402. Wait, or top up the account. |
| `Not resuming dsh session …` in the log | Expected after a workspace or `DSH_HOME` change, or after a swap from another adapter. |
| `dsh stopped: max_steps` (or another reason) | dsh ended without completing; the run is marked failed. Check the transcript for the reason. |
| Commits fail with permission errors in a worktree | Add the repository's `.git` directory to `addDirs`. |
| MCP tool missing | Look for `[paperclip] MCP config references ${X} but it is not set` in the run log, and check the server name rules (`[A-Za-z0-9_-]`). |

Run logs prefix the adapter's own lines with `[paperclip]`. The generated patch is at
`$DSH_HOME/paperclip.patch.yml` if you want to see exactly what dsh loaded.

## Limitations

- **Local execution only.** Remote SSH or sandbox execution targets are refused.
- **Cost is not computed.** Paperclip gets token counts; dollar cost is left to Paperclip's pricing.
- **dsh is a developer preview.** Its event stream, flags and plugin ids may change between releases.
  The parser ignores unknown events, but pin a dsh version you have tested.
- **No interactive approvals.** Tool calls the permission mode does not allow are denied, not queued.
- **Retire when upstream ships.** Once Paperclip includes native dsh support (#18273), migrate agents
  to it.

## Development

```sh
npm install --ignore-scripts
npm run typecheck
npm test          # vitest: stream parser, usage math, patch, session codec, UI parser, execute with a fake dsh
npm run build
```

The tests never call the DeepSeek API: `tests/fixtures/fake-dsh.mjs` stands in for dsh, records how
it was called and replays a scripted event stream.

Layout:

```
src/
  index.ts             createServerAdapter() and the agent configuration doc
  constants.ts         adapter id, model catalog, defaults
  ui-parser.ts         zero-import transcript parser served to the Paperclip UI
  server/
    execute.ts         one heartbeat run
    stream.ts          NDJSON event parser and usage math
    patch.ts           paperclip.patch.yml generator (model, telemetry, MCP)
    config.ts          adapterConfig normalisation and dsh argv
    home.ts            DSH_HOME layout, AGENTS.md sync, shared key file
    session.ts         session codec and resume rules
    skills.ts          skill list/sync
    test.ts            environment test
    config-schema.ts   agent editor form
```

## License

[MIT](LICENSE) © vinayakv22. Not affiliated with DeepSeek or Paperclip.
