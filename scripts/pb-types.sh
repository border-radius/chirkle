#!/bin/sh
# Generate PocketBase's JSVM type definitions (for pb_hooks/ and pb_migrations/) into types/pocketbase.d.ts.
# PocketBase writes types.d.ts into its data dir on startup, so run the migrations against a throwaway one.
# No-op while the file is newer than the binary (i.e. until `npm run setup` builds it again).
set -eu
cd "$(dirname "$0")/.."

PB="bin/chirkle-server"
OUT="types/pocketbase.d.ts"

if [ ! -x "$PB" ]; then
  echo "error: $PB not found. Run \`npm run setup\` first." >&2
  exit 1
fi
if [ -f "$OUT" ] && [ "$OUT" -nt "$PB" ]; then
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$PB" migrate up --dir="$tmp" --hooksDir=pb_hooks --migrationsDir=pb_migrations >/dev/null
mkdir -p types
mv "$tmp/types.d.ts" "$OUT"
echo "generated $OUT"
