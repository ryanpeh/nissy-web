#!/bin/sh
# Generate the full optimal pruning tables (pd_nxopt31_HTM ~2.3 GiB + pd_corners_HTM)
# plus the shared support files, into a target directory.
#
# Usage:  ./gen-nxopt31.sh [TABLES_DIR] [THREADS]
#   TABLES_DIR default: ../tables
#   THREADS    default: number of CPUs
#
# One-time cost: ~1-1.5 h on 8 threads, ~5 GB RAM, ~2.9 GB disk.
# Progress goes to stderr (depth lines); it is safe to re-run (it resumes by
# reloading whatever is already on disk).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
TABLES="${1:-$HERE/../tables}"
THREADS="${2:-$(sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
mkdir -p "$TABLES/tables"
export NISSYDATA="$TABLES"
cd "$HERE"
if [ -f "$TABLES/tables/pt_nxopt31_HTM" ]; then
	echo "already generated: $TABLES/tables/pt_nxopt31_HTM"
	exit 0
fi
echo "Generating optimal tables into $TABLES/tables with $THREADS threads"
echo "  (support files ~590 MB first, then pt_nxopt31_HTM; this takes a while)"
./nissy solve optimal -t "$THREADS" "R U F"
ls -la "$TABLES/tables/pt_nxopt31_HTM" "$TABLES/tables/pt_corners_HTM"
