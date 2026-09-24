#ifndef NISSY_WASM_STREAM_H
#define NISSY_WASM_STREAM_H
/* Hooks provided by streamlib.js when built with -DNISSY_WASM_STREAM. */
#ifdef NISSY_WASM_STREAM
#include <stdint.h>
int nissy_stream_enabled(const char *name);
int nissy_stream_read(const char *name, void *buf, uint64_t offset, uint64_t len);
#endif
#endif
