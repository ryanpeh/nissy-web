#!/bin/sh
# Build the Nissy wasm POC with a single-threaded pthread shim.
# Requires: emcc (Emscripten) on PATH.
#
#   ./build.sh
#
# Output: poc/out/nissy.js (+ nissy.wasm)
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
NISSY="$HERE/../../nissy-2.0.8"
OUT="$HERE/out"

if ! command -v emcc >/dev/null 2>&1; then
	echo "error: emcc not found on PATH; install Emscripten first" >&2
	echo "  brew install emscripten    # or use emsdk" >&2
	exit 1
fi

if [ ! -d "$NISSY/src" ]; then
	echo "error: nissy source not found at $NISSY/src" >&2
	exit 1
fi

mkdir -p "$OUT"

emcc -O2 -std=c99 \
	-I "$HERE/shim" -I "$NISSY/src" \
	-DVERSION='"2.0.8"' \
	"$NISSY"/src/*.c "$HERE/shim_pthread.c" \
	-Wl,--allow-multiple-definition \
	-sMODULARIZE=1 \
	-sEXPORT_NAME=Module \
	-sALLOW_MEMORY_GROWTH=1 \
	-sSTACK_SIZE=4MB \
	-sINVOKE_RUN=0 \
	-sEXIT_RUNTIME=0 \
	-sEXPORTED_RUNTIME_METHODS=callMain \
	-sEXPORTED_FUNCTIONS=_main,_malloc,_free \
	-o "$OUT/nissy.js"

echo "built $OUT/nissy.js"
