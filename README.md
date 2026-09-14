# superpowers-opencode2

[![ci](https://github.com/Lemonawa/superpowers-opencode2/actions/workflows/ci.yml/badge.svg)](https://github.com/Lemonawa/superpowers-opencode2/actions/workflows/ci.yml)

[Superpowers](https://github.com/obra/superpowers) skills as an
[OpenCode v2 plugin](https://opencode.ai/v2/docs/build/plugins).

- **Skills**: registers every bundled `skills/<id>/SKILL.md` through
  `ctx.skill.transform`, so they show up in OpenCode's native `skill` tool like
  any other skill.
- **Bootstrap**: injects the `using-superpowers` bootstrap into each session's
  first prompt via `ctx.session.hook("prompt", ...)`, and re-adds it to the
  system prompt through `ctx.session.hook("context", ...)` once compaction
  drops it.
- **Vendored skills**: synced verbatim from upstream; only the wrapper is
  repo-specific. Current upstream commit: see `skills/.upstream-commit`.

## Install

```sh
opencode plugin add github:Lemonawa/superpowers-opencode2
```

Or declare it in config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:Lemonawa/superpowers-opencode2"],
}
```

Requires OpenCode v2 (tested on v2.0.3). Restart OpenCode, then verify:

> Tell me about your superpowers

The model should announce it is using superpowers and follow the
`using-superpowers` bootstrap (check for skills before acting).

## Usage

Use OpenCode's native `skill` tool:

```
use skill tool to list skills
use skill tool to load brainstorming
```

Project skills (`<project>/.opencode/skills/`) and personal skills
(`~/.config/opencode/skills/`) keep higher precedence than these bundled ones;
a same-ID skill in those locations overrides the bundled copy.

### Tool mapping

Skills speak in actions; on OpenCode v2 these resolve to:

| Skill asks for                 | Use on OpenCode v2                 |
| ------------------------------ | ---------------------------------- |
| Create, edit, or delete files  | `patch`, `edit`, `write`           |
| Run shell commands             | `shell`                            |
| Search files                   | `grep`, `glob`                     |
| Read files                     | `read`                             |
| Invoke a skill                 | native `skill` tool                |
| `Subagent (general-purpose):`  | `subagent` with `agent: "general"` |
| Fetch a URL                    | `webfetch`                         |

The bootstrap injected into each session carries the same mapping.

## How it works

`src/index.ts` is the plugin entry (resolved through the package `exports` map):

1. **Setup** reads every `skills/<id>/SKILL.md`, strips frontmatter, and calls
   `ctx.skill.transform` once to register `{ id, name, description, location,
   content }`. `location` points at the real `SKILL.md` so supporting files
   (scripts, references) resolve next to it. A `SKILL.md` without a description
   is skipped with a warning: v2 otherwise advertises it with a blank
   description.
2. A **prompt hook** prepends the bootstrap (full `using-superpowers` body +
   the tool mapping above) to the first admitted prompt of each session and
   shifts the `mention` offsets of attached files/agents/skills so they still
   point at the same text. The hook runs once per admission. Its in-memory
   session set is only a fast path: on a miss (server restart, eviction) the
   marker check against stored history decides, so nothing is injected twice.
3. A **context hook** re-adds the bootstrap to the request's system prompt
   whenever a model request would run without it. Compaction replaces older
   context with a checkpoint, dropping the bootstrap with it; after a
   compaction the next admitted prompt is re-injected by the prompt hook, and
   the context hook covers the requests in between. Nothing extra is
   persisted.
4. `using-superpowers` is registered as a skill too; the bootstrap text tells
   the model it is already loaded and must not be loaded again.

## Keeping skills updated

Skills are vendored, not referenced, so updates are explicit:

```sh
npm run sync-upstream          # pull latest obra/superpowers skills/
./scripts/sync-upstream.sh --check   # exit 1 when behind upstream
```

`sync-upstream.sh` shallow-clones upstream, copies `skills/`, and records the
commit in `skills/.upstream-commit`. The `sync-check` workflow runs this check
weekly, on demand, and on pull requests that touch `skills/`.

## Development

```sh
npm install        # installs @opencode/plugin (same major as the opencode v2 release)
npm run typecheck  # tsc --noEmit, strict
npm test           # smoke.sh (syntax, frontmatter, entry shape) + pack check + mock-context tests
node tests/opencode-smoke.mjs   # optional end-to-end check (needs opencode v2 on PATH)
```

CI runs `typecheck` + `npm test` on every push and PR, plus the end-to-end
smoke against a pinned `opencode v2.0.3`.

Layout:

```text
src/index.ts        the v2 plugin (Plugin.define)
skills/             vendored upstream skills + .upstream-commit
scripts/sync-upstream.sh
tests/smoke.sh tests/pack-check.mjs tests/plugin.mock.mjs tests/opencode-smoke.mjs
.github/workflows/  ci.yml, sync-check.yml
```

### Verified against

- `opencode v2.0.3`, `@opencode/plugin@2.0.3`: the plugin loads with no
  errors and the prompt hook injects the bootstrap (with the v2 tool mapping)
  into the stored first user message of a session. The mock-context suite
  covers the rest: 14/14 skills register, mention offsets survive the prepend,
  and a server restart does not re-inject into a session that already has it.

### Local development

Configured local plugin directories resolve a root `server`/`index` file, not
the package `exports` map. To point a local OpenCode at this checkout, use a
shim directory:

```ts
// /tmp/local-superpowers/index.ts
export { default } from "/path/to/superpowers-opencode2/src/index.ts";
```

```jsonc
{ "plugins": ["/tmp/local-superpowers"] }
```

Package installs (`plugin add`) use the package `exports` map and need no shim.

## Troubleshooting

**Plugin not loading**: `opencode run --standalone --print-logs "hello" 2>&1 |
grep -i "loading plugin\|failed to load"`. A `failed to load plugin` line names
the cause (usually dependency resolution when installed outside a package).

**Skills not listed**: the `skill` tool advertises skills with a
`description`; every bundled skill has one, and a `SKILL.md` missing one is
skipped with a warning at setup. Check for an ID clash with a project/personal
skill, which wins by precedence.

**Bootstrap missing**: it is prepended to the first admitted user prompt. A
session that predates the plugin gets it in the system prompt on its next
model request through the context hook.

## License

MIT — see [LICENSE](LICENSE). Skills are upstream work (Jesse Vincent); the v2
wrapper is by this repo's contributors.
