// Mock-context tests for the V2 plugin entry (src/index.ts) and the V1 surface.
// Run: node tests/plugin.mock.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
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

// --- V1 surface (src/v1-compat.js through the same default export) ---
await check("./server export resolves to the same dual module as `.`", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(
    pkg.exports["./server"],
    pkg.exports["."],
    "opencode v2 resolves ./server before `.`; both must expose id+setup",
  );
});

await check("default export exposes a V1 server()", () => {
  assert.equal(typeof plugin.default.server, "function", "server is a function");
});

await check("V1 server() returns upstream hooks and registers an existing skills dir", async () => {
  const v1 = await plugin.default.server({ client: {}, directory: ROOT });
  assert.equal(typeof v1.config, "function", "config hook");
  const config = {};
  await v1.config(config);
  assert.ok(Array.isArray(config.skills.paths), "skills.paths array");
  assert.ok(
    config.skills.paths.some((p) => fs.existsSync(path.join(p, "using-superpowers", "SKILL.md"))),
    `registered skills dir exists: ${config.skills.paths.join(", ")}`,
  );
});

await check("V1 message transform injects a real bootstrap", async () => {
  const v1 = await plugin.default.server({ client: {}, directory: ROOT });
  const output = {
    messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }],
  };
  await v1["experimental.chat.messages.transform"]({}, output);
  const text = output.messages[0].parts[0].text;
  assert.ok(text.includes("EXTREMELY_IMPORTANT"), "bootstrap present");
  assert.ok(text.includes("You have superpowers."), "bootstrap body present");
});

console.log("");
if (failures > 0) {
  console.log(`${failures} mock test(s) failed`);
  process.exit(1);
}
console.log("All mock tests passed");
