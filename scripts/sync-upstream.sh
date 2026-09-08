#!/usr/bin/env bash
# Sync skills/ from the upstream superpowers repo.
# Usage: ./scripts/sync-upstream.sh [upstream-git-url] [ref]
#        ./scripts/sync-upstream.sh --check [upstream-git-url] [ref]
set -euo pipefail

CHECK=0
if [ "${1:-}" = "--check" ]; then
  CHECK=1
  shift
fi

UPSTREAM="${1:-https://github.com/obra/superpowers.git}"
REF="${2:-main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$CHECK" = "1" ]; then
  git clone --quiet --depth 1 --branch "$REF" "$UPSTREAM" "$TMP/upstream"
  LATEST="$(git -C "$TMP/upstream" rev-parse HEAD)"
  CURRENT="$(cat "$ROOT/skills/.upstream-commit" 2>/dev/null || echo none)"
  if [ "$LATEST" = "$CURRENT" ]; then
    echo "skills/ is up to date ($CURRENT)"
  else
    echo "skills/ is behind: have $CURRENT, upstream is $LATEST"
    echo "Run ./scripts/sync-upstream.sh to update."
    exit 1
  fi
  exit 0
fi

echo "Cloning $UPSTREAM#$REF ..."
git clone --quiet --depth 1 --branch "$REF" "$UPSTREAM" "$TMP/upstream"
COMMIT="$(git -C "$TMP/upstream" rev-parse HEAD)"

rm -rf "$ROOT/skills"
mkdir -p "$ROOT/skills"
cp -r "$TMP/upstream/skills/." "$ROOT/skills/"
echo "$COMMIT" > "$ROOT/skills/.upstream-commit"

COUNT="$(find "$ROOT/skills" -name SKILL.md | wc -l)"
echo "Synced $COUNT skills from $COMMIT"
