# nissy-web

Run the [Nissy](https://nissy.tronto.net) Rubik's Cube solver **entirely in the
browser** via WebAssembly — no backend, no install. Nissy's C source is compiled
with Emscripten, and its large pruning tables are streamed on demand.

- **App:** `…/nissy-web/web/` (see *Deploy* for the public URL)
- **Source:** this repo's `main` branch
- **Tables:** the `tables` branch, served by `raw.githubusercontent.com` (CORS + Range)

## Features

- Runs Nissy's CLI in a Web Worker: `solve` (small-table steps, `light`, and the
  full `optimal`), `twophase`, `cleanup`, `unniss`, `invert`, `print`, `version`.
- UI: command selector + step dropdown, full-width scramble, **Result / Log**
  split (stdout vs stderr), progress bar, **Stop**, copy buttons, and
  `localStorage` persistence.
- **True optimal solve** by streaming the 2.30 GiB `pd_nxopt31_HTM` table (plus
  its support files) straight into the wasm heap — one copy, via HTTP `Range`.

## How it works

- **Emscripten + a single-threaded pthread shim** (`poc/shim`). Real pthreads
  need `SharedArrayBuffer`, which needs COOP/COEP headers that static hosting
  can't set; the shim runs threads sequentially instead.
- **One-copy streaming loader** (`lightplus/src/streamlib.js`, with hooks in the
  C readers): fetches 8 MB pieces directly into `pd->ptable` and the support
  arrays; the whole table is never held in JS memory. Works in Node and browser.
- **IDBFS** persists the small generated tables in IndexedDB.
- A patch in `lightplus/src/pruning.c` allocates the compact size on the load
  path (2.30 GiB instead of 4.93 GiB), so the wasm32 4 GiB cap is enough.

## Layout

```
poc/       Phase 0 proof of concept (Emscripten build + pthread shim)
web/       the app: build.sh, index.html, app.js, nissy-worker.js, out/ (built)
lightplus/ the streaming fork + tooling
  src/     Nissy C source with streaming hooks + lightplus.c
  gen-nxopt31.sh      generate the optimal tables natively
  package-tables.sh   split tables into <100 MB chunks + manifests
  chunk-table.js      the chunker
  set-chunkbase.sh    set the public URL prefix
  web/                a small standalone streaming demo
NXOPT31.md, INTERMEDIATE.md, HOSTING.md   design notes
```

## Build & run locally

Requires Emscripten (`brew install emscripten`).

```sh
cd web && ./build.sh          # -> web/out/nissy.js + nissy.wasm
cd .. && python3 -m http.server 8080   # serve the repo root (so /dist-tables/ works)
# open http://localhost:8080/web/
```

It must be served over http(s) — Web Workers and `fetch` don't work from
`file://`. (`lightplus/web/serve.js` is a Range-capable server, needed if you
want to stream from a local `/dist-tables/`.)

## Tables

The app needs pruning tables. There is a **Tables** selector:

- **Generate locally (default):** tables are generated in-browser and cached
  in IndexedDB (support set ~40 s, then `light` tables ~1-2 min, one time).
  Only the optimal table is streamed, since it can't be generated in wasm.
- **Download precomputed:** stream all precomputed chunks (faster on a fast
  connection, but uses data) and cache them in OPFS.

Details:

- **Streamed:** the worker fetches
  `https://raw.githubusercontent.com/ryanpeh/nissy-web/tables/index.json` plus
  per-table manifests, then streams chunks. It falls back to a same-origin
  `/dist-tables/` if the hosted copy is unreachable.
- **Generated in-browser:** if no stream source is found, Nissy generates what it
  needs into IndexedDB (slow on first run).
- **`light`** is a true-optimal solve that needs only ~114 MB, so it is useful on
  its own if you don't want the 3 GB download.

Rebuild/host the tables with `lightplus/gen-nxopt31.sh` → `package-tables.sh`;
see `HOSTING.md`.

## Deploy (GitHub Pages)

1. Rebuild the wasm and commit `web/out/` if needed (it's small and tracked).
2. Repo → Settings → Pages → *Deploy from a branch* → `main` / `(root)`.
3. The root `index.html` redirects to `web/`.

The tables live on the `tables` branch served by `raw`, so the Pages 1 GB site
limit doesn't apply.

## Limitations

- First load downloads ~3 GB once; chunks are cached in **OPFS** and reused on later visits (only the small generated tables go in IndexedDB). The **Delete cached tables** button clears both.
- Download progress is shown while a streamed table is fetched.
- Desktop Chromium/Firefox only (Chrome's wasm memory ceiling is ~3.6 GB); not
  Safari or mobile.
- Single-threaded (deliberate, for header-less static hosting).

## Docs

- `NXOPT31.md` — running the full optimal table in the browser (memory budget,
  one-copy streaming, memory64).
- `INTERMEDIATE.md` — searching for an optimal table between `light` and `optimal`.
- `HOSTING.md` — hosting the table chunks (raw branch / object storage).

## Credits

Nissy is by Sebastiano Tronto and is licensed under the GPLv3. This project is a
browser port plus the tooling to generate, chunk and stream its tables.
