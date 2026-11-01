#!/usr/bin/env node
// Test double for `dsh`: records how it was called and replays a scripted NDJSON stream.
// FAKE_DSH_MODE: ok (default) | unknown-session | error | hang
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("dsh 0.0.0-fake");
  process.exit(0);
}
// Like dsh 0.2.1's headless app: only --json and --session-id after the launcher flags.
const KNOWN_FLAGS = new Set(["--profile", "--patch", "--json", "--session-id"]);
const TAKES_VALUE = new Set(["--profile", "--patch", "--session-id"]);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-" || !a.startsWith("--")) continue;
  if (!KNOWN_FLAGS.has(a)) {
    process.stderr.write(`error: unknown option '${a}'\n`);
    process.exit(1);
  }
  if (TAKES_VALUE.has(a)) i++;
}
const stdin = fs.readFileSync(0, "utf8");
const at = args.indexOf("--session-id");
const sessionId = at >= 0 ? args[at + 1] : null;
const mode = process.env.FAKE_DSH_MODE || "ok";
// Like dsh's shell tool: `bash -c` with credential-shaped names scrubbed (dsh-subprocess).
function shellSees(name) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/KEY|PASSWORD|SECRET|TOKEN/i.test(k) && !k.toUpperCase().startsWith("DSH_")) env[k] = v;
  }
  return execFileSync("bash", ["-c", `printf %s "\${${name}-<unset>}"`], { env, encoding: "utf8" });
}
if (process.env.FAKE_DSH_RECORD) {
  fs.appendFileSync(
    process.env.FAKE_DSH_RECORD,
    JSON.stringify({
      args,
      stdin,
      cwd: process.cwd(),
      env: {
        DSH_HOME: process.env.DSH_HOME,
        DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE,
        DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE,
        PAPERCLIP_RUN_ID: process.env.PAPERCLIP_RUN_ID,
        PAPERCLIP_TASK_ID: process.env.PAPERCLIP_TASK_ID,
        PAPERCLIP_API_KEY_SET: Boolean(process.env.PAPERCLIP_API_KEY),
        DEEPSEEK_API_KEY_SET: Boolean(process.env.DEEPSEEK_API_KEY),
        DEEPSEEK_INFERX_API_KEY_SET: Boolean(process.env.DEEPSEEK_INFERX_API_KEY),
      },
      shell: {
        PAPERCLIP_API_KEY: shellSees("PAPERCLIP_API_KEY"),
        GH_TOKEN: shellSees("GH_TOKEN"),
        DEEPSEEK_API_KEY: shellSees("DEEPSEEK_API_KEY"),
        PAPERCLIP_FWD_V0: shellSees("PAPERCLIP_FWD_V0"),
      },
    }) + "\n",
  );
}
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
if (mode === "unknown-session" && sessionId) {
  process.stderr.write(`Error: unknown session ${sessionId} for this workspace\n`);
  process.exit(1);
}
const id = sessionId || "ses_fresh";
emit({ type: "session", sessionId: id, cwd: process.cwd() });
emit({ type: "status", phase: "turn_start" });
if (mode === "error") {
  emit({ type: "error", message: "DeepSeek API error 429: rate limit reached" });
  process.exit(1);
}
emit({ type: "status", phase: "step_start" });
emit({ type: "text", text: "Done." });
emit({ type: "status", phase: "step_end", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 } });
// dsh 0.2.1 shape: the stop reason rides on turn_end; final carries only the text.
emit({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } });
emit({ type: "final", text: `Finished (${stdin.length} chars of task)` });
if (mode === "hang") setInterval(() => {}, 1000);
