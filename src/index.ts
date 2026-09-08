/**
 * Superpowers plugin for OpenCode V2.
 *
 * - Registers the bundled `skills/` directory via `ctx.skill.transform`.
 * - Injects the using-superpowers bootstrap into the first prompt of each
 *   session via `ctx.session.hook("prompt", ...)`.
 *
 * V1 clients keep working through `src/v1-compat.js` (package `main`);
 * V2 resolves this file through the `exports` map.
 */

import { Plugin, Skill } from "@opencode-ai/plugin";
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

/** Split `---` YAML frontmatter from a SKILL.md body (no dependencies). */
function splitFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      data[line.slice(0, idx).trim()] = line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
  return { data, body: match[2] };
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

export default Plugin.define({
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
    // The hook runs once per admission (not per model call), so unlike the
    // V1 message transform this needs no re-injection and no per-step cost.
    const injected = new Set<string>();
    await ctx.session.hook("prompt", (event) => {
      if (!bootstrap) return;
      const sessionID = event.sessionID as string;
      if (injected.has(sessionID)) return;
      if (injected.size > 5000) injected.clear();
      injected.add(sessionID);
      const text = event.prompt.text ?? "";
      if (text.includes(BOOTSTRAP_MARKER)) return;
      event.prompt.text = `${bootstrap}\n\n${text}`;
    });
  },
});
