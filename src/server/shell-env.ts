/**
 * Credential forwarding into dsh's shell tool.
 *
 * dsh (0.2.x, `@deepseek-ai/dsh-subprocess`) drops every environment variable whose name
 * matches /KEY|PASSWORD|SECRET|TOKEN/i before it spawns the model's `bash -c` commands, so
 * the run's PAPERCLIP_API_KEY never reaches the agent's curl calls. The agent then falls back
 * to unauthenticated API calls, which local trusted mode attributes to the board user
 * instead of the agent.
 *
 * The adapter therefore hands those values over under names the scrub leaves alone
 * (`PAPERCLIP_FWD_NAMES` + `PAPERCLIP_FWD_V<n>`) and points BASH_ENV at a static script in
 * $DSH_HOME. Non-interactive bash sources BASH_ENV before each command, and the script
 * re-exports the values under their real names and unsets the carriers. The script holds no
 * secret.
 *
 * Forwarded by default: the run-scoped credentials Paperclip mints (PAPERCLIP_* names that match
 * the scrub, e.g. PAPERCLIP_API_KEY, PAPERCLIP_RUNTIME_TOOLS_TOKEN). Anything else, e.g. a
 * GH_TOKEN binding, only when listed in the `forwardEnv` config. Model-provider keys
 * (DEEPSEEK_*) are never forwarded: they stay with the dsh process.
 */

/** dsh's own scrub heuristic (dsh-subprocess `SENSITIVE_ENV_PATTERN`). */
export const DSH_SCRUBBED_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;
export const FORWARD_NAMES_VAR = "PAPERCLIP_FWD_NAMES";
export const FORWARD_VALUE_PREFIX = "PAPERCLIP_FWD_V";
export const FORWARD_PREV_BASH_ENV_VAR = "PAPERCLIP_FWD_PREV_BASH_ENV";
export const BASH_ENV_FILENAME = "paperclip-bash-env.sh";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NEVER_FORWARD_RE = /^(DEEPSEEK_|DSH_)/i;

export const BASH_ENV_SCRIPT = `# managed by paperclip-adapter-dsh: rewritten before every run; edits here are lost.
# Sourced by non-interactive bash (BASH_ENV). Restores the credentials dsh scrubs from its
# shell tool's environment; the values arrive in ${FORWARD_VALUE_PREFIX}<n>, this file holds none.
__pc_i=0
for __pc_n in \${${FORWARD_NAMES_VAR}-}; do
  __pc_v="${FORWARD_VALUE_PREFIX}\${__pc_i}"
  export "\${__pc_n}=\${!__pc_v-}"
  unset "\${__pc_v}"
  __pc_i=$((__pc_i + 1))
done
unset ${FORWARD_NAMES_VAR} __pc_i __pc_n __pc_v
# dsh's bwrap sandbox (workspace-write) mounts an empty /tmp for every command, so Paperclip's
# per-run scratch dirs under /tmp do not exist there; recreate them so $TMPDIR and mktemp work.
for __pc_d in "\${TMPDIR-}" "\${PAPERCLIP_TMPDIR-}" "\${PAPERCLIP_SCRATCH_DIR-}" "\${PAPERCLIP_RUN_SCRATCH_DIR-}" "\${PAPERCLIP_TASK_SCRATCH_DIR-}"; do
  case "$__pc_d" in /tmp/?*) [ -d "$__pc_d" ] || mkdir -p "$__pc_d" 2>/dev/null || true ;; esac
done
unset __pc_d
if [ -n "\${${FORWARD_PREV_BASH_ENV_VAR}-}" ]; then
  BASH_ENV="\${${FORWARD_PREV_BASH_ENV_VAR}}"
  unset ${FORWARD_PREV_BASH_ENV_VAR}
  [ -r "$BASH_ENV" ] && . "$BASH_ENV"
fi
`;

export interface ShellForwardPlan {
  /** Real names restored inside the shell tool, in carrier order. */
  names: string[];
  /** Variables to add to dsh's environment (carriers + BASH_ENV). Contains secret values. */
  vars: Record<string, string>;
  warnings: string[];
}

/** Reads the `forwardEnv` config: a list (or comma/space separated string) of env var names. */
export function readForwardEnv(value: unknown, warnings: string[] = []): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : value === undefined || value === null
        ? []
        : null;
  if (raw === null) {
    warnings.push("forwardEnv must be a list of environment variable names; ignored.");
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    const name = typeof item === "string" ? item.trim() : "";
    if (!name) continue;
    if (!ENV_NAME_RE.test(name)) warnings.push(`forwardEnv entry "${String(item)}" is not an env var name; ignored.`);
    else if (NEVER_FORWARD_RE.test(name)) warnings.push(`forwardEnv entry ${name} is reserved for dsh itself; not forwarded.`);
    else if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * @param env        the env the adapter built for this run (Paperclip runtime + agent bindings);
 *                   only names present here with a non-empty value are forwarded.
 * @param extraNames names from `forwardEnv`.
 * @param bashEnvFile path of the BASH_ENV script ({@link BASH_ENV_SCRIPT}) inside $DSH_HOME.
 * @param inheritedBashEnv an existing BASH_ENV to chain to, if any.
 * @param opts.always install BASH_ENV even with nothing to forward (it also recreates the
 *                    Paperclip scratch dirs inside dsh's per-command /tmp).
 */
export function planShellForward(
  env: Record<string, string>,
  extraNames: string[],
  bashEnvFile: string,
  inheritedBashEnv?: string,
  opts: { always?: boolean } = {},
): ShellForwardPlan {
  const warnings: string[] = [];
  const wanted = [
    ...Object.keys(env)
      .filter((k) => k.startsWith("PAPERCLIP_") && DSH_SCRUBBED_ENV_PATTERN.test(k))
      .sort(),
    ...extraNames,
  ];
  const names: string[] = [];
  for (const name of wanted) {
    if (names.includes(name) || !ENV_NAME_RE.test(name) || NEVER_FORWARD_RE.test(name)) continue;
    const value = env[name];
    if (typeof value !== "string" || value.length === 0) {
      if (extraNames.includes(name)) warnings.push(`forwardEnv names ${name} but it is not set for this run.`);
      continue;
    }
    if (!DSH_SCRUBBED_ENV_PATTERN.test(name)) continue; // dsh passes it through on its own
    names.push(name);
  }
  if (names.length === 0 && !opts.always) return { names, vars: {}, warnings };
  const vars: Record<string, string> = { BASH_ENV: bashEnvFile };
  if (names.length > 0) vars[FORWARD_NAMES_VAR] = names.join(" ");
  names.forEach((name, i) => {
    vars[`${FORWARD_VALUE_PREFIX}${i}`] = env[name]!;
  });
  if (inheritedBashEnv && inheritedBashEnv !== bashEnvFile) vars[FORWARD_PREV_BASH_ENV_VAR] = inheritedBashEnv;
  return { names, vars, warnings };
}

/** Prompt line for workspace-write runs: bwrap gives every shell command a fresh /tmp. */
export function renderSandboxNote(permissionMode: string): string {
  if (permissionMode !== "workspace-write") return "";
  return "Shell sandbox: every shell command starts with an empty /tmp (and $TMPDIR); files written there are gone by the next command. Do multi-step file work inside one command (pipes, heredocs) and keep nothing you need later outside the workspace.";
}
