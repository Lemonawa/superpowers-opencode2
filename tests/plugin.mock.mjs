// Mock-context test for the V2 plugin entry (src/index.ts).
// Run: node tests/plugin.mock.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = await import("../src/index.ts");

assert.ok(plugin.default?.id === "superpowers", "default export id");
assert.equal(typeof plugin.default.setup, "function", "setup is a function");
assert.equal(typeof plugin.buildBootstrap, "function", "buildBootstrap exported");

// --- mock ctx ---
const added = [];
const hooks = {};
const ctx = {
  skill: {
    async transform(cb) {
      const editor = {
        list: () => [],
        get: () => undefined,
        add: (s) => added.push(s),
        update: () => {},
        remove: () => {},
      };
      cb(editor);
    },
    async reload() {},
  },
  session: {
    async hook(name, cb) {
      hooks[name] = cb;
    },
  },
};

await plugin.default.setup(ctx);

// skills registered == skills on disk
const dirs = fs
  .readdirSync(path.join(ROOT, "skills"), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(ROOT, "skills", e.name, "SKILL.md")))
  .map((e) => e.name)
  .sort();
assert.equal(added.length, dirs.length, `registered ${added.length} == on-disk ${dirs.length}`);
for (const s of added) {
  assert.ok(s.id && s.name && s.location && s.content, `${s.id} has all fields`);
  assert.ok(s.description, `${s.id} has description (required for discovery)`);
  assert.ok(fs.existsSync(s.location), `${s.id} location exists`);
  assert.ok(!s.content.startsWith("---"), `${s.id} content has no frontmatter`);
}
assert.ok(added.some((s) => s.id === "using-superpowers"), "using-superpowers registered");
console.log(`  [PASS] ${added.length} skills registered via skill.transform`);

// prompt hook behavior
assert.equal(typeof hooks.prompt, "function", "prompt hook registered");
const run = (sessionID, text) => {
  const event = { sessionID, messageID: "m1", prompt: { text }, delivery: "steer" };
  hooks.prompt(event);
  return event.prompt.text;
};
const first = run("s1", "hello");
assert.ok(first.includes("EXTREMELY_IMPORTANT"), "bootstrap prepended to first prompt");
assert.ok(first.endsWith("hello"), "original text preserved");
assert.equal(run("s1", "second message"), "second message", "second prompt in session untouched");
assert.ok(run("s2", "hi").includes("EXTREMELY_IMPORTANT"), "new session gets bootstrap");
assert.equal(run("s3", "x EXTREMELY_IMPORTANT y"), "x EXTREMELY_IMPORTANT y", "already-bootstrapped text untouched");
console.log("  [PASS] prompt hook injects once per session with guard");

// buildBootstrap edge case
assert.equal(plugin.buildBootstrap([]), null, "null bootstrap without using-superpowers");
console.log("  [PASS] buildBootstrap edge case");

console.log("");
console.log("All mock tests passed");
