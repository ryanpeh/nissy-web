/*
 * Single-threaded pthread shim implementation. See shim/pthread.h.
 * Compiled alongside the Nissy sources; the strong definitions here override
 * Emscripten's weak pthread stubs.
 */

#include <pthread.h>

int
pthread_mutex_init(pthread_mutex_t *mutex, const pthread_mutexattr_t *attr)
{
	(void)mutex;
	(void)attr;
	return 0;
}

int
pthread_mutex_lock(pthread_mutex_t *mutex)
{
	(void)mutex;
	return 0;
}

int
pthread_mutex_unlock(pthread_mutex_t *mutex)
{
	(void)mutex;
	return 0;
}

int
pthread_create(pthread_t *thread, const void *attr,
               void *(*start_routine)(void *), void *arg)
{
	static int counter = 0;

	(void)attr;

	/* Run the routine inline and to completion, so the "thread" is done
	 * before pthread_create returns. Mutexes are no-ops, so this is safe. */
	if (start_routine != 0)
		start_routine(arg);

	if (thread != 0)
		*thread = ++counter;

	return 0;
}

int
pthread_join(pthread_t thread, void **retval)
{
	(void)thread;
	if (retval != 0)
		*retval = 0;
	return 0;
}
