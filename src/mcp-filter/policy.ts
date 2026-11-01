/**
 * Tool visibility policy for the MCP filter relay.
 *
 * `enabled` is an allowlist (undefined = every tool); `disabled` is subtracted after it.
 * An empty allowlist hides everything: "restrict to nothing" must never mean "unrestricted".
 */

export interface ToolPolicy {
  enabled?: readonly string[];
  disabled?: readonly string[];
}

export function isToolAllowed(policy: ToolPolicy, name: string): boolean {
  if (policy.enabled !== undefined && !policy.enabled.includes(name)) return false;
  if (policy.disabled?.includes(name)) return false;
  return true;
}

export function filterTools<T extends { name: string }>(policy: ToolPolicy, tools: readonly T[]): T[] {
  return tools.filter((t) => isToolAllowed(policy, t.name));
}
