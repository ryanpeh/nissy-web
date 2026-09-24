/*
 * Force Nissy's table directory to the absolute path /tables.
 *
 * Upstream src/env.c computes the table dir from the environment:
 *   NISSYDATA                      -> NISSYDATA
 *   else XDG_DATA_HOME             -> XDG_DATA_HOME/nissy
 *   else HOME                      -> HOME/.nissy
 *   else                           -> .
 * followed by "/tables".
 *
 * Emscripten always provides HOME=/home/web_user, so without this the tables
 * would land in /home/web_user/.nissy/tables. We want a fixed, easy-to-mount
 * path for IDBFS, so set NISSYDATA="/" which makes tabledir exactly "/tables".
 *
 * A constructor runs during __wasm_call_ctors, before main() (and therefore
 * before init_env()), and setenv() is honoured by getenv() in Emscripten.
 */
#include <stdlib.h>

/* musl hides setenv() under -std=c99 unless a POSIX feature macro is set;
 * declare it explicitly instead of relying on the toolchain's feature flags. */
int setenv(const char *name, const char *value, int overwrite);

__attribute__((constructor))
static void
nissy_force_tabledir(void)
{
	setenv("NISSYDATA", "/", 1);
}
