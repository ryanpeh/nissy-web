/*
 * Emscripten JS library for the wasm streaming table loader.
 *
 * Reads [offset, offset+len) of a pruning table and writes it straight into the
 * wasm heap (bufPtr), in chunks, so the whole table is never held in JS memory
 * (one copy).
 *
 * Two source forms, set on Module before instantiation:
 *   Module.nissyStreamURLs   = { "pt_xxx": "https://…/pt_xxx" }
 *       A single file, fetched with Range requests.
 *   Module.nissyStreamTables = { "pt_xxx": { size, chunkSize, chunks:[url,…] } }
 *       A table split into <100 MB chunks (from chunk-table.js's manifest).
 *
 * Node uses fs; the browser uses synchronous Range requests (must run in a
 * Web Worker). memory64 passes i64 params as BigInt; they are coerced.
 */
mergeInto(LibraryManager.library, {
  nissy_stream_enabled: function (namePtr) {
    var name = UTF8ToString(Number(namePtr));
    if (Module.nissyStreamTables && Module.nissyStreamTables[name]) return 1;
    if (ENVIRONMENT_IS_NODE) {
      if (!Module.nissyStreamBase) return 0;
      try { return require('fs').existsSync(Module.nissyStreamBase + '/' + name) ? 1 : 0; }
      catch (e) { return 0; }
    }
    return (Module.nissyStreamURLs && Module.nissyStreamURLs[name]) ? 1 : 0;
  },

  nissy_stream_read: function (namePtr, bufPtr, offset, len) {
    var name = UTF8ToString(Number(namePtr));
    var off = Number(offset), n = Number(len);
    var CHUNK = 8 * 1024 * 1024;
    /* wasm32: Number; memory64: BigInt -> Number (sizes < 2^53) */
    var dst = (typeof bufPtr === 'bigint') ? Number(bufPtr) : bufPtr;
    var remaining = n;
    var spec = Module.nissyStreamTables && Module.nissyStreamTables[name];

    function log(o, l) {
      if (Module.nissyStreamLog) Module.nissyStreamLog(name, o, l);
      else if (Module.nissyStreamVerbose) console.error("[stream] " + name + " off=" + o + " len=" + l);
    }

    /* --- chunked source (manifest) --- */
    if (spec) {
      var chunkSize = spec.chunkSize;
      while (remaining > 0) {
        var ci = Math.floor(off / chunkSize);
        var co = off - ci * chunkSize;
        var cl = Math.min(chunkSize - co, remaining);
        var src = spec.chunks[ci];
        if (!src) return 0;
        if (ENVIRONMENT_IS_NODE) {
          var fs = require('fs');
          var p = (Module.nissyStreamBase ? Module.nissyStreamBase + '/' : '') + src;
          var fd;
          try { fd = fs.openSync(p, 'r'); } catch (e) { return 0; }
          var b = Buffer.allocUnsafe(cl);
          var g = fs.readSync(fd, b, 0, cl, co);
          fs.closeSync(fd);
          if (g !== cl) return 0;
          HEAPU8.set(b, dst);
        } else {
          var cache = Module.nissyStreamCache;
          var h = cache && cache.handles && cache.handles[src];
          var expected = cache && cache.sizes && cache.sizes[src];
          if (h && expected && h.getSize() === expected) {
            /* already cached: read straight into the heap (disk -> wasm) */
            h.read(HEAPU8.subarray(dst, dst + cl), { at: co });
          } else {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', src, false);
            xhr.responseType = 'arraybuffer';
            xhr.setRequestHeader('Range', 'bytes=' + co + '-' + (co + cl - 1));
            xhr.send(null);
            if (xhr.status !== 206 && xhr.status !== 200) return 0;
            var bytes = new Uint8Array(xhr.response);
            HEAPU8.set(bytes, dst);
            if (h) {
              try { h.write(bytes, { at: co }); h.flush(); }
              catch (e) { /* ignore cache write errors */ }
            }
          }
        }
        log(off, cl);
        dst += cl; off += cl; remaining -= cl;
      }
      return 1;
    }

    /* --- single-file source --- */
    if (ENVIRONMENT_IS_NODE) {
      if (!Module.nissyStreamBase) return 0;
      var fs2 = require('fs');
      var path = Module.nissyStreamBase + '/' + name;
      var fd2;
      try { fd2 = fs2.openSync(path, 'r'); } catch (e) { return 0; }
      while (remaining > 0) {
        var c = Math.min(CHUNK, remaining);
        var b2 = Buffer.allocUnsafe(c);
        var got = fs2.readSync(fd2, b2, 0, c, off);
        if (got !== c) { fs2.closeSync(fd2); return 0; }
        HEAPU8.set(b2, dst);
        log(off, c);
        dst += c; off += c; remaining -= c;
      }
      fs2.closeSync(fd2);
      return 1;
    }

    var url = Module.nissyStreamURLs && Module.nissyStreamURLs[name];
    if (!url) return 0;
    while (remaining > 0) {
      var c2 = Math.min(CHUNK, remaining);
      var xhr2 = new XMLHttpRequest();
      xhr2.open('GET', url, false);
      xhr2.responseType = 'arraybuffer';
      xhr2.setRequestHeader('Range', 'bytes=' + off + '-' + (off + c2 - 1));
      xhr2.send(null);
      if (xhr2.status !== 206 && xhr2.status !== 200) return 0;
      HEAPU8.set(new Uint8Array(xhr2.response), dst);
      log(off, c2);
      dst += c2; off += c2; remaining -= c2;
    }
    return 1;
  }
});
