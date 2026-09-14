/**
 * Superpowers plugin for OpenCode V2.
 *
 * - Registers the bundled `skills/` directory via `ctx.skill.transform`.
 * - Injects the using-superpowers bootstrap into the first prompt of each
 *   session via `ctx.session.hook("prompt", ...)`.
 * - Re-injects it through `ctx.session.hook("context", ...)` when compaction
 *   has dropped it from the model context.
 * - Exposes the V1 implementation as `server()` so V1 clients keep working
 *   from the same package (`main`/`exports["./server"]` point at
 *   `src/v1-compat.js`, which upstream's V1 loader understands).
 */

import { Plugin, type Skill } from "@opencode/plugin";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SuperpowersPlugin } from "./v1-compat.js";

const skillsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../skills",
);

const BOOTSTRAP_MARKER = "EXTREMELY_IMPORTANT";

interface SkillDef {
  id: string;
  name: string;
  description: string;
  location: string;
  content: string;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

/** Split `---` YAML frontmatter from a SKILL.md body (no dependencies). */
export function splitFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/);
  if (!match) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      data[line.slice(0, idx).trim()] = unquote(line.slice(idx + 1).trim());
    }
  }
  return { data, body: match[2] ?? "" };
}

/** Read every `skills/<id>/SKILL.md` into registration entries. */
function loadSkills(dir: string): SkillDef[] {
  const out: SkillDef[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a: fs.Dirent, b: fs.Dirent) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const { data, body } = splitFrontmatter(fs.readFileSync(skillFile, "utf8"));
    out.push({
      id: entry.name,
      name: data.name || entry.name,
      description: data.description || "",
      location: skillFile,
      content: body.trim(),
    });
  }
  return out;
}

const TOOL_MAPPING = `**Tool Mapping for OpenCode:**
When skills request actions, substitute OpenCode equivalents:
- Create or update todos → \`todowrite\`
- \`Subagent (general-purpose):\` → \`task\` with \`subagent_type: "general"\`
- Invoke a skill → OpenCode's native \`skill\` tool
- Read files → \`read\`
- Create, edit, or delete files → \`apply_patch\`
- Run shell commands → \`bash\`
- Search files → \`grep\`, \`glob\`
- Fetch a URL → \`webfetch\`

Use OpenCode's native \`skill\` tool to list and load skills.`;

/** Build the bootstrap text prepended to each session's first prompt. */
export function buildBootstrap(skills: SkillDef[]): string | null {
  const intro = skills.find((s) => s.id === "using-superpowers");
  if (!intro) return null;
  return `<${BOOTSTRAP_MARKER}>
You have superpowers.

**IMPORTANT: The using-superpowers skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the skill tool to load "using-superpowers" again - that would be redundant.**

${intro.content}

${TOOL_MAPPING}
</${BOOTSTRAP_MARKER}>`;
}

/**
 * True when any stored history entry or assembled model message carries the
 * bootstrap. `event.messages` are `@opencode/ai` messages (`content` parts);
 * `ctx.session.context()` returns persisted `SessionMessageInfo` records
 * (`text` on user/synthetic/system/skill entries, `content` on assistants).
 */
function carriesBootstrap(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.includes(BOOTSTRAP_MARKER)) return true;
    if (!Array.isArray(record.content)) continue;
    for (const part of record.content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string" && text.includes(BOOTSTRAP_MARKER)) return true;
    }
  }
  return false;
}

interface PromptWithMentions {
  files?: unknown;
  agents?: unknown;
  skills?: unknown;
}

/** Keep `@file`/`@agent`/skill mention offsets aligned after prepending text. */
function shiftMentions(prompt: PromptWithMentions, delta: number): void {
  for (const list of [prompt.files, prompt.agents, prompt.skills]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const mention = (item as { mention?: { start?: unknown; end?: unknown } }).mention;
      if (!mention || typeof mention.start !== "number" || typeof mention.end !== "number") continue;
      mention.start += delta;
      mention.end += delta;
    }
  }
}

export default {
  ...Plugin.define({
    id: "superpowers",
    async setup(ctx) {
      const skills = loadSkills(skillsDir);
      const bootstrap = buildBootstrap(skills);

      await ctx.skill.transform((editor) => {
        for (const s of skills) {
          editor.add({
            id: s.id as Skill.Info["id"],
            name: s.name as Skill.Info["name"],
            description: s.description,
            location: s.location as Skill.Info["location"],
            content: s.content,
          });
        }
      });

      // Prepend the bootstrap to the first admitted prompt of each session.
      // The hook runs once per admission (not per model call). The in-memory
      // set is only a fast path: when it misses (server restart, eviction),
      // the marker check against stored history prevents double injection.
      const injected = new Set<string>();
      await ctx.session.hook("prompt", async (event) => {
        if (!bootstrap) return;
        const sessionID = String(event.sessionID);
        if (injected.has(sessionID)) return;
        if (injected.size > 5000) injected.clear();
        injected.add(sessionID);

        const text = event.prompt.text ?? "";
        if (text.includes(BOOTSTRAP_MARKER)) return;
        try {
          const history = await ctx.session.context({ sessionID: event.sessionID });
          if (carriesBootstrap(history)) return;
        } catch {
          // Fresh sessions have no stored history yet; inject below.
        }

        const prefix = `${bootstrap}\n\n`;
        event.prompt.text = prefix + text;
        shiftMentions(event.prompt, prefix.length);
      });

      // Compaction replaces older context with a checkpoint, dropping the
      // bootstrap with it. Re-add it to the system prompt whenever a model
      // request would otherwise run without it (request-scoped, not persisted).
      await ctx.session.hook("context", (event) => {
        if (!bootstrap) return;
        if (carriesBootstrap(event.messages)) return;
        if (event.system.some((part) => part.text.includes(BOOTSTRAP_MARKER))) return;
        event.system.push({ type: "text", text: bootstrap });
      });
    },
  }),
  // V1 clients resolve this through `main`/`exports["./server"]`.
  server: SuperpowersPlugin,
};
