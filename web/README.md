# Nissy Web (Phase 2) — browser build, persistent tables, cache management

Runs the upstream Nissy 2.0.8 C solver in WebAssembly inside a Web Worker and
**persists the generated tables in IndexedDB** (via Emscripten's IDBFS) so the
expensive first-run table generation only has to happen once.

Phase 2 adds: correct persistence (a run is not reported complete until the
IndexedDB save finishes), IndexedDB cache management in the UI, the full command
set including the **two-phase solver** (`twophase`), and a live elapsed timer.

This builds on the Phase 0 POC in `../poc/` (same single-threaded pthread shim).

> **Scope:** all the CLI commands exposed by the UI — `solve` (any step;
> small-table steps, the large-table `htr`/`chtr` steps, and the true-optimal
> **`light`** step), `twophase`, `cleanup`, `unniss`, `invert`, `print`,
> `version`, and a free-text override.
>
> The **fast** `optimal` step needs the ~2.30 GiB `pd_nxopt31_HTM` table and
> does not fit in the wasm32 4 GiB address space, so it is not exposed. Use
> **`light`** for a guaranteed-optimal solve with ~114 MB of tables (slower than
> `optimal` would be, but it fits).

---

## Build

Requires Emscripten (`emcc` on `PATH`) and the upstream source at
`../../nissy-2.0.8/src` (unmodified).

```sh
cd nissy-web/web
./build.sh
```

Output: `out/nissy.js` (~76 KB) + `out/nissy.wasm` (~123 KB). `build.sh` prints
the Emscripten version and the full flag list before compiling.

The build reuses the POC pthread shim (`-I ../poc/shim`, `../poc/shim_pthread.c`)
and adds:

- `-sFORCE_FILESYSTEM=1 -lidbfs.js -lnodefs.js` so IDBFS (browser) and NODEFS
  (Node) are linked,
- `-sEXPORTED_RUNTIME_METHODS=callMain,FS`,
- `-sINITIAL_MEMORY=640MB -sMAXIMUM_MEMORY=4GB` — Nissy's inverse tables are
  statically allocated (`src/cube.c`) and total ~592 MB of `.bss`, so the wasm
  needs a large initial memory even though the binary itself is ~123 KB,
- `nissy_env_override.c` (see *Table directory* below),
- `nissy_state_shim.c` (see *Repeated commands* below).

## Serve

Static hosting only; no backend and no special headers.

```sh
cd nissy-web/web
python3 -m http.server 8770
# open http://127.0.0.1:8770/index.html
```

A server is required (Web Workers / `fetch` do not work from `file://`).

## Commands

| UI command | argv built | Notes |
| --- | --- | --- |
| `solve` | `solve STEP SCRAMBLE` | Needs the step dropdown. Small tables first. |
| `twophase` | `twophase SCRAMBLE` | First use also generates ~126 MB of pruning tables. |
| `cleanup` | `cleanup SCRAMBLE` | Rewrites a scramble using only HTM. No tables. |
| `unniss` | `unniss SCRAMBLE` | Removes NISS from a scramble. No tables. |
| `invert` | `invert SCRAMBLE` | Instant, no tables. |
| `print` | `print SCRAMBLE` | Prints a cube diagram. |
| `version` | `version` | Prints the Nissy version. |
| *other command* | tokenized verbatim | Overrides the selector; e.g. `solve htr -n 3 "R U F"`. |

The scramble is passed as a **single argv token**. Nissy's `read_scramble`
concatenates argv tokens and then parses the moves, so this preserves the
scramble's internal spacing/quoting and avoids shell-style quoting bugs.

## UI

- Command selector + step dropdown on one row; the **scramble** is its own
  full-width, 3-row monospace textarea with a **Copy** button.
- Free-text **Other command** override; a collapsible **Help / notes** panel.
- Live **elapsed timer**; all inputs are locked while running/saving.
- **Stop** button: Nissy runs a command synchronously with no cancel hook, so
  Stop terminates the worker and immediately restarts it. Saved tables survive in
  IndexedDB and the restart is warm; any *unsaved* in-progress generation is
  lost. Stop is disabled during the IndexedDB save phase to avoid a partial
  write.
- **Result vs Log.** stdout (the answer — a solution, the cube diagram, the
  version) goes to a prominent **Result** panel; stderr (startup warnings,
  generation progress, `Searching depth N`, errors) goes to a collapsed
  **Log / details** panel. If a run produces no stdout the log auto-opens and the
  result shows "(no output — see the Log below)". The Result panel has a
  **Copy** button and scrolls (min 4 rem, max 45 vh).
- The last command/step/scramble/custom values are stored in `localStorage`
  (`nissyweb:ui`) and restored on reload.
- **Progress bar.** The engine strips are parsed as they stream:
  - `Cannot load X, generating it` → "Generating X…" (indeterminate)
  - `Found N classes` → "Found N symmetry classes…" (indeterminate)
  - `Depth d done, generated … (a/b)` → a real percentage for the pruning-table
    BFS (`a/b`)
  - `Pruning table generated!` / `Searching depth N`

  Only the pruning-table BFS reports an exact count, so the support-file
  generation and the final solve show an animated indeterminate bar plus the
  elapsed timer. On a hard scramble the `light` optimal search can run for a
  long time before finding the optimum; the bar stays indeterminate for that
  phase (pass `-v` in the "other command" box to get `Searching depth N` lines).

## First-run behaviour and persistence

The table directory used by Nissy is mounted as IDBFS at **`/tables`**:

- On start the worker calls `FS.syncfs(true, …)` to load `/tables` from
  IndexedDB. If `invtables` is absent it is a cold run.
- A cold run generates the support set (~589 MB: `invtables`, `symc_trans`,
  `symc_moves`, `mtables`, `ttables`, `sd_cp_16_new`, `sd_eofbepos_16_new`, plus
  the tiny pruning tables). The UI warns that this can take minutes and that
  only the first run is slow.
- When the command finishes the worker posts a `saving` status, then calls
  `FS.syncfs(false, …)` and **only posts `done` from inside the sync callback**.
  Sync errors are surfaced as `save-error`. The Run button stays locked until
  `done` arrives, so reloading or closing the tab immediately after a run cannot
  silently lose the freshly generated tables.
- `twophase` additionally generates `pt_drud_sym16_HTM` (~70 MB) and
  `pt_drudfin_noE_sym16_drud` (~56 MB) on first use — a few more minutes,
  single-threaded — and persists them too.
- `solve light` additionally generates `pt_corners_HTM` (~44 MB) the first time;
  the other table it needs (`pt_drud_sym16_HTM`) is shared with `twophase`. It is
  a true optimal solve and is slower than `optimal` would be, but in practice
  often fast: a 13-move scramble solved optimally (12 moves) in ~1 s warm.
- Subsequent visits load from IndexedDB and are fast.

If IndexedDB is unavailable (e.g. Node, or a browser with storage disabled) the
worker falls back to MEMFS and warns that tables will not persist.

## Cache management

The UI shows an estimated origin/IndexedDB usage from
`navigator.storage.estimate()` and a **Delete cached tables** button.

- The button is enabled only once the worker reports cached tables
  (`/tables/invtables` present in IDBFS).
- Deleting terminates the worker (releasing its open IDBFS connection), deletes
  the IndexedDB database(s) named `/tables`, and reloads the page, returning the
  app to its first-run state.
- `navigator.storage.estimate()` is deliberately just an estimate: Chrome can
  report well below the on-disk support-set size (and lags writes), so treat the
  readout as a rough indicator. The delete button's enabled/disabled state is
  the reliable signal for "tables are cached".

Emscripten's IDBFS names its database after the mountpoint
(`IDBFS.getDB(mount.mountpoint, …)` in `libidbfs.js`), i.e. the database is
literally `/tables`. The delete code enumerates `indexedDB.databases()` and
removes any database whose name ends in `/tables`, falling back to deleting
`/tables` directly.

## Repeated commands and the state shim

The worker keeps one long-lived wasm instance and calls `callMain()` once per
command. `main()` runs the internal `freemem` command on return, which calls
`free_pd()`/`free_sd()` and frees the pruning and symmetry-coordinate tables.
Because the `initialized` guards in `init_symcoord()`/`init_moves()` are
function-local statics that are never reset, a second command in the same
instance would then read freed memory and trap with
`memory access out of bounds`.

`nissy_state_shim.c` defines no-op `free_pd`/`free_sd`. It is placed **before**
the upstream objects on the link line, so
`-Wl,--allow-multiple-definition` makes the shim definitions win. The wasm
process never actually exits (`-sEXIT_RUNTIME=0`), each table is allocated at
most once, and memory is reclaimed when the worker is torn down — so keeping the
tables resident is the correct behaviour here. Without the shim, running e.g.
`solve eofb` followed by `twophase` in the same worker crashes.

## Node harness

`run-node.js` runs the same module without a Worker/IndexedDB. By default it
uses MEMFS, so it regenerates the tables every run.

```sh
# exact cold run (regenerates ~589 MB in memory)
node web/run-node.js solve eofb "R U F"

# instant, no tables
node web/run-node.js --persist web/.tables-node invert "R U F"

# persist to disk via NODEFS so later runs (and twophase) are fast
node web/run-node.js --persist web/.tables-node solve eofb "R U F"
node web/run-node.js --persist web/.tables-node twophase "R U F"
```

## Measured timings

Hardware: Apple Silicon macOS, Emscripten 6.0.9, single-threaded pthread shim.
`solve eofb` on `R U F` produces `F (1)`; `invert` produces `F' U' R'`;
`twophase` produces a valid solution (e.g. `F' U' R'` for this short scramble).

| Scenario | Cold (generate) | Warm | Notes |
| --- | --- | --- | --- |
| Browser `invert` (no tables) | — | 0.40 s wall | Worker start + run + empty save |
| Browser `solve eofb` | **39.1 s** | **0.33 s** | Cold generates ~589 MB support set |
| Browser `twophase` | **59.1 s** (support already warm) | <1 s | First use generates ~126 MB pruning tables |
| Node `solve light`, NODEFS | **~27 s** (adds `pt_corners_HTM`, 44 MB) | **~1 s** | True optimal; `R U2 F' L D B2 R'` → `R B2 D' L' F U2 R' (7)` |
| Node `solve eofb`, NODEFS | ~52–80 s | ~0.9–1.3 s | Phase 1 figures |
| Node `twophase`, NODEFS | **56.3 s** | <1 s | Both pruning tables generated |

Cold runs are generation-bound; warm runs are dominated by reading `invtables`
(~322 MB) back into the statically allocated arrays. The persisted support set
is **589 MB** on disk (Node NODEFS), matching the sizes in the project plan
(`invtables` 322 MB, `symc_trans` 202 MB, `symc_moves` 44 MB, `mtables` 20 MB,
`ttables` 15 MB, `sd_eofbepos_16_new` 13 MB, …). The two-phase set adds ~126 MB.

## Files

| File | Purpose |
| --- | --- |
| `build.sh` | Emscripten build (prints version + flags). |
| `nissy_env_override.c` | Pins Nissy's `tabledir` to `/tables` (see below). |
| `nissy_state_shim.c` | No-op `free_pd`/`free_sd` so tables survive repeated `callMain` calls. |
| `nissy-worker.js` | Web Worker: loads the module, mounts IDBFS at `/tables`, runs commands, streams output, saves before `done`. |
| `index.html` / `app.js` | UI: command selector + step dropdown + scramble, elapsed timer, streaming output, cache usage + delete button. |
| `run-node.js` | Node harness (MEMFS, or NODEFS with `--persist`). |
| `out/` | Build artifacts (git-ignored). |

## Table directory

Upstream `src/env.c` derives the table dir from `NISSYDATA` / `XDG_DATA_HOME` /
`HOME` (then appends `/tables`). Emscripten always provides
`HOME=/home/web_user`, which would put tables in `/home/web_user/.nissy/tables`.
To get a single, easy-to-mount path, `nissy_env_override.c` is a constructor
that runs before `main()` and does `setenv("NISSYDATA", "/", 1)`, so
`tabledir == "/tables"`.

## Known gaps / next steps

- Single-threaded generation (~39 s support set cold; ~59 s for the two-phase
  pruning tables). Real Emscripten pthreads would need COOP/COEP, which static
  GitHub Pages hosting cannot set.
- The **fast** `optimal` step still needs ~2.30 GiB of tables and is not
  exposed; **`light`** (true optimal, ~114 MB tables) is available instead.
- `navigator.storage.estimate()` under-reports the cached support set in Chrome
  (it is an estimate and lags IDB writes); use it as a rough indicator.
- Preloading the support/two-phase tables as static assets (per the plan) would
  remove the cold-generation wait entirely.
- Mobile viability is untested; the support set plus wasm memory is ~1–1.5 GB.
