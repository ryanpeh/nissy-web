# Handoff — nissy-web (browser/WASM port)

Operational notes for the next engineer/agent. Read `README.md` first — it holds
the plan and the feasibility findings. This file is the "what do I do next".

---

## 1. Status

- **Phase:** Phases 0, 1 and 2 are **done and verified**. Emscripten 6.0.9;
  `poc/` proves the toolchain; `web/` is a browser page that runs `solve`
  (small-table steps and the true-optimal `light` step), `twophase`, `cleanup`,
  `unniss`, `invert`, `print` and `version` in a Web Worker, persisting tables
  in IndexedDB (cold small-step ~39 s, cold first `twophase` ~60 s, warm
  <1.5 s). Not deployed to GitHub Pages yet.
- **This folder is not a git repo** (and neither is the parent `nissy/`). Only
  `../nissy-command-builder/` is under version control.
- Decisions locked so far:
  - Target a **static, backend-free** browser port hosted on GitHub Pages.
  - Compile the existing C source with **Emscripten** (do not rewrite the solver).
  - Expect to **ship precomputed tables**; do not generate big tables in-browser.
  - First real milestone is a **single-thread proof of concept**, not the optimal
    solver.
- The full hosting analysis (host matrix, partitioning limits, memory, download,
  alternatives, recommendation) is in `README.md` §2.

---

## 2. Environment / prerequisites

- Emscripten is **not installed** (`emcc` absent). Install with
  `brew install emscripten` (or the emsdk).
- Node is available (used by `../nissy-command-builder/tools/`).
- Python 3 is available (`python3 -m http.server` for local serving — required,
  since Web Workers/`fetch` don't work on `file://`).

---

## 3. Phase 0 — proof of concept

Goal: prove the toolchain runs `nissy` in wasm and can execute a real command,
before touching large tables or threads. **Scaffold is in `poc/`.**

Threading strategy (chosen): single-threaded `pthread` shim, so no
`SharedArrayBuffer` / COOP-COEP is needed. The exact pthread surface used by
Nissy is small: `pthread_t`, `pthread_mutex_t`, `pthread_create`,
`pthread_join`, `pthread_mutex_init/lock/unlock`. `poc/shim/pthread.h` and
`poc/shim_pthread.c` provide sequential equivalents (`pthread_create` runs the
routine inline; mutexes are no-ops).

Build and run:

```sh
# one-time: install the toolchain
brew install emscripten          # or use emsdk

cd poc
./build.sh                       # -> out/nissy.js + out/nissy.wasm
node run.js                      # default: solve eofb "R U F"
```

`run.js` loads the module, captures `Module.print`/`printErr`, and calls
`Module.callMain([...])`. The `eofb` step needs only `pd_eofb_HTM` (2,048
entries ≈ 1 KB), generated in-memory in the virtual FS on first use.

### Result (verified, Emscripten 6.0.9-git)

```
$ node run.js
[stderr] --- Warning ---
[stderr] Some pruning tables are missing or unreadable
[stderr] Cannot load invtables, generating it
[stderr] Cannot load mtables, generating it
... (symcoord sd_cp_16 / sd_eofbepos_16 and pt_eofb_HTM generated in-memory) ...
[stderr] Pruning table generated!
F (1)
```

Exit code 0. Build artifacts: `out/nissy.js` (~62 KB) + `out/nissy.wasm`
(~123 KB). The single-threaded pthread shim works (routines run inline; no
crashes). Exit criterion met.

### Emscripten 6.x gotchas (already handled in `poc/`)
- Emscripten's `libc.a` now provides **strong** `pthread_*` stubs, causing
  duplicate-symbol errors. Fixed with `-Wl,--allow-multiple-definition` (the
  shim object is earlier on the link line, so the strong shim wins).
- The output is now a MODULARIZE factory (`module.exports = Module`), so the old
  `global.Module` handshake is ignored. Fixed with `-sMODULARIZE=1
  -sEXPORT_NAME=Module` and calling the factory in `run.js`.
- Pin the Emscripten version (or keep these flags) so CI doesn't break on other
  versions.

### Phase 1 — browser page + IDBFS persistence (DONE)

Files in `web/`:
- `build.sh` — browser build. Reuses the poc shim; adds `-sFORCE_FILESYSTEM=1`,
  `-lidbfs.js -lnodefs.js`, `-sINITIAL_MEMORY=640MB -sMAXIMUM_MEMORY=4GB`,
  `-sEXPORT_NAME=createNissy`, `-sEXPORTED_RUNTIME_METHODS=callMain,FS`; output
  `web/out/nissy.js`.
- `nissy_env_override.c` — constructor sets `NISSYDATA=/` so `tabledir` is
  `/tables`. **Emscripten sets `HOME=/home/web_user`**, so upstream would
  otherwise use `/home/web_user/.nissy/tables`.
- `nissy-worker.js` — Worker: loads the module, mounts IDBFS at `/tables`,
  `syncfs(true)` to populate, streams `print`/`printErr`, runs `callMain`, then
  `syncfs(false)` to persist. Falls back to MEMFS if IDBFS is unavailable (Node).
- `index.html` + `app.js` — minimal UI: step select + scramble + Run (plus a raw
  command box), streaming output, status line.
- `run-node.js` — Node harness: `node run-node.js [--persist DIR] <args>`.
- `README.md`.

Build / serve / test:
```sh
cd web && ./build.sh
python3 -m http.server 8770      # open http://localhost:8770/

node run-node.js solve eofb "R U F"                 # cold, MEMFS (~52 s)
node run-node.js --persist .tables-node solve eofb "R U F"   # warm after 1st
```

Measured (verified):
- Node cold: ~52 s → `F (1)`, peak RSS ~2.0 GB.
- Node `--persist .tables-node`: cold ~52 s, warm ~0.8 s, 589 MB persisted.
- Browser (headless Chrome via CDP): cold ~47.5 s, warm after reload ~0.8 s;
  IDBFS persistence confirmed (warm run has no "generating" lines).
- `-sINITIAL_MEMORY=640MB` is required: Nissy's inverse tables are ~592 MB of
  static `.bss`.

Known issues / next:
- `persist()` is fire-and-forget; a reload immediately after a run can lose
  tables. Gate "done" on `syncfs(false)` completing, and/or add a "saving…" lock.
- First-run generation blocks the worker with coarse progress (only pruning-table
  depth lines). Consider a progress readout.
- Warm peak RSS ~0.73 GB (Node); mobile viability unverified.
- Build flags are Emscripten-version sensitive (6.x); pin the version in CI.
- Browser testing note: headless Chrome's `--virtual-time-budget` does not
  advance Web Workers — drive it with the DevTools Protocol in real time.

### Phase 2 — commands + persistence hardening (DONE)

Changes in `web/`:
- **Persistence correctness.** `nissy-worker.js` now posts a `saving` status,
  runs `FS.syncfs(false, cb)`, and emits `{id,type:'done'}` from *inside* the
  sync callback, so a reload right after a run cannot lose tables. Sync errors
  surface as `save-error`; `done` still fires so the UI unlocks.
- **Command selector.** `index.html`/`app.js` now support `solve` (with the step
  dropdown), `twophase`, `cleanup`, `unniss`, `invert`, `print`, `version`, plus
  the free-text override. The scramble is passed as one argv token.
- **Cache management.** Storage-usage readout via `navigator.storage.estimate()`
  and a "Delete cached tables" button (enabled only when `/tables/invtables`
  exists). It deletes the IDBFS database (name is the mount point, `/tables`),
  terminates the worker, and reloads to the first-run state.
- **UX.** Live elapsed timer; inputs locked while running/saving; first-run and
  `twophase` cost messaging.
- **`nissy_state_shim.c` (new, important).** `main()` runs internal `freemem` on
  return, calling `free_pd`/`free_sd` while `init_symcoord`/`init_moves` use
  function-local `static bool initialized` guards that are never reset. In a
  long-lived instance (`-sEXIT_RUNTIME=0`) the next command then reads freed
  memory and traps. The shim no-ops `free_pd`/`free_sd` (linked first, so
  `--allow-multiple-definition` keeps them). Each table is allocated at most
  once, so nothing accumulates. Safe here; do not "fix" upstream.

Measured (browser, CDP): `invert` 0.40 s; cold `solve eofb` 39.4 s; warm reload
`solve eofb` 0.35 s; first `twophase` 60.0 s; delete-cache returns to first-run.
`navigator.storage.estimate()` under-reports (Chrome lag); the presence of
`/tables/invtables` is the reliable "cached" signal.

Known issues / next:
- The 39 s / 60 s cold generation remains the main UX cost; real progress
  reporting is still coarse (exact only for the pruning-table BFS).
- Consider scoped-quota warning near ~1 GB and multi-tab delete (`onblocked`).

UI refinements (later on 2026-09-21):
- **Stop** button: Nissy has no cancel hook, so Stop terminates the worker and
  restarts it (tables reload warm from IndexedDB; unsaved generation is lost).
  Disabled during the save phase.
- **Result / Log split**: stdout → a prominent Result panel; stderr (warnings,
  generation progress, errors) → a collapsed Log. Auto-opens the log when a run
  produces no stdout.
- Collapsible Help, Copy buttons (scramble / result), full-width scramble box,
  and `localStorage` persistence of command/step/scramble.
- **Optimal beyond `light`** is investigated in `INTERMEDIATE.md` (coarse
  corner-permutation table at 134–336 MB, `light+` extra bounds, memory64).

---

## 4. Hard constraints to keep in mind

- **No custom headers on GitHub Pages** → no COOP/COEP → no `SharedArrayBuffer`
  → Emscripten threads won't work unless you add a `coi-serviceworker`. Decide
  per phase.
- **100 MB per-file git limit; ~1 GB Pages site limit.** The ~126 MB two-phase
  and ~114 MB light sets fit as ordinary repo files. The **2.30 GiB optimal table
  does not** and cannot be fetched from Release assets (no CORS).
- **wasm32 memory ceiling ≈ 4 GiB.** The optimal table alone is ~2.4 GiB; treat
  in-browser optimal as risky/unlikely.
- **Random access pattern:** pruning tables are looked up at random indices, so
  the whole table must be resident — network paging is not viable.
- **GPLv3:** Nissy is GPLv3; keep the source public and share modifications.

---

## 5. Measured facts (for reference)

Table sizes are in `README.md` §1.2; the full host/CORS/partitioning analysis is
in `README.md` §2. Quick recap:
- `pd_nxopt31_HTM` ≈ 2.30 GiB; two-phase ≈ 126 MB; light ≈ 114 MB.
- `raw.githubusercontent.com` sends `access-control-allow-origin: *` and
  `accept-ranges: bytes`.
- GitHub Release assets: `accept-ranges: bytes` but **no ACAO**, `OPTIONS` → 404.
- GitHub Pages: same-origin, so CORS is moot for repo-hosted assets.

Reproduce the CORS probe:
```sh
curl -sIL -H "Origin: https://example.com" \
  https://raw.githubusercontent.com/ryanpeh/nissy-thing/main/index.html | rg -i 'access-control|accept-ranges'

curl -s -D - -o /dev/null -H "Origin: https://example.com" -r 0-0 -L \
  https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz | rg -i 'HTTP/|access-control|accept-ranges'
```

---

## 6. Decision log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-09-21 | Static, no backend | Host on GitHub Pages |
| 2026-09-21 | Emscripten, not a rewrite | Preserve upstream solver behavior |
| 2026-09-21 | POC single-threaded first | Avoid COOP/COEP while validating toolchain |
| 2026-09-21 | Target two-phase/light before optimal | Optimal (~2.3 GiB) can't be hosted on GitHub and risks the wasm32 memory limit |
| 2026-09-21 | Tables precomputed, shipped as assets | In-browser generation is too slow |
| 2026-09-21 | Full optimal is not hostable on GitHub | 100 MB/file + 2 GiB/asset (no CORS) limits; ~1 GB Pages site |
| 2026-09-21 | Partitioning the 2.3 GiB table is not sufficient | Fixes file size/CORS but not the 4 GiB wasm memory ceiling or 2.3 GB download |
| 2026-09-21 | Keep Pages; use object storage (R2/B2/S3) only if full optimal is required | CORS + Range configurable, no backend code |
| 2026-09-21 | Phase 0 passed | Emscripten 6.0.9 wasm runs `solve eofb` → `F (1)`; toolchain validated |
| 2026-09-21 | Emscripten 6.x build flags | Need `-sMODULARIZE=1` and `-Wl,--allow-multiple-definition`; pin version |
| 2026-09-21 | Phase 1 must ship/preload tables | Regenerating tables in-memory costs ~60 s per run |
| 2026-09-21 | Phase 1 persists tables with IDBFS, not `--preload-file` | Support set is ~617 MB with files >100 MB (invtables 322 MB, symc_trans 202 MB) → can't preload on Pages |
| 2026-09-21 | Force `NISSYDATA=/` via a constructor | Emscripten sets `HOME`, so upstream's table dir would be elsewhere |
| 2026-09-21 | `-sINITIAL_MEMORY=640MB` | Nissy's static inverse tables are ~592 MB of `.bss` |
| 2026-09-21 | Gate "done" on `syncfs(false)` | Prevent losing tables on reload after a run |
| 2026-09-21 | No-op `free_pd`/`free_sd` via `nissy_state_shim.c` | Avoid use-after-free on repeated `callMain` in one instance |
| 2026-09-21 | Generate+cache `twophase` tables, don't ship them | Shipping wouldn't remove the ~617 MB support-file generation |
| 2026-09-21 | Expose `light` instead of `optimal` | `light` is true optimal with ~114 MB of tables and fits the 4 GiB cap; `optimal` needs 2.30 GiB |
| 2026-09-21 | `light` added to the UI step list; `web/README.md` updated | Cold adds `pt_corners_HTM` (~44 MB); warm solves ~1 s |
| 2026-09-21 | Stop = terminate worker + warm restart | `callMain` is synchronous with no cancel hook |
| 2026-09-21 | Result/Log split by stdout vs stderr | Nissy prints answers with `printf`, diagnostics with `fprintf(stderr,…)` |
| 2026-09-21 | Investigate intermediate optimal table (`INTERMEDIATE.md`); try `light+` first | Middle table needs a fork + BFS + >100 MB hosting; payoff unproven |
| 2026-09-21 | Intermediate bound is a **dead end** (measured) | `lightplus` prototype (`cpud_separate × eofbepos_sym16`) gave 0–3% node change; `light` already has full `cp` + `eofbepos` marginals |
| 2026-09-21 | Fork lives in `lightplus/`; upstream untouched | Experiment record; see its README |
| 2026-09-21 | `pthread_t` shim made pointer-sized (`unsigned long`) | Required for `-sMEMORY64=1`; harmless on wasm32 |
| 2026-09-21 | Full `nxopt31` feasible only on desktop Chrome/Firefox (memory64) | Chrome wasm ceiling ~3.6 GiB vs ~3.14 GiB peak; Safari/mobile no; needs one-copy streaming + 2.3 GB chunked hosting (`NXOPT31.md`) |
| 2026-09-21 | One-copy streaming loader implemented in the fork | `read_ptable_file` → `nissy_stream_read` (JS lib) writes chunks straight into `pd->ptable`; verified on real tables, wasm32 + memory64 |
| 2026-09-21 | Browser demo in `lightplus/web/` (Range server `serve.js`) | Verified in Chrome: 67.2 MB + 42.0 MB streamed into the heap via `Range` |
| 2026-09-24 | Generated `pt_nxopt31_HTM` (2.30 GiB) + chunked into 25×96 MB (`dist-tables/`) | Ready to host; see `NXOPT31.md` §4 |
| 2026-09-24 | Patched `genptable()` load path to allocate compact size (not 2×) | 2.30 GiB vs 4.93 GiB → wasm32 now fits; verified real table via chunked loader |
| 2026-09-24 | Real 2.30 GiB table streamed in Chrome (all 25 chunks) | `Total: 9863588700`; demo build cap 4 GB |
| 2026-09-24 | **Full `solve optimal` in Chrome**: stream hook extended to support files + `pt_drud_sym16_HTM` fallback | 10 tables, 3050 MB streamed, `F' U' R' (3)`; no memory64 needed |
| 2026-09-24 | Main app builds the fork with streaming; fetches `STREAM_INDEX` + manifests | `web/` `optimal` works; small steps stream support files (eofb 4.5 s); hosting in `HOSTING.md` |

---

## 7. Working agreement (keep docs current)

- **`README.md` is the plan of record.** When a discussion changes scope, a
  constraint, or a decision, update `README.md` (sections 1–4) and add a dated
  line to its **Changelog**.
- **`HANDOFF.md` (this file)** tracks status, the immediate next action, and the
  decision log. Update §1 and §6 when something is actually built or decided.
- Prefer linking to upstream files (`../nissy-2.0.8/src/...`) rather than
  copying code into this folder.
