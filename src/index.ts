/**
 * Superpowers plugin for OpenCode v2.
 *
 * - Registers the bundled `skills/` directory via `ctx.skill.transform`.
 * - Injects the using-superpowers bootstrap into the first prompt of each
 *   session via `ctx.session.hook("prompt", ...)`.
 * - Re-injects it through `ctx.session.hook("context", ...)` when compaction
 *   has dropped it from the model context.
 */

import { Plugin, type Skill } from "@opencode/plugin";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
export function loadSkills(dir: string): SkillDef[] {
  const out: SkillDef[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a: fs.Dirent, b: fs.Dirent) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const { data, body } = splitFrontmatter(fs.readFileSync(skillFile, "utf8"));
    const description = (data.description ?? "").trim();
    if (!description) {
      // v2 advertises any skill whose description is defined, even an empty
      // string, so a missing description means the skill is unloadable in
      // practice. Skip it instead of registering a blank listing.
      console.warn(`superpowers: skipping skill "${entry.name}": SKILL.md has no description`);
      continue;
    }
    out.push({
      id: entry.name,
      name: data.name || entry.name,
      description,
      location: skillFile,
      content: body.trim(),
    });
  }
  return out;
}

const TOOL_MAPPING = `**Tool Mapping for OpenCode v2:**
When skills request actions, substitute OpenCode equivalents:
- Create, edit, or delete files → \`patch\`, \`edit\`, \`write\`
- Run shell commands → \`shell\`
- Search files → \`grep\`, \`glob\`
- Read files → \`read\`
- Invoke a skill → OpenCode's native \`skill\` tool
- \`Subagent (general-purpose):\` → \`subagent\` with \`agent: "general"\`
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
      // The hook runs once per admission (not per model call). `injected` is a
      // fast path for sessions this hook has already handled; `pending` keeps
      // concurrent admissions of one session from both injecting. On a cold
      // miss (server restart, eviction) the marker check against stored history
      // is the source of truth, so nothing is injected twice.
      const injected = new Set<string>();
      const pending = new Set<string>();
      await ctx.session.hook("prompt", async (event) => {
        if (!bootstrap) return;
        const sessionID = String(event.sessionID);
        if (injected.has(sessionID) || pending.has(sessionID)) return;
        pending.add(sessionID);
        try {
          const text = event.prompt.text ?? "";
          if (text.includes(BOOTSTRAP_MARKER)) {
            injected.add(sessionID);
            return;
          }
          try {
            const history = await ctx.session.context({ sessionID: event.sessionID });
            if (carriesBootstrap(history)) {
              injected.add(sessionID);
              return;
            }
          } catch {
            // Fresh sessions have no stored history yet; inject below.
          }

          if (injected.size > 5000) injected.clear();
          const prefix = `${bootstrap}\n\n`;
          event.prompt.text = prefix + text;
          shiftMentions(event.prompt, prefix.length);
          injected.add(sessionID);
        } finally {
          pending.delete(sessionID);
        }
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
};
