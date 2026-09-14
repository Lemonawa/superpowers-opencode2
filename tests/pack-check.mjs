// Verify the published tarball carries everything the package needs.
// Run: node tests/pack-check.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
assert.equal(manifest.exports["."], "./src/index.ts", "package entry is the V2 plugin");
assert.ok(!("main" in manifest), "no legacy main entry");
assert.ok(!("./server" in manifest.exports), "no V1 server subpath");

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" });
const parsed = JSON.parse(raw);
const pkg = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
const files = new Set(pkg.files.map((file) => file.path));

const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "src/index.ts",
  "skills/.upstream-commit",
  "skills/using-superpowers/SKILL.md",
  "scripts/sync-upstream.sh",
  "tests/smoke.sh",
  "tests/plugin.mock.mjs",
  "tests/pack-check.mjs",
  "tests/opencode-smoke.mjs",
];
for (const file of required) {
  assert.ok(files.has(file), `tarball contains ${file}`);
}

assert.ok(!files.has("src/v1-compat.js"), "tarball has no V1 entry");

console.log(`  [PASS] tarball contains ${required.length} required files (${files.size} total)`);
