# superpowers-opencode2

[![ci](https://github.com/Lemonawa/superpowers-opencode2/actions/workflows/ci.yml/badge.svg)](https://github.com/Lemonawa/superpowers-opencode2/actions/workflows/ci.yml)

[Superpowers](https://github.com/obra/superpowers) skills as an
[OpenCode V2 plugin](https://opencode.ai/v2/docs/build/plugins).

Upstream superpowers ships a V1-only plugin (`.opencode/plugins/superpowers.js`).
This repo wraps the same skills in the V2 plugin API so they install and run on
OpenCode v2, while keeping V1 support through the same package.

- **V2**: registers all bundled skills via `ctx.skill.transform`, injects the
  `using-superpowers` bootstrap into each session's first prompt via
  `ctx.session.hook("prompt", ...)`, and re-adds it on model requests through
  `ctx.session.hook("context", ...)` once compaction drops it. The prompt hook
  shifts file/agent/skill mention offsets, and a marker check against stored
  history stops double injection after a restart.
- **V1**: loads upstream's plugin (via package `main` / `exports["./server"]`)
  with one path fix for this package layout; it has no dependencies.
- **Skills**: synced verbatim from upstream; only the wrapper is V2-specific.
  Current upstream commit: see `skills/.upstream-commit`.

## Install on OpenCode v2

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

## Install on OpenCode V1

```json
{
  "plugin": [
    "superpowers-opencode2@git+https://github.com/Lemonawa/superpowers-opencode2.git"
  ]
}
```

V1 resolves package `exports["./server"]` (falling back to `main`) to the same
dual entrypoint and calls its `server()`, which wraps upstream's V1 plugin with
the skills path pointed at this package's `skills/`. Works on OpenCode V1
1.18.x (tested on 1.18.30). `main` still points at the dependency-free
`src/v1-compat.js` for older loaders.

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

Skills speak in actions; on OpenCode these resolve to:

| Skill asks for              | Use on OpenCode              |
| --------------------------- | ---------------------------- |
| Create or update todos      | `todowrite`                  |
| `Subagent (general-purpose)`| `task` with `subagent_type: "general"` |
| Invoke a skill              | native `skill` tool          |
| Read files                  | `read`                       |
| Create, edit, delete files  | `apply_patch`                |
| Run shell commands          | `bash`                       |
| Search files                | `grep`, `glob`               |
| Fetch a URL                 | `webfetch`                   |

## How it works

`src/index.ts` (V2 entry, resolved through the package `exports` map):

1. **Setup** reads every `skills/<id>/SKILL.md`, strips frontmatter, and calls
   `ctx.skill.transform` once to register `{ id, name, description, location,
   content }`. `location` points at the real `SKILL.md` so supporting files
   (scripts, references) resolve next to it.
2. A **prompt hook** prepends the bootstrap (full `using-superpowers` body +
   the tool mapping above) to the first admitted prompt of each session and
   shifts the `mention` offsets of attached files/agents/skills so they still
   point at the same text. The hook runs once per admission. Its in-memory
   session set is only a fast path: on a miss (server restart, eviction) it
   checks stored history for the marker, so nothing is injected twice and
   nothing is injected on top of an existing bootstrap.
3. A **context hook** re-adds the bootstrap to the request's system prompt
   whenever a model request would run without it. Compaction replaces older
   context with a checkpoint, so this keeps long sessions covered without
   persisting a second copy. (The V1 entry uses upstream's per-step message
   transform instead.)
4. `using-superpowers` is registered as a skill too (same as V1, where the
   whole directory was discoverable); the bootstrap text tells the model it is
   already loaded and must not be loaded again.

Both entries live in the same default export: V2 reads `id`/`setup`, V1 reads
`server()` (upstream's plugin).

## Keeping skills updated

Skills are vendored, not referenced, so updates are explicit:

```sh
npm run sync-upstream          # pull latest obra/superpowers skills/
./scripts/sync-upstream.sh --check   # exit 1 when behind upstream
```

`sync-upstream.sh` shallow-clones upstream, copies `skills/`, and records the
commit in `skills/.upstream-commit`. The `sync-check` workflow runs this check
weekly (and on demand) and fails when the checkout is behind — update, test,
push.

## Development

```sh
npm install        # installs @opencode/plugin (same major as the opencode v2 release)
npm run typecheck  # tsc --noEmit, strict
npm test           # smoke.sh (syntax, frontmatter, entry shape) + mock-context test
```

Layout:

```text
src/index.ts        V2 plugin (Plugin.define) + V1 server() export
src/v1-compat.js    upstream's V1 plugin, one-line skills path fix
skills/             vendored upstream skills + .upstream-commit
scripts/sync-upstream.sh
tests/smoke.sh tests/plugin.mock.mjs
.github/workflows/  ci.yml, sync-check.yml
```

### Verified against

- `opencode v2.0.3`, `@opencode/plugin@2.0.3`: plugin loads with no errors,
  14/14 skills register, the prompt hook injects the bootstrap before
  admission, mention offsets survive the prepend, and a server restart does
  not re-inject into a session that already has it.
- `opencode v1.18.30`: plugin loads through `main`/`exports["./server"]`,
  registers the skills path, and the provider request carries the bootstrap.
  Pinned in CI by `npm test` (no V1 binary is exercised there).

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

**Skills not listed**: the `skill` tool advertises only skills with a
`description`; every bundled skill has one. Check for an ID clash with a
project/personal skill, which wins by precedence.

**Bootstrap missing**: it is prepended to the first admitted user prompt. A
session that predates the plugin gets it in the system prompt on its next
model request through the context hook.

## License

MIT — see [LICENSE](LICENSE). Skills and the V1 plugin are upstream work
(Jesse Vincent); the V2 wrapper is by this repo's contributors.
