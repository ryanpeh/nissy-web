#!/bin/sh
# Point dist-tables/index.json at the public URL prefix where the chunks live.
#   ./set-chunkbase.sh https://cdn.example.com/nxopt31/
#   ./set-chunkbase.sh https://raw.githubusercontent.com/<user>/<repo>/tables/
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="${1:-$HERE/../dist-tables}"
BASE="$2"
[ -f "$DIST/index.json" ] || { echo "missing $DIST/index.json" >&2; exit 1; }
[ -n "${BASE:-}" ] || { echo "usage: $0 <chunkBase-url-or-path>" >&2; exit 1; }
node -e '
const fs=require("fs"); const f=process.argv[1]; const b=process.argv[2];
const j=JSON.parse(fs.readFileSync(f,"utf8")); j.chunkBase=b;
fs.writeFileSync(f, JSON.stringify(j,null,2)+"\n");
' "$DIST/index.json" "$BASE"
echo "chunkBase = $BASE"
cat "$DIST/index.json"
