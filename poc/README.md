# Phase 0 POC — Nissy in WebAssembly

Goal: prove that the upstream C source compiles to wasm with Emscripten and can
execute a real command, before investing in table shipping and UI.

The POC deliberately avoids Emscripten pthreads (which need COOP/COEP headers
GitHub Pages can't set). `shim/pthread.h` + `shim_pthread.c` replace pthreads
with sequential, no-op-locking equivalents.

## Requirements

- Emscripten (`emcc`) on `PATH` — `brew install emscripten` or emsdk.
- Node.js to run the harness.

## Build

```sh
cd poc
./build.sh          # -> out/nissy.js + out/nissy.wasm
```

## Run

```sh
node run.js                                  # default: solve eofb "R U F"
node run.js solve eofb "R U F"
node run.js twophase "R' U' F D2 L2"         # needs bigger tables; slow first run
```

Expected: the `eofb` step uses `pd_eofb_HTM` (2,048 entries, ~1 KB), generated
in-memory on first use, and prints one or more EO solutions.

## Files

| File | Purpose |
| --- | --- |
| `shim/pthread.h` | Single-threaded pthread type/function declarations. |
| `shim_pthread.c` | Sequential pthread implementation (create runs inline). |
| `build.sh` | Emscripten build script. |
| `run.js` | Node harness; captures stdout/stderr and calls `callMain`. |
| `out/` | Build artifacts (not source; safe to delete). |

## What this proves / doesn't prove

- **Proves:** the toolchain works; the CLI runs under wasm; small tables can be
  generated in the virtual FS; output can be captured from JS.
- **Does not prove:** threading performance, large-table loading, browser worker
  integration, or the final UI. Those are Phases 1–4 (see `../README.md`).
