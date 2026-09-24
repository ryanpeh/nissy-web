/*
 * Main-thread UI for the Nissy wasm worker.
 *
 * Builds nissy CLI argument vectors and streams worker output into the page.
 * Supports the structured commands (solve with a step, twophase, cleanup,
 * unniss, invert, print, version) plus a free-text override, a live elapsed
 * timer, and IndexedDB cache management.
 */
"use strict";

var STEPS = [
	["light", "Optimal solve (small tables, slower)"],
	["optimal", "Optimal solve (streams ~3 GB tables)"],
	["eofb", "EO on F/B"],
	["eorl", "EO on R/L"],
	["eoud", "EO on U/D"],
	["eo", "EO on any axis"],
	["coud", "CO on U/D"],
	["corl", "CO on R/L"],
	["cofb", "CO on F/B"],
	["co", "CO on any axis"],
	["htr", "HTR from DR"],
	["htr-drud", "HTR from DR on U/D"],
	["htrfin", "HTR finish"],
	["chtr", "cornershtr (solve corners to HTR)"],
	["chtr-URF", "cornershtr-URF (URF moveset)"],
];

/* Commands exposed by the structured UI. `step` means solve needs a step and
 * `scramble` means the command takes a scramble argument. */
var COMMANDS = [
	{ value: "solve", label: "solve", step: true, scramble: true },
	{ value: "twophase", label: "twophase", step: false, scramble: true },
	{ value: "cleanup", label: "cleanup", step: false, scramble: true },
	{ value: "unniss", label: "unniss", step: false, scramble: true },
	{ value: "invert", label: "invert", step: false, scramble: true },
	{ value: "print", label: "print", step: false, scramble: true },
	{ value: "version", label: "version", step: false, scramble: false },
];

/* Emscripten's IDBFS names its database after the mountpoint, i.e. "/tables"
 * (see libidbfs.js: IDBFS.getDB(mount.mountpoint, ...)). */
var IDBFS_DB_NAME = "/tables";

var statusEl = document.getElementById("status");
var commandEl = document.getElementById("command");
var stepWrapEl = document.getElementById("stepWrap");
var stepEl = document.getElementById("step");
var scrambleEl = document.getElementById("scramble");
var customEl = document.getElementById("custom");
var runEl = document.getElementById("run");
var stopEl = document.getElementById("stop");
var clearEl = document.getElementById("clear");
var timerEl = document.getElementById("timer");
var cacheUsageEl = document.getElementById("cacheUsage");
var deleteEl = document.getElementById("delete");
var outEl = document.getElementById("out");
var logEl = document.getElementById("log");
var logBoxEl = document.getElementById("logBox");
var sawResult = false;
var progressEl = document.getElementById("progress");
var progressLabelEl = document.getElementById("progressLabel");
var progressBarEl = document.getElementById("progressBar");
var copyScrambleEl = document.getElementById("copyScramble");
var copyOutEl = document.getElementById("copyOut");
var tableModeEl = document.getElementById("tableMode");

STEPS.forEach(function (s) {
	var o = document.createElement("option");
	o.value = s[0];
	o.textContent = s[1] + "  (" + s[0] + ")";
	stepEl.appendChild(o);
});

var ready = false;
var busy = false;
var saving = false;
var hasTables = false;
var hasOPFS = false;   /* OPFS chunk cache present */
var justSaved = false;
var nextId = 1;
var startTime = 0;
var timerHandle = null;

var worker = null;

/* "generate" (default): generate tables in-browser. "download": stream the
 * precomputed chunks. In generate mode only the optimal table is streamed,
 * because generating it is not feasible in wasm. */
var tableMode = "generate";
try { tableMode = localStorage.getItem("nissyweb:tables") || "generate"; } catch (e) { /* ignore */ }
if (tableModeEl) tableModeEl.value = tableMode;

function startWorker() {
	worker = new Worker("nissy-worker.js?mode=" + encodeURIComponent(tableMode));
	worker.onmessage = onWorkerMessage;
	worker.onerror = onWorkerError;
}

function setStatus(text, cls) {
	statusEl.textContent = text;
	statusEl.className = cls || "";
}

/* stdout goes to the Result panel; stderr (warnings, generation progress,
 * "Searching depth N", errors) goes to the collapsible Log. Nissy prints the
 * answer with printf() and diagnostics with fprintf(stderr, ...), so the split
 * is clean. */
function clearResult() { outEl.textContent = ""; }

function placeholder(text) {
	outEl.textContent = "";
	var s = document.createElement("span");
	s.className = "empty";
	s.textContent = text;
	outEl.appendChild(s);
}

function appendResult(line, cls) {
	if (!sawResult) { outEl.textContent = ""; sawResult = true; }
	var span = document.createElement("span");
	if (cls) span.className = cls;
	span.textContent = line + "\n";
	outEl.appendChild(span);
	outEl.scrollTop = outEl.scrollHeight;
}

function appendLog(line) {
	var span = document.createElement("span");
	span.textContent = line + "\n";
	logEl.appendChild(span);
	logEl.scrollTop = logEl.scrollHeight;
}

/* ---- clipboard ---------------------------------------------------------- */

function copyText(text, btn, okLabel) {
	if (!text) return;
	var done = function () {
		if (!btn) return;
		var old = btn.getAttribute("data-label");
		if (old === null) {
			old = btn.textContent;
			btn.setAttribute("data-label", old);
		}
		btn.textContent = okLabel || "Copied";
		setTimeout(function () { btn.textContent = old; }, 1000);
	};
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(text).then(done, done);
	} else {
		var ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		try { document.execCommand("copy"); } catch (e) { /* ignore */ }
		document.body.removeChild(ta);
		done();
	}
}

/* ---- progress ----------------------------------------------------------- */

function showProgress() { progressEl.classList.remove("hidden"); }
function hideProgress() {
	progressEl.classList.add("hidden");
	progressEl.classList.remove("indeterminate");
	progressBarEl.style.width = "0";
	progressLabelEl.textContent = "";
}
function setIndeterminate(label) {
	progressEl.classList.remove("hidden");
	progressEl.classList.add("indeterminate");
	progressLabelEl.textContent = label || "";
}
function setDeterminate(pct, label) {
	progressEl.classList.remove("hidden");
	progressEl.classList.remove("indeterminate");
	progressBarEl.style.width = Math.max(0, Math.min(100, pct)) + "%";
	progressLabelEl.textContent = label || "";
}

/* Parse the stderr Nissy prints during table generation / search. Only the
 * pruning-table BFS reports an exact count; other phases are indeterminate. */
function noteProgress(line) {
	var m;
	if ((m = line.match(/Cannot load (\S+), generating it/))) {
		setIndeterminate("Generating " + m[1] + "\u2026");
	} else if ((m = line.match(/Found (\d+) classes/))) {
		setIndeterminate("Found " + m[1] + " symmetry classes\u2026");
	} else if ((m = line.match(/Depth \d+ done, generated \d+\s*\((\d+)\/(\d+)\)/))) {
		var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
		var pct = b ? Math.round((100 * a) / b) : 0;
		setDeterminate(pct, "Generating pruning table\u2026 " + pct + "%");
	} else if (/Pruning table generated!/.test(line)) {
		setIndeterminate("Pruning table generated\u2026");
	} else if ((m = line.match(/Searching depth (\d+)/))) {
		setIndeterminate("Searching\u2026 depth " + m[1]);
	}
}

/* Download progress for streamed tables. The worker reports each 8 MB piece
 * with the offset within the table file and the table's total size. */
var streamBytes = 0;
function handleStream(m) {
	streamBytes += m.len || 0;
	if (m.total) {
		var cur = Math.min((m.off || 0) + (m.len || 0), m.total);
		var pct = Math.round((100 * cur) / m.total);
		setDeterminate(pct, "Downloading " + m.name + "\u2026 " + pct +
		    "%  (" + fmtBytes(streamBytes) + ")");
	} else {
		setIndeterminate("Downloading " + m.name + "\u2026  (" +
		    fmtBytes(streamBytes) + ")");
	}
}

/* ---- UI persistence ----------------------------------------------------- */

var LS_KEY = "nissyweb:ui";
function loadUI() {
	try {
		var s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
		if (!s) return;
		if (s.command) commandEl.value = s.command;
		if (s.step) stepEl.value = s.step;
		if (typeof s.scramble === "string") scrambleEl.value = s.scramble;
		if (typeof s.custom === "string") customEl.value = s.custom;
	} catch (e) { /* ignore */ }
}
function saveUI() {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify({
			command: commandEl.value,
			step: stepEl.value,
			scramble: scrambleEl.value,
			custom: customEl.value
		}));
	} catch (e) { /* ignore */ }
}

/* Split a command line into argv, honouring single and double quotes. */
function tokenize(s) {
	var out = [];
	var cur = "";
	var quote = null;
	var has = false;
	for (var i = 0; i < s.length; i++) {
		var c = s[i];
		if (quote) {
			if (c === quote) quote = null;
			else cur += c;
		} else if (c === '"' || c === "'") {
			quote = c;
			has = true;
		} else if (/\s/.test(c)) {
			if (cur.length || has) {
				out.push(cur);
				cur = "";
				has = false;
			}
		} else {
			cur += c;
		}
	}
	if (cur.length || has) out.push(cur);
	return out;
}

function currentCommand() {
	var value = commandEl.value;
	for (var i = 0; i < COMMANDS.length; i++) {
		if (COMMANDS[i].value === value) return COMMANDS[i];
	}
	return COMMANDS[0];
}

/*
 * Build the argv for the worker. The raw "other command" box wins if filled.
 * The scramble is passed as a single argv token: Nissy's read_scramble
 * concatenates argv tokens and then parses the moves, so this preserves any
 * internal spacing/quotes and avoids shell-style quoting bugs.
 */
function buildArgs() {
	var custom = customEl.value.trim();
	if (custom) return tokenize(custom);

	var spec = currentCommand();
	var args = [spec.value];

	if (spec.step) args.push(stepEl.value);

	if (spec.scramble) {
		var scr = scrambleEl.value.trim();
		if (!scr) {
			appendResult("This command needs a scramble.", "err");
			return null;
		}
		args.push(scr);
	}

	return args;
}

function updateControls() {
	var locked = busy || !ready;
	commandEl.disabled = locked;
	stepEl.disabled = locked;
	scrambleEl.disabled = locked;
	customEl.disabled = locked;
	clearEl.disabled = locked;
	runEl.disabled = locked;
	stopEl.disabled = !busy || saving;
	deleteEl.disabled = locked || (!hasTables && !hasOPFS);
	runEl.textContent = busy ? "Running\u2026" : "Run";
}

function updateStepVisibility() {
	stepWrapEl.style.display = currentCommand().step ? "" : "none";
}

function startTimer() {
	startTime = performance.now();
	timerEl.textContent = "0.0 s";
	if (timerHandle) clearInterval(timerHandle);
	timerHandle = setInterval(function () {
		timerEl.textContent =
			((performance.now() - startTime) / 1000).toFixed(1) + " s";
	}, 100);
}

function stopTimer() {
	if (timerHandle) {
		clearInterval(timerHandle);
		timerHandle = null;
	}
}

function fmtBytes(n) {
	if (!n && n !== 0) return "?";
	var units = ["B", "KB", "MB", "GB", "TB"];
	var i = 0;
	var v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return (i === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + " " + units[i];
}

function refreshCacheUsage() {
	if (!navigator.storage || !navigator.storage.estimate) {
		cacheUsageEl.textContent =
			"Storage estimate unavailable (cached: " +
			((hasTables || hasOPFS) ? "yes" : "no") + ").";
		return;
	}
	navigator.storage
		.estimate()
		.then(function (est) {
			var used = fmtBytes(est.usage || 0);
			var quota = fmtBytes(est.quota || 0);
			cacheUsageEl.textContent =
				"Origin storage: " + used + " used of " + quota +
				((hasTables || hasOPFS) ? " (tables cached)" : " (no cached tables)");
		})
		.catch(function (e) {
			cacheUsageEl.textContent = "Storage estimate failed: " + e;
		});
}

runEl.addEventListener("click", function () {
	if (busy || !ready) return;
	sawResult = false;
	clearResult();
	logEl.textContent = "";
	var args = buildArgs();
	if (args === null) return;
	if (args.length === 0) {
		appendResult("No command to run.", "err");
		return;
	}
	placeholder("Running\u2026");
	appendLog("$ nissy " + args.join(" "));
	justSaved = false;
	saveUI();
	startTimer();
	streamBytes = 0;
	showProgress();
	setIndeterminate("Starting\u2026");
	busy = true;
	updateControls();
	setStatus("Running\u2026");
	worker.postMessage({ type: "run", id: nextId++, args: args });
});

clearEl.addEventListener("click", function () {
	sawResult = false;
	placeholder("Run a command to see the result here.");
	logEl.textContent = "";
	timerEl.textContent = "";
});

commandEl.addEventListener("change", function () {
	updateStepVisibility();
});

copyScrambleEl.addEventListener("click", function () {
	copyText(scrambleEl.value.trim(), copyScrambleEl, "Copied");
});

copyOutEl.addEventListener("click", function () {
	copyText(outEl.innerText, copyOutEl, "Copied");
});

[commandEl, stepEl, scrambleEl, customEl].forEach(function (el) {
	el.addEventListener("input", saveUI);
	el.addEventListener("change", saveUI);
});

if (tableModeEl) {
	tableModeEl.addEventListener("change", function () {
		try { localStorage.setItem("nissyweb:tables", tableModeEl.value); }
		catch (e) { /* ignore */ }
		location.reload();   /* the worker reads the mode at creation */
	});
}

deleteEl.addEventListener("click", function () {
	if (busy || (!hasTables && !hasOPFS)) return;
	deleteCache();
});

function listTableDatabases() {
	if (!indexedDB.databases) {
		return Promise.resolve([IDBFS_DB_NAME]);
	}
	return indexedDB.databases().then(function (dbs) {
		var names = (dbs || [])
			.map(function (d) {
				return d && d.name;
			})
			.filter(function (n) {
				return typeof n === "string" && /\/tables$/.test(n);
			});
		if (names.length === 0) names = [IDBFS_DB_NAME];
		return names;
	});
}

function deleteDatabase(name) {
	return new Promise(function (resolve, reject) {
		var req = indexedDB.deleteDatabase(name);
		req.onsuccess = function () {
			resolve(name);
		};
		req.onerror = function () {
			reject(req.error || new Error("deleteDatabase failed"));
		};
		req.onblocked = function () {
			/* The worker holding the DB was terminated; deletion proceeds
			 * as soon as the connection is released. */
		};
	});
}

/* Remove the streamed-chunk cache from the Origin Private File System. Call
 * only after the worker (which holds the sync access handles) is terminated. */
function deleteOPFS() {
	if (typeof navigator === "undefined" || !navigator.storage ||
	    !navigator.storage.getDirectory)
		return Promise.resolve();
	function attempt(n) {
		return navigator.storage.getDirectory().then(function (root) {
			return root.removeEntry("nissy-tables", { recursive: true });
		}).catch(function (e) {
			if (n < 5)
				return new Promise(function (r) { setTimeout(r, 300); })
				    .then(function () { return attempt(n + 1); });
			return null; /* give up; not fatal */
		});
	}
	return attempt(0);
}

function closeWorkerCache() {
	return new Promise(function (resolve) {
		var settled = false;
		function done() {
			if (settled) return;
			settled = true;
			worker.removeEventListener("message", handler);
			resolve();
		}
		function handler(ev) { if (ev.data && ev.data.type === "cacheClosed") done(); }
		worker.addEventListener("message", handler);
		try { worker.postMessage({ type: "closeCache" }); }
		catch (e) { done(); return; }
		setTimeout(done, 1500);
	});
}

function deleteCache() {
	busy = true;
	updateControls();
	setStatus("Deleting cached tables\u2026");

	/* Have the worker release its OPFS handles, then terminate it (which also
	 * releases the IDBFS connection) before deleting storage. */
	closeWorkerCache()
		.then(function () {
			worker.terminate();
			return listTableDatabases();
		})
		.then(function (names) {
			return Promise.all(
				names.map(function (n) {
					return deleteDatabase(n);
				})
			);
		})
		.then(deleteOPFS)
		.then(function () {
			setStatus("Cache deleted. Reloading\u2026");
			location.reload();
		})
		.catch(function (e) {
			busy = false;
			updateControls();
			setStatus("Failed to delete cache: " + (e && e.message ? e.message : e), "err");
		});
}

function onWorkerMessage(ev) {
	var m = ev.data || {};

	if (m.type === "out") {
		appendResult(m.line);
		return;
	}
	if (m.type === "err") {
		appendLog(m.line);
		noteProgress(m.line);
		return;
	}
	if (m.type === "stream") {
		handleStream(m);
		return;
	}
	if (m.type === "done") {
		stopTimer();
		hideProgress();
		saving = false;
		if (!sawResult) {
			placeholder("(no output \u2014 see the Log below)");
			logBoxEl.open = true;
		}
		var secs = ((performance.now() - startTime) / 1000).toFixed(2);
		busy = false;
		updateControls();
		if (justSaved) {
			setStatus("Done in " + secs + " s \u2014 tables saved to IndexedDB.");
		} else {
			setStatus("Done in " + secs + " s.");
		}
		refreshCacheUsage();
		return;
	}
	if (m.type === "status") {
		handleStatus(m);
	}
};

function handleStatus(m) {
	switch (m.phase) {
		case "loading":
			setStatus(m.message);
			break;
		case "starting":
		case "loading-tables":
			if (!busy) setStatus(m.message || "Starting engine\u2026");
			break;
		case "stream-ready":
			if (!busy) setStatus("Engine ready (" + m.count + " streamed tables).");
			break;
		case "no-stream":
			if (!busy) setStatus(m.message, "warn");
			break;
		case "tables":
			hasTables = !!m.tables;
			updateControls();
			refreshCacheUsage();
			if (busy) break;
			if (!hasTables) {
				setStatus(
					"No cached tables in IndexedDB. If streamed tables are " +
						"configured they load from the network (fast, a few " +
						"seconds to tens of seconds); otherwise Nissy generates " +
						"~590 MB of support tables in wasm on first use (slow).",
					"warn"
				);
			} else {
				setStatus("Cached tables loaded. Runs should be fast.");
			}
			break;
		case "no-idb":
			setStatus(m.message, "warn");
			break;
		case "load-error":
			setStatus(m.message, "err");
			break;
		case "saving":
			saving = true;
			updateControls();
			setStatus("Saving tables to IndexedDB (can take a while)\u2026");
			setIndeterminate("Saving tables to IndexedDB (can take a while)\u2026");
			break;
		case "saved":
			justSaved = true;
			saving = false;
			updateControls();
			setStatus("Tables saved to IndexedDB.");
			refreshCacheUsage();
			break;
		case "save-error":
			saving = false;
			updateControls();
			setStatus(m.message, "err");
			break;
		case "busy":
			setStatus(m.message);
			break;
		case "ready":
			ready = true;
			hasOPFS = !!m.cached;
			updateControls();
			if (m.persisted === false) {
				setStatus("Engine ready (no IndexedDB persistence).", "warn");
			} else if (!/Cached|first run|Loading|tables/.test(statusEl.textContent)) {
				setStatus("Engine ready.");
			}
			refreshCacheUsage();
			break;
		case "fatal":
			ready = false;
			updateControls();
			hideProgress();
			setStatus(m.message, "err");
			break;
	}
}

function onWorkerError(e) {
	ready = false;
	busy = false;
	saving = false;
	updateControls();
	hideProgress();
	setStatus("Worker error: " + (e.message || e), "err");
}

/* Nissy runs a command synchronously in the worker with no cancel hook, so the
 * only way to interrupt is to terminate the worker. Tables already saved to
 * IndexedDB survive, and startWorker() re-mounts them (warm). Any in-progress
 * table generation that has not been saved yet is lost. */
function stopRun() {
	if (!busy) return;
	stopTimer();
	hideProgress();
	busy = false;
	saving = false;
	ready = false;
	sawResult = false;
	placeholder("(stopped)");
	appendLog("[stopped by user]");
	if (worker) {
		worker.terminate();
		worker = null;
	}
	updateControls();
	setStatus("Stopped \u2014 restarting engine\u2026", "warn");
	startWorker();
}

stopEl.addEventListener("click", stopRun);

startWorker();
loadUI();
updateStepVisibility();
updateControls();
refreshCacheUsage();
