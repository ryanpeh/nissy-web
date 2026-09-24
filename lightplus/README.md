# lightplus — prototype of an intermediate optimal bound

Experimental fork of Nissy 2.0.8 used to test whether a cheap pruning table
between `light` (114 MB) and `optimal` (2.3 GB) speeds up the optimal HTM
search. **Result: no meaningful speedup.** See `../INTERMEDIATE.md` §7.

## What it adds

A new HTM-moveset coordinate and pruning table:

```
coord_cpsep_eofbepos = cpud_separate(70) x eofbepos_sym16(64430)
                     = 4,510,100 entries   (~2.25 MB at 4 bits)
```

and a new step `lightplus` whose estimator is `light`'s estimator plus a
`ptableval(pd_cpsep_eofbepos_HTM, cube)` term. All tables use `moveset_HTM`,
so the values are admissible lower bounds for HTM.

## Files changed vs upstream

- `src/lightplus.c` — new: coordinate, pruning table, estimator, `lightplus_HTM`
  step.
- `src/symcoord.c` — removed `static` from `move_eofbepos_16`,
  `ttrep_move_eofbepos_16`, `sd_eofbepos_16` so `lightplus.c` can use them.
- `src/steps.c` — declares and registers `lightplus_HTM`.
- `src/solve.c` — added an IDA* node counter printed as `[nodes] N` on stderr
  (for benchmarking only).

Everything else is upstream, untouched. `../nissy-2.0.8/` is not modified.

## Build / run

```sh
make                       # produces ./nissy
export NISSYDATA=/path/with/tables     # a dir containing a `tables` subdir
./nissy solve lightplus -t 1 "R U2 F' L D B2 R'"
```

The first run generates `pt_cpsep_eofbepos_HTM` (~2.25 MB, a few seconds).

## Streaming table loader (for the full optimal table)

This fork also prototypes loading pruning tables from JavaScript instead of the
filesystem, to enable the 2.30 GiB `nxopt31` table without the IDBFS double copy
(see `../NXOPT31.md`).

- Build with `-DNISSY_WASM_STREAM` and `--js-library src/streamlib.js`.
- `read_ptable_file()` then routes through `nissy_stream_enabled()` /
  `nissy_stream_read()` (defined in `streamlib.js`), which streams the table
  bytes straight into `pd->ptable` in 8 MB chunks (one copy).
- Node: set `Module.nissyStreamBase` to a directory of table files.
- Browser: set `Module.nissyStreamURLs = { "pt_xxx": "https://…/pt_xxx" }`; the
  hook uses synchronous `Range` requests, so it must run in a Web Worker.

Tested: `pt_drud_sym16_HTM` (70 MB) + `pt_corners_HTM` (44 MB) streamed and
`solve light` returned the optimal 7-move solution, in wasm32 and memory64.

## Browser demo (`web/`)

Streams real pruning tables in Chrome via synchronous `Range` requests.

```sh
cd web && ./build.sh
node serve.js     # Range-capable static server on :8792 (serves the nissy-web root)
# open http://localhost:8792/lightplus/web/
```

Click a button to stream `pt_drud_sym16_HTM` (70 MB) or `pt_corners_HTM` (44 MB).
The page shows each 8 MB chunk arriving and then the table distribution — from
the `ptable` command, which loads a pruning table *without* generating the ~590 MB
support set, so the demo is quick.

Verified in headless Chrome: **67.2 MB** and **42.0 MB** streamed into the wasm
heap (one copy) and the tables were read correctly (`Total: 140908410`).
The server must support `Range` (Python's `http.server` does not; `serve.js` does,
and so do GitHub Pages / `raw.githubusercontent.com`).

## Notes

- The coupled coordinate must be stored in the **canonical (representative)
  frame** via `transtorep`, exactly like `index_drud_sym16`. Skipping that made
  the bound inadmissible (returned 12-move solutions for a 7-move optimum).
- The node counter is a benchmark aid; it is not in upstream.
- memory64 gotcha: Emscripten passes pointers as `Number` from `malloc` but i64
  parameters as `BigInt`; the JS library coerces with `Number(...)`.
