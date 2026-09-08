# superpowers-opencode

[Superpowers](https://github.com/obra/superpowers) skills as an
[OpenCode V2 plugin](https://opencode.ai/v2/docs/build/plugins).

- Registers all bundled skills through `ctx.skill.transform` (no symlinks,
  no manual `skills` paths).
- Injects the `using-superpowers` bootstrap into each session's first prompt
  through `ctx.session.hook("prompt", ...)` — once per session, and never
  re-injected on retries.
- Ships the V1 plugin unchanged as `src/v1-compat.js` (package `main`), so
  the same install also works on OpenCode V1.

Skills are synced verbatim from upstream; only the plugin wrapper is
V2-specific. Last upstream sync: see `skills/.upstream-commit`.

## Install (OpenCode V2)

```sh
opencode2 plugin add github:<you>/superpowers-opencode
```

or pin it in config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:<you>/superpowers-opencode"],
}
```

Verify by asking: "Tell me about your superpowers".

## Install (OpenCode V1)

```json
{
  "plugin": ["superpowers-opencode@git+https://github.com/<you>/superpowers-opencode.git"]
}
```

The V1 entry point (`src/v1-compat.js`, zero dependencies) is byte-identical
to upstream's `.opencode/plugins/superpowers.js`.

## Updating skills from upstream

```sh
npm run sync-upstream
```

This shallow-clones `obra/superpowers`, copies `skills/`, and records the
commit in `skills/.upstream-commit`. CI fails when the checkout is behind
upstream (see `.github/workflows/sync-check.yml`).

## Tool mapping

Skills speak in actions; on OpenCode these resolve to:

- Create or update todos → `todowrite`
- `Subagent (general-purpose):` → `task` with `subagent_type: "general"`
- Invoke a skill → native `skill` tool
- Read files → `read`
- Create, edit, or delete files → `apply_patch`
- Run shell commands → `bash`
- Search files → `grep`, `glob`
- Fetch a URL → `webfetch`

## Development

```sh
npm install
npm run typecheck
npm test
```

## License

MIT — see [LICENSE](LICENSE).
