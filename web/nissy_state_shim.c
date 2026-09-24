/*
 * Keep Nissy's large tables resident across multiple callMain() invocations.
 *
 * The browser worker and the Node harness call instance.callMain() once per
 * command inside a single, long-lived wasm instance (-sEXIT_RUNTIME=0, so the
 * process never really exits between commands). main() runs the internal
 * `freemem` command on exit, whose free_pd()/free_sd() release the pruning and
 * symmetry-coordinate tables.
 *
 * That teardown is only correct for a process that is about to exit. It is a
 * use-after-free here because the initialization guards are function-local
 * `static bool initialized` variables inside init_symcoord() (symcoord.c) and
 * init_moves() (moves.c): after free_sd() runs, the next command's
 * init_symcoord() returns early, leaving the coordinate lookups pointing at
 * freed memory. The first large lookup then traps with
 * "memory access out of bounds".
 *
 * Override both destructors with no-ops. They are linked before the upstream
 * definitions (see build.sh) and -Wl,--allow-multiple-definition makes the
 * first definition win. Each table is allocated at most once, so nothing
 * accumulates, and memory is reclaimed when the worker/module is torn down.
 */
typedef struct prunedata PruneData;
typedef struct symdata SymData;

void free_pd(PruneData *pd) { (void)pd; }
void free_sd(SymData *sd) { (void)sd; }
