/*
 * Nissy Web Worker.
 *
 * Loads the Emscripten module (out/nissy.js) and runs Nissy's CLI off the main
 * thread. The table directory (/tables, pinned by nissy_env_override.c) is
 * backed by IDBFS so the expensive first-run table generation is persisted in
 * IndexedDB and later runs are fast.
 *
 * Message protocol
 *   main -> worker : { type: 'run', id, args:[...] }
 *   worker -> main : { id, type: 'out'|'err', line }
 *                    { id, type: 'done' }          (only AFTER syncfs finishes)
 *                    { type: 'status', phase, message?, tables? }
 *
 * Status phases: loading, tables, no-idb, load-error, ready, busy, saving,
 *                saved, save-error, fatal.
 *
 * A command is not reported as `done` until FS.syncfs(false, cb) has completed,
 * so a reload or tab close right after `done` cannot lose the freshly generated
 * tables. A `saving` status is posted first so the UI can keep the Run button
 * locked for the whole save.
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

/* Fetch index.json + per-table manifests. On any failure, return {} so the app
 * falls back to in-browser generation. */
function loadStreamTables() {
	function tryIndex(i) {
		if (i >= STREAM_INDEXES.length)
			return Promise.reject(new Error("no stream index reachable"));
		var url = STREAM_INDEXES[i];
		return fetch(url).then(function (r) {
			if (!r.ok) throw new Error("HTTP " + r.status);
			return r.json().then(function (idx) { return { url: url, idx: idx }; });
		}).catch(function () { return tryIndex(i + 1); });
	}

	return tryIndex(0).then(function (res) {
		var base = res.url.replace(/index\.json$/, "");
		var cbase = res.idx.chunkBase || base;
		return Promise.all((res.idx.tables || []).map(function (n) {
			return fetch(base + n + ".manifest.json")
				.then(function (r) {
					if (!r.ok) throw new Error("manifest " + n);
					return r.json();
				})
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
		post({ type: "status", phase: "no-stream",
			message: "Streamed tables unavailable (" + e + "); using generated tables." });
		return {};
	});
}

var instance = null;
var ready = false;
var idbAvailable = false;
var currentId = null;
var running = false;
var pending = [];

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
			post({
				type: "status",
				phase: "tables",
				tables: tablesPresent(),
			});
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
			post({
				type: "status",
				phase: "tables",
				tables: tablesPresent(),
			});
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
	var msg = ev.data;
	if (!msg || msg.type !== "run") return;
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

loadStreamTables().then(function (tables) {
	return createNissy({
		locateFile: function (p) {
			return "out/" + p;
		},
		nissyStreamTables: tables,
		nissyStreamLog: function (name, off, len) {
			post({ type: "stream", name: name, off: off, len: len });
		},
		print: onOut,
		printErr: onErr,
	});
})
	.then(function (mod) {
		instance = mod;
		return setupFS();
	})
	.then(function () {
		ready = true;
		post({
			type: "status",
			phase: "ready",
			persisted: idbAvailable,
		});
		var q = pending;
		pending = [];
		q.forEach(runCommand);
	})
	.catch(function (e) {
		post({
			type: "status",
			phase: "fatal",
			message: "Failed to start engine: " + (e && e.stack ? e.stack : String(e)),
		});
	});
