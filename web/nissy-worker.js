/*
 * Nissy Web Worker.
 *
 * Loads the Emscripten module (out/nissy.js) and runs Nissy's CLI off the main
 * thread. The table directory (/tables, pinned by nissy_env_override.c) is
 * backed by IDBFS so generated tables persist in IndexedDB.
 *
 * Big precomputed tables (the optimal one etc.) are *streamed* straight into the
 * wasm heap via streamlib.js. Streaming sources are fetched from STREAM_INDEXES
 * concurrently with engine startup, with per-request timeouts, so a slow or
 * unreachable CDN never blocks the engine from becoming ready.
 *
 * Message protocol
 *   main -> worker : { type: 'run', id, args:[...] }
 *   worker -> main : { id, type: 'out'|'err', line }
 *                    { id, type: 'done' }          (only AFTER syncfs finishes)
 *                    { type: 'stream', name, off, len }
 *                    { type: 'status', phase, message?, tables? }
 *
 * Status phases: starting, loading-tables, tables, no-stream, no-idb,
 *                load-error, ready, busy, saving, saved, save-error, fatal.
 */
"use strict";

importScripts("out/nissy.js");

/* Where the streamed table chunks live. Tried in order: the hosted copy on
 * GitHub raw (the `tables` branch of ryanpeh/nissy-web), then a same-origin
 * /dist-tables/ (for local dev). See ../HOSTING.md. */
var STREAM_INDEXES = [
	"https://raw.githubusercontent.com/ryanpeh/nissy-web/tables/index.json",
	"/dist-tables/index.json"
];
var FETCH_TIMEOUT_MS = 15000;

var instance = null;
var ready = false;
var idbAvailable = false;
var currentId = null;
var running = false;
var pending = [];
var streamTables = {};   /* name -> manifest, for stream progress totals */

function post(msg) {
	self.postMessage(msg);
}

function emit(type, line) {
	post({ id: currentId, type: type, line: line });
}

function onOut(line) {
	emit("out", String(line));
}

function onErr(line) {
	emit("err", String(line));
}

/* fetch() with a timeout so a hung CDN can't stall the app. */
function fetchJson(url, ms) {
	var ctrl = new AbortController();
	var timer = setTimeout(function () { ctrl.abort(); }, ms);
	return fetch(url, { signal: ctrl.signal }).then(function (r) {
		clearTimeout(timer);
		if (!r.ok) throw new Error("HTTP " + r.status);
		return r.json();
	}).catch(function (e) {
		clearTimeout(timer);
		throw e;
	});
}

/* Fetch index.json + per-table manifests, with timeouts. Resolves to a map
 * (possibly empty) and never rejects. */
function loadStreamTables() {
	function tryIndex(i) {
		if (i >= STREAM_INDEXES.length)
			return Promise.reject(new Error("no stream index reachable"));
		var url = STREAM_INDEXES[i];
		return fetchJson(url, FETCH_TIMEOUT_MS).then(function (idx) {
			return { url: url, idx: idx };
		}).catch(function () { return tryIndex(i + 1); });
	}

	return tryIndex(0).then(function (res) {
		var base = res.url.replace(/index\.json$/, "");
		var cbase = res.idx.chunkBase || base;
		return Promise.all((res.idx.tables || []).map(function (n) {
			return fetchJson(base + n + ".manifest.json", FETCH_TIMEOUT_MS)
				.then(function (m) {
					m.chunks = m.chunks.map(function (c) { return cbase + c; });
					return [n, m];
				});
		})).then(function (pairs) {
			var map = {};
			pairs.forEach(function (p) { map[p[0]] = p[1]; });
			post({ type: "status", phase: "stream-ready", count: pairs.length, base: base });
			return map;
		});
	}).catch(function (e) {
		post({
			type: "status",
			phase: "no-stream",
			message: "Streamed tables unavailable (" + e + "); using generated tables.",
		});
		return {};
	});
}

function tablesPresent() {
	var present = false;
	if (!instance) return false;
	try {
		present = instance.FS.analyzePath("/tables/invtables").exists;
	} catch (e) {
		present = false;
	}
	return present;
}

function setupFS() {
	var FS = instance.FS;

	try {
		FS.mkdir("/tables");
	} catch (e) {
		/* already exists */
	}

	if (!FS.filesystems || !FS.filesystems.IDBFS) {
		idbAvailable = false;
		post({
			type: "status",
			phase: "no-idb",
			message:
				"IndexedDB backend not linked; using in-memory tables " +
				"(tables will NOT persist between runs).",
		});
		return Promise.resolve();
	}

	try {
		FS.mount(FS.filesystems.IDBFS, {}, "/tables");
		idbAvailable = true;
	} catch (e) {
		idbAvailable = false;
		post({
			type: "status",
			phase: "no-idb",
			message:
				"Could not mount IDBFS (" +
				(e && e.message ? e.message : String(e)) +
				"); using in-memory tables.",
		});
		return Promise.resolve();
	}

	return new Promise(function (resolve) {
		post({
			type: "status",
			phase: "loading",
			message: "Loading Nissy tables from IndexedDB\u2026",
		});
		FS.syncfs(true, function (err) {
			if (err) {
				post({
					type: "status",
					phase: "load-error",
					message: "IDBFS load error: " + err,
				});
				resolve();
				return;
			}
			post({ type: "status", phase: "tables", tables: tablesPresent() });
			resolve();
		});
	});
}

/*
 * Persist /tables to IndexedDB, then report the run complete. The `done`
 * message is emitted from the syncfs callback, never before.
 */
function saveThenDone() {
	var id = currentId;

	if (!idbAvailable || !instance) {
		post({ id: id, type: "done" });
		currentId = null;
		running = false;
		return;
	}

	post({
		type: "status",
		phase: "saving",
		message: "Saving tables to IndexedDB\u2026",
	});

	instance.FS.syncfs(false, function (err) {
		if (err) {
			post({
				type: "status",
				phase: "save-error",
				message: "IDBFS save error: " + err,
			});
		} else {
			post({ type: "status", phase: "tables", tables: tablesPresent() });
			post({ type: "status", phase: "saved" });
		}
		post({ id: id, type: "done" });
		currentId = null;
		running = false;
	});
}

function runCommand(msg) {
	currentId = msg.id;
	running = true;
	var args = Array.isArray(msg.args) ? msg.args.slice() : [];
	try {
		instance.callMain(args);
	} catch (e) {
		// Emscripten throws ExitStatus on exit(); that is normal.
		if (!e || e.name !== "ExitStatus") {
			emit("err", "[exception] " + (e && e.message ? e.message : String(e)));
		}
	}
	saveThenDone();
}

self.onmessage = function (ev) {
	var msg = ev.data || {};
	if (msg.type === "closeCache") {
		/* Release OPFS sync access handles so the page can delete them. */
		if (instance && instance.nissyStreamCache) {
			var hs = instance.nissyStreamCache.handles || {};
			Object.keys(hs).forEach(function (k) {
				try { hs[k].close(); } catch (e) { /* ignore */ }
			});
			instance.nissyStreamCache = null;
		}
		streamTables = {};
		post({ type: "cacheClosed" });
		return;
	}
	if (msg.type !== "run") return;
	if (!ready || running) {
		pending.push(msg);
		post({
			type: "status",
			phase: "busy",
			message: "Engine is busy; command queued\u2026",
		});
		return;
	}
	runCommand(msg);
};

/*
 * Open an OPFS sync access handle for every table chunk. streamlib.js then reads
 * chunks from OPFS when present, and writes freshly fetched bytes into it, so a
 * chunk is downloaded at most once per origin. Returns null if OPFS is
 * unavailable (then streamlib just fetches every time).
 */
function setupCache(tables) {
	if (typeof navigator === "undefined" || !navigator.storage ||
	    !navigator.storage.getDirectory)
		return Promise.resolve(null);

	if (navigator.storage.persist)
		try { navigator.storage.persist(); } catch (e) { /* ignore */ }

	return navigator.storage.getDirectory().then(function (root) {
		return root.getDirectoryHandle("nissy-tables", { create: true })
			.then(function (dir) {
				var handles = {}, sizes = {}, jobs = [];
				Object.keys(tables).forEach(function (name) {
					var m = tables[name];
					m.chunks.forEach(function (url, i) {
						var last = (i === m.chunks.length - 1);
						var expected = last
						    ? m.size - m.chunkSize * (m.chunks.length - 1)
						    : m.chunkSize;
						var fname = encodeURIComponent(url)
						    .replace(/%/g, "_").slice(-200);
						jobs.push(dir.getFileHandle(fname, { create: true })
							.then(function (fh) {
								return fh.createSyncAccessHandle();
							})
							.then(function (h) {
								handles[url] = h;
								sizes[url] = expected;
							})
							.catch(function () { /* per-file failure: skip */ }));
					});
				});
				return Promise.all(jobs).then(function () {
					return { handles: handles, sizes: sizes };
				});
			});
	}).catch(function () {
		return null;
	});
}

/* Engine startup runs concurrently with the table fetch: we do NOT wait on the
 * network before creating the module, we only wait (bounded, thanks to the
 * fetch timeouts) before declaring the engine ready. */
post({ type: "status", phase: "starting", message: "Starting engine\u2026" });
post({ type: "status", phase: "loading-tables", message: "Loading table sources\u2026" });
var tablesPromise = loadStreamTables();

createNissy({
	locateFile: function (p) {
		return "out/" + p;
	},
	nissyStreamLog: function (name, off, len) {
		var total = (streamTables[name] && streamTables[name].size) || 0;
		post({ type: "stream", name: name, off: off, len: len, total: total });
	},
	print: onOut,
	printErr: onErr,
})
	.then(function (mod) {
		instance = mod;
		return setupFS();
	})
	.then(function () {
		return tablesPromise;
	})
	.then(function (tables) {
		streamTables = tables;
		// streamlib reads Module.nissyStreamTables / nissyStreamCache at call
		// time, so attaching them here (after module creation) is fine.
		return setupCache(tables).then(function (cache) {
			if (instance) {
				instance.nissyStreamTables = tables;
				instance.nissyStreamCache = cache;
			}
			ready = true;
			post({
				type: "status",
				phase: "ready",
				persisted: idbAvailable,
				cached: !!cache,
			});
			var q = pending;
			pending = [];
			q.forEach(runCommand);
		});
	})
	.catch(function (e) {
		post({
			type: "status",
			phase: "fatal",
			message: "Failed to start engine: " + (e && e.stack ? e.stack : String(e)),
		});
	});
