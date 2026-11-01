/**
 * Command line of `paperclip-dsh-mcp-filter`.
 *
 *   --url <url>                    upstream Streamable HTTP endpoint (required)
 *   --bearer-env <NAME>            send `Authorization: Bearer $NAME`
 *   --header-env <Header>=<NAME>   send header <Header> with the value of env var NAME
 *   --enable <tool>                allowlist entry (repeatable; comma-separated lists also work)
 *   --enable-none                  allowlist that hides every tool
 *   --disable <tool>               denylist entry (repeatable)
 *
 * Secrets are only ever named here, never carried: the values are read from the environment.
 */

import type { ToolPolicy } from "./policy.js";

export interface RelayArgs {
  url: string;
  headers: Record<string, string>;
  policy: ToolPolicy;
}

function split(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RelayArgs {
  let url = "";
  const headers: Record<string, string> = {};
  let enabled: string[] | undefined;
  let disabled: string[] | undefined;
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    return v;
  };
  const fromEnv = (name: string, flag: string): string => {
    const v = env[name];
    if (!v) throw new Error(`${flag}: environment variable ${name} is not set`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    switch (flag) {
      case "--url":
        url = need(i++, flag);
        break;
      case "--bearer-env":
        headers["Authorization"] = `Bearer ${fromEnv(need(i++, flag), flag)}`;
        break;
      case "--header-env": {
        const spec = need(i++, flag);
        const eq = spec.indexOf("=");
        if (eq <= 0) throw new Error("--header-env expects <Header>=<ENV_NAME>");
        headers[spec.slice(0, eq)] = fromEnv(spec.slice(eq + 1), flag);
        break;
      }
      case "--enable":
        enabled = [...(enabled ?? []), ...split(need(i++, flag))];
        break;
      case "--enable-none":
        enabled = [];
        break;
      case "--disable":
        disabled = [...(disabled ?? []), ...split(need(i++, flag))];
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!url) throw new Error("--url is required");
  try {
    new URL(url);
  } catch {
    throw new Error("--url is not a valid URL");
  }
  return { url, headers, policy: { ...(enabled ? { enabled } : {}), ...(disabled ? { disabled } : {}) } };
}
