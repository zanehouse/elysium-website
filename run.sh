#!/usr/bin/env bash
set -euo pipefail

# ── Install dependencies ───────────────────────────────────────────────────────
echo "Installing dependencies…"
npm install

# ── Ensure directories exist ──────────────────────────────────────────────────
mkdir -p cache/fonts output posts

# ── Find all markdown files in /posts ────────────────────────────────────────
shopt -s nullglob
files=(posts/*.md)

if [ ${#files[@]} -eq 0 ]; then
  echo "No .md files found in posts/ — nothing to build."
  exit 0
fi

echo "Building ${#files[@]} report(s) in parallel…"

# ── Launch builds in parallel ─────────────────────────────────────────────────
pids=()
for f in "${files[@]}"; do
  node build.js "$f" &
  pids+=($!)
done

# ── Wait for all and collect exit codes ───────────────────────────────────────
failed=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    failed=$((failed + 1))
  fi
done

if [ "$failed" -gt 0 ]; then
  echo ""
  echo "⚠  $failed build(s) failed — check output above."
  exit 1
fi

echo ""
echo "✓  All PDFs written to ./output/"

# ── Regenerate research index ──────────────────────────────────────────────────
echo ""
echo "Rebuilding research index…"
node build-index.js
echo "✓  research/index.html updated"
