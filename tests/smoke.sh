#!/usr/bin/env bash
# Smoke tests: syntax, skill frontmatter, bootstrap prerequisites.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== syntax =="
node --check "$ROOT/src/v1-compat.js"
echo "  [PASS] v1-compat.js syntax"

echo "== skills =="
count=0
missing=0
for f in "$ROOT"/skills/*/SKILL.md; do
  count=$((count + 1))
  if ! head -5 "$f" | grep -q '^name:'; then echo "  [FAIL] $f missing name"; missing=$((missing + 1)); fi
  if ! head -8 "$f" | grep -q '^description:'; then echo "  [FAIL] $f missing description"; missing=$((missing + 1)); fi
done
[ "$count" -gt 0 ] || { echo "  [FAIL] no skills found"; exit 1; }
[ "$missing" -eq 0 ] || exit 1
echo "  [PASS] $count skills with name+description"

[ -f "$ROOT/skills/using-superpowers/SKILL.md" ] || { echo "  [FAIL] using-superpowers missing (bootstrap source)"; exit 1; }
echo "  [PASS] using-superpowers present"

echo "== v2 entry =="
grep -q 'Plugin.define' "$ROOT/src/index.ts" || { echo "  [FAIL] index.ts missing Plugin.define"; exit 1; }
grep -q '"prompt"' "$ROOT/src/index.ts" || { echo "  [FAIL] index.ts missing prompt hook"; exit 1; }
grep -q '"context"' "$ROOT/src/index.ts" || { echo "  [FAIL] index.ts missing context hook"; exit 1; }
grep -q 'skill.transform' "$ROOT/src/index.ts" || { echo "  [FAIL] index.ts missing skill.transform"; exit 1; }
grep -q 'server:' "$ROOT/src/index.ts" || { echo "  [FAIL] index.ts missing V1 server() entry"; exit 1; }
echo "  [PASS] v2 entry uses Plugin.define + prompt/context hooks + skill.transform + V1 server"

echo "== v1 entry =="
grep -q '"\./server"' "$ROOT/package.json" || { echo "  [FAIL] package.json missing ./server export"; exit 1; }
node -e "const p=require('$ROOT/package.json'); if (p.exports['./server'] !== p.exports['.']) { console.error('  [FAIL] ./server and . must point at the same dual entrypoint'); process.exit(1) }"
grep -q 'SuperpowersPlugin' "$ROOT/src/v1-compat.js" || { echo "  [FAIL] v1-compat.js missing SuperpowersPlugin"; exit 1; }
echo "  [PASS] package exposes ./server on the dual entrypoint; v1-compat.js keeps the upstream plugin"

echo ""
echo "All smoke tests passed"
