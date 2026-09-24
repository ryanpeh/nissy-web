# nissy-web — browser (WebAssembly) port of Nissy

> **Status: Phase 2 working.** The upstream C compiles to WebAssembly with
> Emscripten (`poc/`) and `web/` is a browser page that runs `solve`
> (small-table steps and the **true-optimal `light` step**), `twophase`,
> `cleanup`, `unniss`, `invert`, `print` and `version` in a Web Worker,
> persisting generated tables in IndexedDB (cold ~40–60 s; warm <1 s). Not yet
> deployed. This folder is the living plan for a client-side version of Nissy
> hosted statically (GitHub Pages), with no backend.
>
> **Living document:** update this file (and `HANDOFF.md`) as decisions change.
> See the changelog at the bottom.

This is **not** the same thing as `../nissy-command-builder/` (the existing
static command builder, repo `nissy-thing`). That project only *emits* nissy
commands. `nissy-web` aims to actually *run* Nissy in the browser.

```
nissy/
├── nissy-2.0.8/            Upstream Nissy source (C). The thing we compile.
├── nissy-command-builder/  Existing static command-builder UI (its own git repo).
└── nissy-web/              THIS project: in-browser Nissy.
    ├── README.md           <- this file (overview + plan + hosting analysis)
    ├── HANDOFF.md          <- engineering handoff
    ├── poc/                <- Phase 0 proof of concept (Emscripten + pthread shim)
    └── web/                <- Phase 1 minimal browser page + IDBFS persistence
```

**Goal:** compile the C source to WebAssembly with Emscripten, run the existing
command interface against a virtual filesystem, serve precomputed pruning
tables as static assets, and expose a small HTML UI. Deploy to GitHub Pages.

**Non-goal (for now):** a backend/server; dynamic multi-user compute.

---

## 1. Why this is non-trivial

Nissy is portable C99 (good), but three things dominate the work.

### 1.1 Threads ↔ COOP/COEP
Nissy uses `pthreads` throughout (42 references; 33 `pthread_create/join/mutex`
calls across `src/solve.c` and `src/pruning.c`). The exact surface is tiny:
`pthread_t`, `pthread_mutex_t`, `pthread_create`, `pthread_join`,
`pthread_mutex_init/lock/unlock`. Emscripten's pthread support requires
`SharedArrayBuffer`, which requires the page to be **cross-origin isolated** via
the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers.
**GitHub Pages cannot set response headers.**
- Workaround A: a "coi-serviceworker" that injects the headers and reloads.
  Works in Chrome/Firefox; Safari is unreliable.
- Workaround B: compile single-threaded with a pthread shim (see `poc/`).
  Correct but slower; single-threaded table generation is impractical.

### 1.2 Table sizes
Computed from the coordinate sizes in `nissy-2.0.8/src/` (4-bit entries unless
noted; `pd_nxopt31_HTM` is 2-bit compact):

| Table | Entries | Size |
| --- | --- | --- |
| `pd_eofb_HTM` | 2,048 | ~1 KB |
| `pd_coud_HTM` | 2,187 | ~1 KB |
| `pd_htr_drud` | 29,400 | ~15 KB |
| `pd_cp_drud` | 40,320 | ~20 KB |
| `pd_cornershtr_HTM` | 918,540 | ~0.44 MB |
| `pd_htrfin_htr` | 1,327,104 | ~0.63 MB |
| `pd_drud_eofb` | 1,082,565 | ~0.5 MB |
| `pd_corners_HTM` | 88,179,840 | ~42 MB |
| `pd_drudfin_noE_sym16_drud` | 111,605,760 | ~53 MB |
| `pd_drud_sym16_HTM` | 140,908,410 | ~67 MB |
| **`pd_nxopt31_HTM`** (optimal) | 9,863,588,700 | **~2.30 GiB** |

Useful totals:
- **Two-phase** (`pd_drud_sym16_HTM` + `pd_drudfin_noE_sym16_drud`) ≈ **126 MB**
- **"light" optimal** (`pd_drud_sym16_HTM` + `pd_corners_HTM`) ≈ **114 MB**
- **Full optimal** ≈ **2.30 GiB** (+70 MB fallback)

Generation time (upstream): the optimal table takes ~1.5 h on 8 threads. It must
be shipped precomputed; generating it in a browser (especially single-threaded)
is not viable.

Beyond per-step pruning tables, Nissy builds **shared support files** on first
run. Measured sizes and native generation times:

| Support file | Size | Gen time (native) |
| --- | --- | --- |
| `invtables` | 322 MB | ~9 s |
| `symc_trans` | 202 MB | ~36 s |
| `symc_moves` | 44 MB | ~1 s |
| `mtables` | 20 MB | ~4 s |
| `ttables` | 15 MB | ~24 s |
| `sd_eofbepos_16_new` | 13 MB | ~1 s |
| `sd_cp_16_new` | 0.5 MB | <1 s |
| per-step `pt_*` (small steps) | KB–MB | <1 s |

Total support set ≈ **617 MB**. These dominate first-run cost, and several files
individually exceed the 100 MB git limit, so they **cannot be preloaded on GitHub
Pages**. Phase 1 persists them client-side in IndexedDB instead; a production
version could serve them as chunks from `raw`/object storage, or patch Nissy for
lazy init so unused symmetry tables are never built.

---

## 2. Hosting a full Nissy: analysis and alternatives

### 2.1 What "full Nissy" needs
"Full" means every command and all 53 steps, including the guaranteed-optimal
`optimal` step (which needs `pd_nxopt31_HTM`, ~2.30 GiB) and `light` (~114 MB).
The decisive constraints are therefore **table bytes** and **wasm memory**, not
the solver code (the wasm binary is only a few hundred KB).

### 2.2 Host options (measured against real endpoints)
`public` ≠ `CORS-enabled`. A browser page can only read a cross-origin response
if the server sends `Access-Control-Allow-Origin`. Probe results:

| Host | Big files? | Browser-readable? | Verdict |
| --- | --- | --- | --- |
| GitHub Pages | ≤100 MB/file (git), ~1 GB site (soft) | same-origin → CORS moot | Good for ≤1 GB |
| `raw.githubusercontent.com` | repo files only, ≤100 MB each | ✅ `access-control-allow-origin: *`, `accept-ranges: bytes` | Good for ≤100 MB files |
| GitHub Release assets | up to 2 GiB/asset | ❌ no ACAO; `OPTIONS` → 404 | Not fetchable in-page |
| Git LFS | 1 GB free storage/bandwidth | ❌ `raw` returns the ~130-byte pointer | Unusable |
| jsDelivr (GitHub CDN) | small file limit (~20–50 MB) | ✅ CORS | Too small |
| Cloudflare R2 / B2 / S3 | effectively unlimited | ✅ CORS + `Range` configurable | The realistic 2.3 GB host |
| IPFS gateways | large | ✅ but availability/CORS vary | Fragile, avoid |

Reproduce the two decisive probes:
```sh
curl -sIL -H "Origin: https://example.com" \
  https://raw.githubusercontent.com/ryanpeh/nissy-thing/main/index.html | rg -i 'access-control|accept-ranges'

curl -s -D - -o /dev/null -H "Origin: https://example.com" -r 0-0 -L \
  https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz \
  | rg -i 'HTTP/|access-control|accept-ranges'
```

### 2.3 Can we partition the big table into many files?
Partitioning the 2.30 GiB table into <100 MB chunks fixes:
- the 100 MB per-file git limit,
- the release-asset CORS problem (use `raw` on a non-Pages branch instead),
- the ~1 GB Pages site limit (keep chunks off the Pages branch).

Partitioning does **not** fix:
- **Memory.** Pruning-table lookups are random across the whole index space, so
  the entire table must be resident in wasm linear memory at once (network paging
  per query is not viable — IDA* does millions of lookups). wasm32 caps memory at
  **4 GiB**; 2.4 GiB in the heap plus runtime is at the edge and fails on small
  machines and all phones.
- **Download cost.** Each user still pulls ~2.3 GB before the first solve.
  IndexedDB/OPFS can cache it (quota permitting), but first load is GBs.

So partitioning is **necessary but not sufficient** for the full optimal table.

### 2.4 Alternatives considered
1. **Two-phase + light only (favored).** Ship ~114–126 MB, same-origin on Pages.
   A real in-browser solver, no giant tables. Loses guaranteed-optimal.
2. **Full optimal via object storage.** R2/B2/S3 with CORS + `Range`, chunked
   download, cached in IndexedDB/OPFS. Works around hosting, not memory. Heavy.
3. **Manual table hand-off.** User downloads a release asset; page reads it via
   the File System Access API. No CORS, but clunky and still 2.3 GB resident.
4. **CORS proxy.** Works but depends on public infra; effectively a backend.
5. **Port specific searches to JS** (precedent: DR-XS in
   `../nissy-command-builder/drxs.js` — 8.6 MB table, no wasm, instant). Great
   for narrow use cases; not a general solver.
6. **wasm64 (memory64).** Raises the address-space ceiling, but toolchain and
   browser support are immature and it does not reduce download size.
7. **Smaller/smarter tables.** Structure-aware compression or a weaker
   optimality guarantee (e.g. 2-phase) — the pragmatic way to shrink bytes.

### 2.5 Recommendation
Build for **two-phase first** (Phase 2), keep the Pages host, and defer full
optimal. If full optimal is ever required, put only `pd_nxopt31_HTM` on
CORS-enabled object storage and treat the ~2.4 GiB resident cost as a hard
requirement to design around.

---

## 3. Phased plan

- **Phase 0 — Proof of concept. ✅ DONE.** Emscripten 6.0.9 + single-thread
  pthread shim; `poc/build.sh` produces a ~123 KB wasm, and `node poc/run.js`
  runs `solve eofb "R U F"` and prints `F (1)`. Notes: Emscripten 6.x needs
  `-sMODULARIZE=1` and `-Wl,--allow-multiple-definition` (its `libc.a` now ships
  strong pthread stubs). Tables are regenerated in the in-memory FS each run
  (~60 s single-threaded) — Phase 1 must ship/preload them instead.
- **Phase 1 — Build pipeline + virtual FS. ✅ DONE.** `web/` builds a browser
  module (`web/build.sh`), runs the CLI in a Web Worker (`web/nissy-worker.js`),
  and mounts **IDBFS at `/tables`** so generated tables persist in IndexedDB.
  `web/index.html` + `web/app.js` provide a minimal UI for small-table steps
  (EO/CO/HTR/corners-to-HTR). Measured: cold ~47–52 s (generates ~589 MB), warm
  reload ~0.8 s. Key findings: Nissy's inverse tables are ~592 MB of static BSS,
  so the build needs `-sINITIAL_MEMORY=640MB`; and Emscripten sets `HOME`, so
  `web/nissy_env_override.c` forces `NISSYDATA=/` to pin `tabledir` to `/tables`.
- **Phase 2 — Two-phase + more commands + persistence hardening. ✅ DONE.** The
  UI now supports `solve` (small-table steps), `twophase`, `cleanup`, `unniss`,
  `invert`, `print` and `version`. `twophase` generates its two tables
  (`pt_drud_sym16_HTM` ~70 MB / `pt_drudfin_noE_sym16_drud` ~56 MB) on first use
  (~60 s), then caches them. Persistence now awaits `syncfs` before reporting
  done, and the UI gained a storage-usage readout, a "delete cached tables"
  action, an elapsed timer, and clearer first-run messaging. A web-only
  `web/nissy_state_shim.c` neuters `free_pd`/`free_sd` so repeated `callMain`
  calls in one instance don't use-after-free. Measured: cold small-step solve
  ~39 s, cold first `twophase` ~60 s, warm ~0.35–1.5 s. The two-phase tables were
  **not** shipped as assets (see §1.2 for why shipping doesn't remove the
  support-file cost). An additional **`light`** step is exposed: a *true
  optimal* solve using ~114 MB of tables (`pt_drud_sym16_HTM` + `pt_corners_HTM`),
  which fits where the 2.30 GiB fast-`optimal` table cannot. Warm solves are
  ~1 s (e.g. a 13-move scramble solved optimally in 12 moves).
- **Phase 3 — Full optimal / intermediate table (investigated, dead end).**
  `light` (true optimal, ~114 MB) is exposed. A prototype intermediate table
  (`lightplus/`, `cpud_separate × eofbepos_sym16`, 2.25 MB) gave **no meaningful
  speedup** (node counts within 0–3%). The smallest *useful* intermediate is
  ~650 MB, and the real path to fast optimal is memory64 + `pd_nxopt31_HTM`
  (2.30 GiB, external CORS storage). Details in **`INTERMEDIATE.md`**.
  Feasibility of that path was prototyped: memory64 works (Chrome 133+ /
  Firefox 134+; not Safari), a one-copy streaming loader is viable, but Chrome's
  wasm ceiling is ~3.6 GiB so the ~3.14 GiB peak is tight — see **`NXOPT31.md`**.
- **Phase 4 — Deploy.** A static Pages demo (own repo/branch, since this folder
  isn't under version control). Possibly a tab in `nissy-command-builder`.

---

## 4. Open questions

1. Single-thread shim vs coi-serviceworker threads for the first release?
2. Ship two-phase or start even smaller (EO/CO/DR) to validate the UX?
3. Where do large tables live long-term (GitHub repo vs object storage)?
4. Practical wasm memory limits in target browsers (desktop vs mobile)?
5. Can pruning tables be compressed enough to matter (structure-aware, not gzip)?
6. UI scope: which commands (`twophase`, `solve`, `scramble`, `cleanup`, …) and
   where the UI should live.

---

## 5. References

- `INTERMEDIATE.md` — investigation of an optimal table between `light` and
  `optimal`.
- `NXOPT31.md` — feasibility of running the full 2.30 GiB optimal table in the
  browser (memory64, memory budget, one-copy streaming).
- Upstream source: `../nissy-2.0.8/` (`doc/nissy.1`, `INSTALL`, `src/`).
- Existing command builder (repo `nissy-thing`): `../nissy-command-builder/`.
- DR-XS precedent for JS search + precomputed table:
  `../nissy-command-builder/drxs.js`,
  `../nissy-command-builder/tools/gen-distances.js`.
- Emscripten docs: https://emscripten.org/docs/
- COOP/COEP + `SharedArrayBuffer`: https://web.dev/articles/coop-coep
- coi-serviceworker: https://github.com/gzuidhof/coi-serviceworker

---

## 6. Changelog

- **2026-09-24** — **Hosted.** Published the project to `ryanpeh/nissy-web`
  (`main` = source; `tables` branch = the 2.97 GB chunk set) and pointed the app
  at `https://raw.githubusercontent.com/ryanpeh/nissy-web/tables/` (local
  fallback). Verified end-to-end from raw: `F' U' R' (3)`.
- **2026-09-24** — **Main app streams tables.** `web/` now builds the streaming
  fork, fetches `index.json`+manifests (`STREAM_INDEX`) and registers
  `nissyStreamTables`; added the `optimal` step. Verified: `optimal` -> `F' U' R'
  (3)` in ~9.6 s, and `eofb` -> `F (1)` in ~4.5 s (support files streamed, not
  generated). Hosting documented in `HOSTING.md`.
- **2026-09-24** — **Full `solve optimal` runs in the browser.** Extended the
  stream hook to all support files + the `pt_drud_sym16_HTM` fallback; verified
  in Chrome (wasm32, 4 GB): 10 tables, 3050 MB streamed, `F' U' R' (3)`, ~41 s.
  No memory64 needed. `dist-tables/` now holds 10 tables / 39 chunks (~2.97 GB).
- **2026-09-24** — **Real 2.30 GiB table verified in the browser.** The demo
  (`lightplus/web/`, cap raised to 4 GB) streamed all 25 chunks of
  `pt_nxopt31_HTM` (2351.7 MB) into wasm and read it correctly
  (`Total: 9863588700`) in headless Chrome. Full `solve optimal` still needs the
  support files streamed too (else it exceeds Chrome's ceiling).
- **2026-09-24** — **Generated the full optimal table.** `pt_nxopt31_HTM`
  (2.30 GiB) + support set generated natively (~1–1.5 h, 8 threads) and chunked
  into 25 × 96 MB pieces with manifests (`dist-tables/`). Patched
  `genptable()` to allocate the compact size on the load path (2.30 GiB instead
  of 4.93 GiB), making wasm32 feasible; verified the real table streams through
  the chunked loader and reads correctly. See `NXOPT31.md`.
- **2026-09-21** — Added a **browser demo** of the streaming loader
  (`lightplus/web/` + Range-capable `serve.js`); verified in Chrome streaming
  67.2 MB + 42.0 MB into the heap via `Range` requests.
- **2026-09-21** — Implemented the one-copy **streaming table loader** in the
  fork (`lightplus/src/pruning.c` + `streamlib.js`): tables are fetched in 8 MB
  chunks straight into `pd->ptable`. Verified with real 70 MB/44 MB tables under
  wasm32 and memory64. See `NXOPT31.md` §2.1.
- **2026-09-21** — Prototyped the memory64 path for full `nxopt31`
  (`NXOPT31.md`): memory64 builds/runs; 2.3 GiB allocation and one-copy
  streaming verified; Chrome ceiling ~3.6 GiB makes the ~3.14 GiB peak tight;
  Safari unsupported. Shim `pthread_t` made pointer-sized.
- **2026-09-21** — Prototyped `lightplus` (`lightplus/` fork): an intermediate
  `cpud_separate × eofbepos_sym16` bound. Measured **no speedup** (nodes within
  0–3%). Recorded in `INTERMEDIATE.md` §6–7.
- **2026-09-21** — Web UI: **Stop** button (terminate + warm restart), a
  **Result/Log** split (stdout vs stderr), collapsible help, copy buttons, and
  `localStorage` persistence. Added **`INTERMEDIATE.md`** (intermediate optimal
  table investigation).
- **2026-09-21** — Added the **`light`** step to the web UI: true optimal HTM
  solve with ~114 MB of tables (fits under the wasm32 4 GiB cap; the 2.30 GiB
  fast-`optimal` table does not). Cold first use adds ~44 MB (`pt_corners_HTM`);
  warm solves ~1 s.
- **2026-09-21** — Phase 2 **working**. Command selector (`solve`, `twophase`,
  `cleanup`, `unniss`, `invert`, `print`, `version`); persistence now awaits
  `syncfs`; storage readout + delete-cache; elapsed timer. Added
  `web/nissy_state_shim.c` to keep tables resident across `callMain` calls.
  Measured cold small-step ~39 s, cold `twophase` ~60 s, warm <1.5 s.
- **2026-09-21** — Phase 1 **working**. Added `web/`: browser build
  (`-sINITIAL_MEMORY=640MB`, `FORCE_FILESYSTEM`, IDBFS), a Web Worker engine, a
  minimal page, and a Node harness. Small-table steps run; tables persist in
  IndexedDB (cold ~47–52 s / ~589 MB, warm ~0.8 s). Support-file sizes and
  generation times measured and documented (§1.2).
- **2026-09-21** — Phase 0 POC **passing**. Emscripten 6.0.9 builds the source
  (~123 KB wasm) and `node poc/run.js` prints a `solve eofb` solution (`F (1)`).
  Findings recorded: MODULARIZE wrapper + `--allow-multiple-definition` needed on
  Emscripten 6.x; ~60 s single-threaded table regeneration per run.
- **2026-09-21** — Expanded hosting analysis (§2): measured host matrix,
  partitioning limits, memory/download/caching, alternatives, recommendation.
- **2026-09-21** — Initial plan captured: Emscripten feasibility, pthread
  constraint, table sizes, GitHub hosting/CORS findings, options and phases.
