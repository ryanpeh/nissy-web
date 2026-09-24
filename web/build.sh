#!/bin/sh
# Phase 1/2 browser build of Nissy (WebAssembly + Emscripten).
#
# Reuses the single-threaded pthread shim from ../poc (Emscripten real pthreads
# need SharedArrayBuffer / COOP+COEP, which static hosting cannot provide).
#
#   ./build.sh
#
# Output: web/out/nissy.js + web/out/nissy.wasm
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
NISSY="$HERE/../lightplus"   # fork: adds streaming hooks + lightplus step
POC="$HERE/../poc"
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

if [ ! -f "$POC/shim_pthread.c" ]; then
	echo "error: poc pthread shim not found at $POC" >&2
	exit 1
fi

mkdir -p "$OUT"

# Build the argument list once so it can be both printed and executed, with
# quoting preserved (POSIX sh has no arrays; "$@" does the job).
set -- \
	-O2 -std=c99 \
	-I "$POC/shim" -I "$NISSY/src" \
	-DVERSION='"2.0.8"' -DNISSY_WASM_STREAM \
	"$HERE/nissy_state_shim.c" "$POC/shim_pthread.c" "$NISSY"/src/*.c \
	"$HERE/nissy_env_override.c" \
	--js-library "$NISSY/src/streamlib.js" \
	-Wl,--allow-multiple-definition \
	-sMODULARIZE=1 \
	-sEXPORT_NAME=createNissy \
	-sALLOW_MEMORY_GROWTH=1 \
	-sINITIAL_MEMORY=640MB \
	-sMAXIMUM_MEMORY=4GB \
	-sSTACK_SIZE=4MB \
	-sINVOKE_RUN=0 \
	-sEXIT_RUNTIME=0 \
	-sFORCE_FILESYSTEM=1 \
	-lidbfs.js \
	-lnodefs.js \
	-sEXPORTED_RUNTIME_METHODS=callMain,FS \
	-sEXPORTED_FUNCTIONS=_main,_malloc,_free \
	-o "$OUT/nissy.js"

echo "== emcc version =="
emcc --version
echo
echo "== emcc flags =="
printf '  %s\n' "$@"
echo

emcc "$@"

echo
echo "built $OUT/nissy.js"
ls -l "$OUT/nissy.js" "$OUT/nissy.wasm"
