# superpowers-opencode2

[![ci](https://github.com/Lemonawa/superpowers-opencode2/actions/workflows/ci.yml/badge.svg)](https://github.com/Lemonawa/superpowers-opencode2/actions/workflows/ci.yml)

[Superpowers](https://github.com/obra/superpowers) skills as an
[OpenCode V2 plugin](https://opencode.ai/v2/docs/build/plugins).

Upstream superpowers ships a V1-only plugin (`.opencode/plugins/superpowers.js`).
This repo wraps the same skills in the V2 plugin API so they install and run on
`opencode2`, while keeping the V1 entry working from the same package.

- **V2**: registers all bundled skills via `ctx.skill.transform`, injects the
  `using-superpowers` bootstrap into each session's first prompt via
  `ctx.session.hook("prompt", ...)` — once per session, never re-injected.
- **V1**: ships upstream's plugin unchanged as `src/v1-compat.js` (package
  `main`), zero dependencies.
- **Skills**: synced verbatim from upstream; only the wrapper is V2-specific.
  Current upstream commit: see `skills/.upstream-commit`.

## Install on OpenCode V2

```sh
opencode2 plugin add github:Lemonawa/superpowers-opencode2
```

Or declare it in config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:Lemonawa/superpowers-opencode2"],
}
```

Restart OpenCode, then verify:

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

This resolves the package `main` (`src/v1-compat.js`), byte-identical to
upstream's V1 plugin. Requires OpenCode V1 >= 1.18 (function-export form).

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
   the tool mapping above) to the first admitted prompt of each session. The
   hook runs once per admission, so unlike V1's message transform there is no
   per-step cost and no re-injection. A per-session set plus a marker guard
   make double injection impossible (retries return the original admission
   without rerunning hooks).
3. `using-superpowers` is registered as a skill too (same as V1, where the
   whole directory was discoverable); the bootstrap text tells the model it is
   already loaded and must not be loaded again.

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
npm install        # installs @opencode-ai/plugin@beta (pinned to opencode2's beta)
npm run typecheck  # tsc --noEmit, strict
npm test           # smoke.sh (syntax, frontmatter, entry shape) + mock-context test
```

Layout:

```text
src/index.ts        V2 plugin (Plugin.define)
src/v1-compat.js    V1 plugin, verbatim upstream
skills/             vendored upstream skills + .upstream-commit
scripts/sync-upstream.sh
tests/smoke.sh tests/plugin.mock.mjs
.github/workflows/ ci.yml, sync-check.yml
```

### Verified against

- `opencode2 v0.0.0-beta-19242`, `@opencode-ai/plugin@beta` (same build)
- Live-server test: plugin loads with no errors, 14/14 skills register,
  prompt hook injects the bootstrap (marker-verified) before model dispatch.

## Known issues (opencode2 beta)

Observed on `beta-19242`, all client-side beta gaps (not this plugin):

1. Bare `.ts` files under `.opencode/plugins/` cannot `import
   "@opencode-ai/plugin"` (`Cannot find package`). Package installs (with
   `node_modules`) are unaffected — install via `plugin add`, not by copying
   `src/index.ts` next to your config.
2. Package directories placed manually under `.opencode/plugins/` are not
   discovered in this beta. Again, `plugin add` is the supported path.
3. `run --standalone` ignores `opencode.json(c)` (`plugins` entries included).
   Prefer the managed background service for config-driven setups.
4. `models --standalone` is rejected despite being listed in help.

If any of these persist on newer betas, they are worth reporting upstream
(the plugin API itself works as documented).

## Troubleshooting

**Plugin not loading**: `opencode2 run --standalone --print-logs "hello" 2>&1 |
grep -i "loading plugin\|failed to load"`. A `failed to load plugin` line names
the cause (usually dependency resolution when installed outside a package).

**Skills not listed**: the `skill` tool advertises only skills with a
`description`; every bundled skill has one. Check for an ID clash with a
project/personal skill, which wins by precedence.

**Bootstrap missing**: it is prepended to the first admitted user prompt. If a
session was created before the plugin was installed, start a new session.

## License

MIT — see [LICENSE](LICENSE). Skills and the V1 plugin are upstream work
(Jesse Vincent); the V2 wrapper is by this repo's contributors.
