#!/usr/bin/env node
// Test double for `dsh`: records how it was called and replays a scripted NDJSON stream.
// FAKE_DSH_MODE: ok (default) | unknown-session | error | hang
import fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("dsh 0.0.0-fake");
  process.exit(0);
}
const stdin = fs.readFileSync(0, "utf8");
const at = args.indexOf("--session-id");
const sessionId = at >= 0 ? args[at + 1] : null;
const mode = process.env.FAKE_DSH_MODE || "ok";
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
        PAPERCLIP_RUN_ID: process.env.PAPERCLIP_RUN_ID,
        PAPERCLIP_TASK_ID: process.env.PAPERCLIP_TASK_ID,
        PAPERCLIP_API_KEY_SET: Boolean(process.env.PAPERCLIP_API_KEY),
        DEEPSEEK_API_KEY_SET: Boolean(process.env.DEEPSEEK_API_KEY),
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
emit({ type: "status", phase: "turn_end" });
emit({ type: "final", sessionId: id, reason: { kind: "completed" }, text: `Finished (${stdin.length} chars of task)` });
if (mode === "hang") setInterval(() => {}, 1000);
