#ifndef NISSY_WASM_PTHREAD_SHIM_H
#define NISSY_WASM_PTHREAD_SHIM_H

/*
 * Single-threaded pthread shim for the Nissy wasm POC.
 *
 * Emscripten's real pthreads need SharedArrayBuffer, which needs COOP/COEP
 * headers that GitHub Pages cannot set. For the POC (and a potential
 * single-threaded release) we replace pthreads with sequential equivalents:
 *   - pthread_create runs the routine inline, one at a time;
 *   - pthread_join is a no-op;
 *   - mutexes are no-ops (there is only ever one thread).
 *
 * This header is placed on the include path with -I so that Nissy's
 * `#include <pthread.h>` resolves here instead of the system header.
 */

/* pthread_t must be pointer-sized so the shim matches Emscripten's libc
 * stubs in both wasm32 (ILP32) and wasm64 (LP64) builds. */
typedef unsigned long pthread_t;
typedef int pthread_mutex_t;
typedef int pthread_mutexattr_t;

int pthread_mutex_init(pthread_mutex_t *mutex, const pthread_mutexattr_t *attr);
int pthread_mutex_lock(pthread_mutex_t *mutex);
int pthread_mutex_unlock(pthread_mutex_t *mutex);

int pthread_create(pthread_t *thread, const void *attr,
                   void *(*start_routine)(void *), void *arg);
int pthread_join(pthread_t thread, void **retval);

#endif
