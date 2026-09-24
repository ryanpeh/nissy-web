# Feasibility — running the full optimal (`nxopt31`) in the browser

**Question:** can we add the 2.30 GiB `pd_nxopt31_HTM` table so the browser can
do the *fast* optimal solve? This documents the step-1/step-2 prototype
(browser support + memory64 build + one-copy table streaming).

**Verdict:** technically viable on **desktop Chrome (tight) and Firefox
(comfortable)**, not on Safari or mobile. It requires a memory64 fork, a
one-copy streaming loader, and chunked hosting — not just "add the file".

---

## 1. Browser memory64 support

| Browser | memory64 | Notes |
| --- | --- | --- |
| Chrome | ✅ 133+ | installed here: 153 |
| Firefox | ✅ 134+ | up to ~8 GiB |
| Safari / iOS | ❌ | "in development"; no support |

memory64 lifts the wasm32 4 GiB address-space cap. **But Chrome's practical
ceiling is lower than 4 GiB** — measured on Chrome 153 (allocating + touching):

| requested | result |
| --- | --- |
| 3600 MB | OK |
| 3900 MB | FAIL |

So Chrome allows roughly **3.6 GiB** of wasm memory. (Node 26 allowed 6 GiB.)

## 2. Prototype results

1. **Real nissy builds with memory64.** `emcc -sMEMORY64=1` on the fork
   (`lightplus/src` + the web shims) compiles and runs: `solve light` returned
   the optimal `R B2 D' L' F U2 R' (7)`. One shim fix was needed: `pthread_t`
   must be **pointer-sized** (`unsigned long`) so it matches Emscripten's libc
   stubs in both wasm32 and wasm64 (`poc/shim/pthread.h`, harmless for wasm32).
2. **~2.3 GiB allocation works.** Node and Chrome both allocated and touched
   2.3 GiB (Chrome up to ~3.6 GiB, above).
3. **One-copy streaming works.** JavaScript wrote **2300 MB directly into the
   wasm heap** in 8 MB chunks (simulating fetched chunks) and C verified the
   checksum (`verify=58368 expected=58368 OK`). This is the key mechanism to
   avoid the double copy. Note: memory64 pointers are exposed to JS as Numbers
   for `malloc`, but i64 parameters must be passed as `BigInt`.

### 2.1 Streaming loader integrated into the fork

Implemented in `lightplus/`:

- `src/pruning.c` — `read_ptable_file()` (compiled with `-DNISSY_WASM_STREAM`)
  first asks `nissy_stream_enabled(name)`; if a source is registered it parses
  the 132-byte header (base + 16 counts) and streams the table bytes **directly
  into `pd->ptable`** via `nissy_stream_read(name, buf, offset, len)`, skipping
  the filesystem entirely.
- `src/streamlib.js` — Emscripten JS library implementing those hooks. It
  fetches in 8 MB chunks and writes each chunk straight into `HEAPU8` (one
  copy). Node uses `fs.readSync`; the browser uses synchronous `Range` requests
  (must run in a Web Worker; `raw.githubusercontent.com` and GitHub Pages both
  support `Range`). memory64 pointers are coerced with `Number(...)`.

Verified with real tables: `pt_drud_sym16_HTM` (70 MB) and `pt_corners_HTM`
(44 MB) streamed in 8 MB chunks and `solve light "R U2 F' L D B2 R'"` returned
the optimal `R B2 D' L' F U2 R' (7)` — in **both** wasm32 and memory64 builds.
So the loader is ready for the real 2.30 GiB table; only generation + hosting
remain (steps 3–5 in §4).

A **browser demo** of the loader lives in `lightplus/web/` (build + a
Range-capable `serve.js`). It streams the real `dist-tables/` chunks via
`Range` requests straight into the wasm heap.

**Verified in headless Chrome (wasm32, `MAXIMUM_MEMORY=4GB`):** the full
`pt_nxopt31_HTM` (2351.7 MB, all 25 chunks) streamed into the heap and the
`ptable` distribution read correctly (`Total: 9863588700`) — in ~5 s over
localhost. So the 2.30 GiB table now loads in-browser.

**Full `solve optimal` in the browser — DONE.** The stream hook now also covers
the support files (`invtables`, `mtables`, `ttables`, `symc_moves`,
`symc_trans`, `sd_cp_16_new`, `sd_eofbepos_16_new`) **and** the nxopt31 fallback
`pt_drud_sym16_HTM` (needed whenever `pd_nxopt31_HTM`'s compact value falls
below its base — including at distance 0, so it is always required).

Verified in headless Chrome (wasm32, `MAXIMUM_MEMORY=4GB`): 10 tables,
**3050 MB streamed**, then an actual optimal solve — `F' U' R' (3)` — in ~41 s
(streaming-bound over localhost). **No memory64 needed.**

Note: the support files are only *read* (never written) when streamed, so they
cost just their static arrays (~0.6 GiB), not the ~0.6 GiB extra filesystem
copy that in-browser generation would add. This is what brings the peak down to
~3.0 GiB.

## 3. Memory budget

**Important correction.** `genptable()` used to allocate `ptablesize * 2` for
compact tables *even when only loading from file* — i.e. `nxopt31` reserved
**4.93 GiB**, not 2.30 GiB. That alone blew the wasm32 cap. The fork patches it
to allocate the compact size first and grow to the uncompressed size only if it
must actually generate:

```c
sz = ptablesize(pd);                 /* 2.30 GiB for nxopt31 */
pd->ptable = malloc(sz * ...);
if (read_ptable_file(pd)) { pd->generated = true; return; }
if (pd->compact) { sz = ptablesize(pd) * 2; pd->ptable = realloc(...); }
```

With that patch, the **load path** (the only one the browser uses) is:

| | single copy (streamed) | double copy (IDBFS) |
| --- | ---: | ---: |
| `pd_nxopt31_HTM` array | 2.30 GiB | 2.30 (FS) + 2.30 (array) |
| static `.bss` (inverse tables) | 0.58 GiB | 0.58 GiB |
| `pd_corners_HTM` + fallback | 0.11 GiB | 0.11 GiB |
| heap / runtime | ~0.15 GiB | ~0.15 GiB |
| **peak** | **~3.0 GiB** | **~5.44 GiB** |
| vs Chrome's ~3.6 GiB | fits (tight) | **fails** |

So one-copy streaming is mandatory, but with the patch it now fits wasm32 —
**verified**: the real 2.30 GB table was streamed through the 25 chunks and read
correctly (`Total: 9863588700`) in a wasm32 build (RSS 1.48 GB, since macOS
compresses the table's highly-repetitive pages).

## 4. What "adding nxopt31" actually requires

1. **memory64 build** of the fork (works; pin the toolchain).
2. **One-copy loader**: patch `read_ptable_file` (or `genptable`) so the big
   table is fetched in chunks and written directly into `pd->ptable`, skipping
   the FS copy. Mechanism proven in §2.
3. **Precompute the table once** natively (~1.5 h on 8 threads, needs ~5 GB RAM).
4. **Chunk it** into <100 MB files + manifests.
5. **Host** the chunks on CORS+Range storage (`raw` branch or R2/S3), then load
   them in the browser.

### Runbook (scripts in `lightplus/`)

```sh
cd nissy-web/lightplus

# 1. Generate (one time; ~1-1.5 h, ~5 GB RAM, ~2.9 GB disk).
#    Support files (~590 MB) are generated first, then pt_nxopt31_HTM.
./gen-nxopt31.sh ../tables 8            # logs depth lines to stderr

# 2. Chunk into 96 MB pieces + per-table manifests + index.json.
./package-tables.sh ../tables ../dist-tables 96
#    -> dist-tables/pt_nxopt31_HTM.{000..024} (~2.3 GB) + .manifest.json
#       dist-tables/pt_corners_HTM.{000} + .manifest.json
#       dist-tables/index.json

# 3. Upload dist-tables/ to a CORS+Range host, e.g. a `tables` branch served by
#    raw.githubusercontent.com, or an R2/S3 bucket. Set "chunkBase" in index.json
#    to the public URL prefix.

# 4. Load in the browser: fetch index.json + each manifest, prefix chunk URLs
#    with chunkBase, set Module.nissyStreamTables, then instantiate.
```

The chunked loader is implemented and verified: `lightplus/src/streamlib.js`
supports `Module.nissyStreamTables[name] = { size, chunkSize, chunks:[url,…] }`
and fetches across chunk boundaries (Node and browser). The demo
(`lightplus/web/`) already streams both tables from per-table manifests.

## 5. Risks / caveats

- **Tight on Chrome**: ~0.4 GiB headroom over the ~3.14 GiB peak; an 8 GB
  machine may still fail. Firefox is comfortable (8 GiB memory64).
- **Safari and all mobile**: not supported (no memory64; wasm32 cap too low).
- **First load**: multi-minute 2.3 GB download; then cached.
- **Solve time**: single-threaded wasm optimal is slow (nxopt31's strong bound
  helps, but no pthreads on Pages).
- `light` already gives **true-optimal** results at 114 MB; nxopt31 only buys
  speed.

## 6. Recommendation

Treat this as an optional desktop-Chromium/Firefox "pro" mode, behind a clear
warning, only if the speed of the *fast* optimal solver is worth a 2.3 GB
download. Otherwise `light` remains the browser default.
