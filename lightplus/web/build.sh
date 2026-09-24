#!/bin/sh
# Browser demo: Nissy fork with the one-copy streaming table loader.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."          # nissy-web/
mkdir -p "$HERE/out"
emcc -O2 -std=c99 -I "$ROOT/poc/shim" -I "$HERE/../src" -DVERSION='"2.0.8"' -DNISSY_WASM_STREAM \
  "$HERE"/../src/*.c "$ROOT/poc/shim_pthread.c" "$ROOT/web/nissy_env_override.c" "$ROOT/web/nissy_state_shim.c" \
  --js-library "$HERE/../src/streamlib.js" \
  -Wl,--allow-multiple-definition -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=640MB -sMAXIMUM_MEMORY=4GB \
  -sMODULARIZE=1 -sEXPORT_NAME=createNissy -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS \
  -sEXPORTED_FUNCTIONS=_main,_malloc,_free -sENVIRONMENT=web,worker \
  -o "$HERE/out/nissy.js"
echo "built $HERE/out/nissy.js"
