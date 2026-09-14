// Mock-context tests for the V2 plugin entry (src/index.ts).
// Run: node tests/plugin.mock.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = await import("../src/index.ts");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  [FAIL] ${name}: ${error.message}`);
  }
}

await check("default export carries id and setup", () => {
  assert.equal(plugin.default?.id, "superpowers", "default export id");
  assert.equal(typeof plugin.default.setup, "function", "setup is a function");
});

// --- mock ctx ---
const added = [];
const hooks = {};
const history = new Map();
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
    async context({ sessionID }) {
      if (sessionID === "s-error") throw new Error("history unavailable");
      return history.get(sessionID) ?? [];
    },
  },
};

await plugin.default.setup(ctx);

await check("skills registered == skills on disk", () => {
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
});

await check("skills without a description are skipped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superpowers-skills-"));
  try {
    fs.mkdirSync(path.join(dir, "nodesc"));
    fs.writeFileSync(path.join(dir, "nodesc", "SKILL.md"), "---\nname: No Desc\n---\nBody");
    assert.deepEqual(plugin.loadSkills(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- prompt hook ---
const run = async (sessionID, text, extra = {}) => {
  const event = { sessionID, messageID: "m1", prompt: { text, ...extra }, delivery: "steer" };
  await hooks.prompt(event);
  return event;
};

await check("prompt hook prepends bootstrap to first prompt", async () => {
  assert.equal(typeof hooks.prompt, "function", "prompt hook registered");
  const event = await run("s1", "hello");
  assert.ok(event.prompt.text.includes("EXTREMELY_IMPORTANT"), "bootstrap prepended");
  assert.ok(event.prompt.text.endsWith("hello"), "original text preserved");
});

await check("bootstrap maps skill actions to v2 tool names", async () => {
  const text = (await run("s-tools", "hello")).prompt.text;
  for (const tool of [
    "`patch`",
    "`edit`",
    "`write`",
    "`shell`",
    "`grep`",
    "`glob`",
    "`read`",
    "`skill`",
    "`subagent`",
    "`webfetch`",
  ]) {
    assert.ok(text.includes(tool), `bootstrap maps to ${tool}`);
  }
  assert.ok(text.includes('`agent: "general"`'), "subagent mapping names the agent argument");
  for (const stale of ["apply_patch", "todowrite", "subagent_type"]) {
    assert.ok(!text.includes(stale), `bootstrap drops v1-only ${stale}`);
  }
});

await check("prompt hook leaves later prompts in the same session untouched", async () => {
  assert.equal((await run("s1", "second message")).prompt.text, "second message");
});

await check("prompt hook injects for a new session", async () => {
  assert.ok((await run("s2", "hi")).prompt.text.includes("EXTREMELY_IMPORTANT"));
});

await check("prompt hook leaves already-bootstrapped text untouched", async () => {
  assert.equal((await run("s3", "x EXTREMELY_IMPORTANT y")).prompt.text, "x EXTREMELY_IMPORTANT y");
});

await check("prompt hook shifts file/agent/skill mention offsets", async () => {
  const event = await run("s-mention", "see @a.ts from @explore then @brainstorming", {
    files: [{ uri: "file:///a.ts", mention: { start: 4, end: 9, text: "@a.ts" } }],
    agents: [{ name: "explore", mention: { start: 15, end: 23, text: "@explore" } }],
    skills: [{ id: "brainstorming", mention: { start: 29, end: 43, text: "@brainstorming" } }],
  });
  for (const item of [
    ...event.prompt.files,
    ...event.prompt.agents,
    ...event.prompt.skills,
  ]) {
    const { start, end, text } = item.mention;
    assert.equal(
      event.prompt.text.slice(start, end),
      text,
      `mention ${JSON.stringify(text)} still matches after prepend`,
    );
  }
});

await check("prompt hook skips injection when history already carries the bootstrap", async () => {
  history.set("s-restart", [{ type: "user", text: "old <EXTREMELY_IMPORTANT> bootstrap" }]);
  assert.equal((await run("s-restart", "hello")).prompt.text, "hello");
});

await check("prompt hook still injects when history cannot be read", async () => {
  assert.ok((await run("s-error", "hello")).prompt.text.includes("EXTREMELY_IMPORTANT"));
});

// --- context hook (re-injection after compaction) ---
await check("context hook injects bootstrap into system when context lacks it", async () => {
  assert.equal(typeof hooks.context, "function", "context hook registered");
  const event = { sessionID: "c1", agent: "build", system: [], messages: [], tools: {} };
  await hooks.context(event);
  assert.equal(event.system.length, 1, "one system part added");
  assert.ok(event.system[0].text.includes("EXTREMELY_IMPORTANT"), "system part is the bootstrap");
});

await check("context hook is a no-op when messages carry the bootstrap", async () => {
  const event = {
    sessionID: "c1",
    agent: "build",
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "EXTREMELY_IMPORTANT doc" }] }],
    tools: {},
  };
  await hooks.context(event);
  assert.equal(event.system.length, 0);
});

await check("context hook is a no-op when the system prompt already has it", async () => {
  const event = {
    sessionID: "c1",
    agent: "build",
    system: [{ type: "text", text: "EXTREMELY_IMPORTANT doc" }],
    messages: [],
    tools: {},
  };
  await hooks.context(event);
  assert.equal(event.system.length, 1);
});

// --- frontmatter parsing ---
await check("splitFrontmatter is exported", () => {
  assert.equal(typeof plugin.splitFrontmatter, "function");
});

await check("splitFrontmatter parses plain LF frontmatter", () => {
  const { data, body } = plugin.splitFrontmatter("---\nname: X\ndescription: Y\n---\nBody");
  assert.equal(data.name, "X");
  assert.equal(data.description, "Y");
  assert.equal(body.trim(), "Body");
});

await check("splitFrontmatter handles CRLF frontmatter", () => {
  const { data, body } = plugin.splitFrontmatter(
    '---\r\nname: X\r\ndescription: "Y: Z"\r\n---\r\nBody\r\n',
  );
  assert.equal(data.name, "X");
  assert.equal(data.description, "Y: Z");
  assert.equal(body.trim(), "Body");
});

await check("splitFrontmatter handles a BOM", () => {
  const { data, body } = plugin.splitFrontmatter("\uFEFF---\nname: A\ndescription: B\n---\nC");
  assert.equal(data.name, "A");
  assert.equal(body.trim(), "C");
});

await check("splitFrontmatter returns the raw text when there is no frontmatter", () => {
  const { data, body } = plugin.splitFrontmatter("just text");
  assert.deepEqual(data, {});
  assert.equal(body, "just text");
});

// --- buildBootstrap edge case ---
await check("buildBootstrap returns null without using-superpowers", () => {
  assert.equal(plugin.buildBootstrap([]), null);
});

await check("buildBootstrap includes the tool mapping when using-superpowers exists", () => {
  const built = plugin.buildBootstrap([
    { id: "using-superpowers", name: "using-superpowers", description: "x", location: "/x", content: "body" },
  ]);
  assert.ok(built.includes("body"), "skill body included");
  assert.ok(built.includes("Tool Mapping"), "tool mapping included");
});

console.log("");
if (failures > 0) {
  console.log(`${failures} mock test(s) failed`);
  process.exit(1);
}
console.log("All mock tests passed");
