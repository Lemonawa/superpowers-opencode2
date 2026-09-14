// Optional end-to-end check: boot a standalone OpenCode v2 server against this
// checkout through a shim plugin dir, then confirm the plugin loads and injects
// the v2 bootstrap into the first admitted prompt. The run uses an invalid
// model, so no provider request is made; everything runs in a temp dir with
// isolated config/data/cache/state.
//
// Needs `opencode` v2 on PATH. Run: node tests/opencode-smoke.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  console.log("  [SKIP] node:sqlite is unavailable on this Node version");
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const probe = spawnSync("opencode", ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.log("  [SKIP] opencode not found on PATH");
  process.exit(0);
}
console.log(`  [INFO] ${(probe.stdout || "").trim()}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "superpowers-e2e-"));
try {
  const shim = path.join(tmp, "shim");
  const project = path.join(tmp, "project");
  const config = path.join(tmp, "config");
  const data = path.join(tmp, "data");
  const cache = path.join(tmp, "cache");
  const state = path.join(tmp, "state");
  for (const dir of [shim, project, config, data, cache, state]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    path.join(shim, "index.ts"),
    `export { default } from ${JSON.stringify(path.join(ROOT, "src", "index.ts"))};\n`,
  );
  fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify({ plugins: [shim] }, null, 2) + "\n");

  const run = spawnSync(
    "opencode",
    ["run", "--standalone", "--print-logs", "--model", "superpowers-smoke/none", "hello"],
    {
      cwd: project,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        PWD: project,
        OPENCODE_CONFIG_DIR: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: cache,
        XDG_STATE_HOME: state,
      },
    },
  );
  const log = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.ok(log.includes("loading plugin"), "plugin load is logged");
  assert.ok(log.includes(shim), "the local checkout is the loaded plugin");
  assert.ok(!log.includes("failed to load plugin"), "no failed to load");

  // The run stops at model resolution, but the prompt was already admitted, so
  // the stored first user message shows what the prompt hook injected.
  const dbFile = path.join(data, "opencode", "opencode.db");
  assert.ok(fs.existsSync(dbFile), "isolated session database was written");
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const text = db
    .prepare("select data from session_message order by seq")
    .all()
    .map((row) => JSON.parse(row.data).text ?? "")
    .join("\n");
  assert.ok(text.includes("EXTREMELY_IMPORTANT"), "bootstrap injected into the stored prompt");
  assert.ok(text.includes("Tool Mapping for OpenCode v2"), "v2 tool mapping injected");

  console.log("  [PASS] plugin loads and injects the v2 bootstrap");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
