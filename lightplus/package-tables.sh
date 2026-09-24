#!/bin/sh
# Chunk generated optimal tables into <100 MB files + per-table manifests, and
# write an index for the browser loader.
#
# Usage: ./package-tables.sh [TABLES_DIR] [OUT_DIR] [CHUNK_MB]
#   TABLES_DIR default: ../tables   (where gen-nxopt31.sh wrote them)
#   OUT_DIR    default: ../dist-tables
#   CHUNK_MB   default: 96          (< GitHub's 100 MB/file limit)
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
TABLES="${1:-$HERE/../tables}"
OUT="${2:-$HERE/../dist-tables}"
CHUNK="${3:-96}"
mkdir -p "$OUT"

TABLES_LIST=""
for t in pt_nxopt31_HTM pt_corners_HTM pt_drud_sym16_HTM invtables mtables ttables symc_moves symc_trans sd_cp_16_new sd_eofbepos_16_new; do
	if [ -f "$TABLES/tables/$t" ]; then
		node "$HERE/chunk-table.js" "$TABLES/tables/$t" "$OUT" "$CHUNK"
		TABLES_LIST="$TABLES_LIST \"$t\","
	else
		echo "warning: missing $TABLES/tables/$t (run gen-nxopt31.sh first)" >&2
	fi
done

# index.json: what the browser loader fetches to discover the tables
printf '{ "chunkBase": "", "tables": [%s ] }\n' "${TABLES_LIST%,}" > "$OUT/index.json"
echo "--- $OUT ---"
ls -1 "$OUT" | sed -n '1,6p'; echo "..."
echo
echo "Next: upload $OUT to CORS+Range storage (raw branch or R2/S3), then set"
echo "      chunkBase in index.json to the public URL prefix and load the"
echo "      manifests in the browser (see ../NXOPT31.md §4)."
