# Investigation — an "intermediate" optimal table (between `light` and `optimal`)

**Question:** is there an optimal-solve pruning table between `light` (~114 MB)
and `optimal` (~2.3 GB) that fits the browser better while being faster than
`light`?

**Short answer:** stock Nissy has nothing in between; `light` *is* the middle.
A middle table can be constructed, but it requires a fork, a BFS generation
pass, and hosting >100 MB — and its speed benefit over `light` is unproven.
This document lays out the options, sizes, effort, and a recommended experiment.

---

## 1. How the existing optimal tables factor

`pd_nxopt31_HTM` (used by `optimal`, `eofin`, `eofbfin`, `eorlfin`, `eoudfin`)
is one combined coordinate, stored 2 bits/entry with a base offset and a
fallback to `pd_drud_sym16_HTM`:

```
nxopt31  =  coud(2187) × cpud_separate(70) × eofbepos_sym16(64430)
         =  9,863,588,700 entries  →  ~2.30 GiB at 2 bits

drud_sym16 = coud(2187) × eofbepos_sym16(64430)          ← the ×70 is the only difference
           =  140,908,410 entries  →  ~67 MB at 4 bits
```

`light` = `pd_drud_sym16_HTM` (67 MB) + `pd_corners_HTM` (42 MB) ≈ **114 MB**, and
its estimator also evaluates several axes (U/D, R/L, F/B) and inverse bounds.

So the 2.3 GB is entirely the **corner-permutation factor ×70** (`cpud_separate`).
Everything between `light` and `optimal` is a question of how much of that ×70
you include.

## 2. Sizes for a coarse corner-permutation quotient

Any function of the cube state is a valid quotient coordinate, and the distance
in the quotient is an admissible lower bound. If we replace `cpud_separate` (70)
with a coarser coordinate of `k` classes:

| k (cp classes) | entries | 4-bit | 2-bit |
| ---: | ---: | ---: | ---: |
| 1 (= drud_sym16) | 140,908,410 | 67 MB | 34 MB |
| 2 | 281,816,820 | 134 MB | 67 MB |
| 4 | 563,633,640 | 269 MB | 134 MB |
| 5 | 704,542,050 | 336 MB | 168 MB |
| 10 | 1,409,084,100 | 672 MB | 336 MB |
| 14 | 1,972,717,740 | 941 MB | 470 MB |
| 35 | 4,931,794,350 | 2.35 GB | 1.18 GB |
| 70 (= nxopt31) | 9,863,588,700 | 4.70 GB | 2.30 GB |

Memory budget (wasm32, 4 GiB cap): table + **592 MB static `.bss`** + (2× if
staged in the FS by IDBFS). Even k=10 at 2 bits (336 MB → 1.26 GB peak) fits
comfortably; the issue is hosting, not RAM.

**Candidate coarse coordinates** (all functions of the corner permutation, so
move-consistent): the simplest is *how many of the four D-layer corners are in
the D layer* — 5 classes, distribution over the 40320 corner perms is
`{0: 576, 1: 9216, 2: 20736, 3: 9216, 4: 576}`. Finer partitions (10/14/35
classes) are possible but arbitrary; their heuristic value has to be measured.

## 3. Other ways to a "middle"

1. **`light+` — more bounds, no new table.** Nissy's `light` estimator already
   maxes `pd_corners` + `pd_drud_sym16` on three axes + inverse. A fork could
   add cheap existing tables as extra bounds: `pd_cp_drud` (20 KB),
   `pd_htr_drud` (15 KB), `pd_drud_eofb` (0.5 MB), `pd_htrfin_htr` (0.6 MB),
   `pd_drudfin_noE_sym16_drud` (56 MB). Total ≈ 170 MB, **no new generation
   beyond tables other steps already build**. This is the cheapest experiment.
2. **Coarser symmetry for `eofbepos`.** Tempting (48-fold instead of the 16-fold
   `udfix` would cut nxopt31 ~3× to ~0.8 GB) but **not valid**: EO-on-F/B and
   DR-on-U/D are only preserved by the 16-element `udfix` group, so the
   coordinate isn't invariant under the others. Not an option.
3. **Better compression of nxopt31.** It is already 2-bit + base + fallback
   (`genptable_setbase` picks the base). A 1-bit variant would fall back more
   often and shrink toward ~1.2 GB — still >100 MB, still needs the full BFS.
4. **memory64 + the real nxopt31 table.** The only approach that removes the
   intermediate entirely; see `README.md` §2 and the memory analysis.

## 4. Effort to implement a coarse-cp table (fork)

Following Nissy's existing patterns:

- New `Coordinate` (indexer cube→index, `move`, `max`) — needs an
  indexer/anti-indexer for the combined (coud, eofbepos_sym16, coarse-cp) state,
  plus the coarse-cp class function. This is the fiddly part.
- New `PruneData` + `Step`/`Estimator` using `ptableval`, and wiring into
  `all_pd[]` so `genptable`/IDBFS handle it.
- **Generation:** the BFS is roughly linear in entries. `pt_drud_sym16`
  (140.9 M entries) took ~40 s single-threaded natively, so k=5 (704 M) ≈ 3–4 min
  and k=10 (1.4 B) ≈ 7–8 min single-threaded; multithreaded is ~4–8× faster.
- **Hosting:** every option here is >100 MB, so it cannot be a single GitHub
  repo file — it needs chunked `raw` assets or CORS object storage (same problem
  as the support files; see `README.md` §2).

## 5. Recommended experiment (measure before building)

The size/benefit curve is unknown, so measure it before committing to a fork:

1. **`light+` first (cheap).** Add a new estimator that maxes `light`'s bounds
   with `pd_cp_drud`, `pd_htr_drud`, `pd_drud_eofb`, `pd_drudfin_noE_sym16_drud`.
   No new table generation. Compare node counts / wall time against `light` on a
   fixed set of scrambles. If the gain is small, a big coarse-cp table is
   unlikely to pay off either.
2. **Instrument `light`.** Log the IDA* node count per depth for a few hard
   scrambles to see where the time goes and how much headroom a tighter bound
   would give.
3. **Only if (1)/(2) justify it**, prototype one coarse-cp coordinate (start
   with k=5, the "count" coordinate) natively, generate the table, and measure.
4. **Alternatively**, treat memory64 as the real answer and keep `light` as the
   in-browser middle in the meantime.

## 6. Prototype result (`lightplus`)

Implemented and benchmarked in `lightplus/` (a fork). A new HTM coordinate
`cpud_separate × eofbepos_sym16` (4,510,100 entries, ~2.25 MB) was added as an
extra bound to `light`. Node counts (IDA* nodes, `-t 1`):

| scramble | `light` | `lightplus` |
| --- | ---: | ---: |
| `R U F` | 80 | 80 |
| `D2 L2 F2 U2 R2 B2 D' R2 U2` | 29,444 | 29,444 |
| `U R2 F B R B2 R U2 L B2 R` | 1,041 | 1,037 |
| `U2 R2 F2 D2 L2 B2 U2 R2 F2 D2 L2` | 7,594,122 | 7,583,357 |
| `R' U' F D2 L2 F R2 U2 R2 B D2 L` | 7,456 | 7,217 |

**No meaningful speedup (0–3%).** Wall times were identical within noise. The
solutions matched `light` exactly (so the bound is admissible — the coordinate
must be stored in the canonical frame via `transtorep`, like `index_drud_sym16`;
getting that wrong produced 12-move solutions for a 7-move optimum).

Interpretation: `light` already couples `coud` with the **full** corner
permutation (`pd_corners_HTM`) and with `eofbepos` (`pd_drud_sym16_HTM`). The
coarse `cpud_separate` adds little on top of those marginals. To beat the max of
the marginals you need the **joint of a fine coordinate**, i.e. full
`cp × eofbepos` (40320 × 64430 ≈ 2.6 B entries → ~650 MB at 2 bits) or nxopt31
itself.

A second conclusion from the same exercise: cheap additions from the *existing*
table set are impossible — every other `pd_*` uses a DR/HTR moveset, so its value
is an upper bound, not an admissible lower bound for HTM. And symmetry-maxing
gains nothing because the HTM distance is symmetry-invariant.

## 7. Bottom line

- The cheap intermediate (`cpud_separate × eofbepos_sym16`, 2.25 MB) is a
  **dead end** — measured, not just suspected.
- The smallest *useful* intermediate is full `cp × eofbepos_sym16` at **~650 MB**
  (2-bit), which is still >100 MB and needs chunked hosting, for an unproven
  payoff.
- Therefore `light` (114 MB, true optimal) stays the pragmatic middle for the
  browser, and the only path to the *fast* optimal is **memory64 + nxopt31**
  (external CORS storage).
