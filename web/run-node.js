/*
 * Node harness for the Phase 1 Nissy wasm build.
 *
 * Runs the same module the browser worker uses, but without a Worker or
 * IndexedDB. By default tables are regenerated into MEMFS on every run (slow:
 * several minutes). Pass --persist DIR to mount NODEFS at /tables instead, so
 * generated tables survive between runs (fast after the first generation).
 *
 * Usage:
 *   node web/run-node.js solve eofb "R U F"
 *   node web/run-node.js version
 *   node web/run-node.js --persist web/.tables-node solve eofb "R U F"
 *
 * Output on stdout is the program's stdout; stderr lines are prefixed.
 */
"use strict";

const fs = require("fs");
const path = require("path");

let persistDir = null;
const args = [];
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === "--persist") {
		persistDir = process.argv[++i];
	} else if (a === "--") {
		for (let j = i + 1; j < process.argv.length; j++) args.push(process.argv[j]);
		break;
	} else {
		args.push(a);
	}
}

if (args.length === 0) {
	args.push("solve", "eofb", "R U F");
}

const createNissy = require(path.join(__dirname, "out", "nissy.js"));

const lineOut = (s) => process.stdout.write(s + "\n");
const lineErr = (s) => process.stdout.write("[stderr] " + s + "\n");

createNissy({
	print: lineOut,
	printErr: lineErr,
}).then((instance) => {
	const FS = instance.FS;

	// Mount the table directory at /tables. Upstream normally derives it from
	// HOME; web/nissy_env_override.c pins it to /tables via NISSYDATA=/.
	try {
		FS.mkdir("/tables");
	} catch (e) {
		/* already exists */
	}

	let mounted = false;
	if (persistDir) {
		const root = path.resolve(persistDir);
		fs.mkdirSync(root, { recursive: true });
		if (FS.filesystems && FS.filesystems.NODEFS) {
			FS.mount(FS.filesystems.NODEFS, { root }, "/tables");
			mounted = true;
			lineErr("mounted NODEFS at /tables -> " + root);
		} else {
			lineErr("NODEFS not available; falling back to MEMFS");
		}
	}
	if (!mounted) {
		lineErr("using MEMFS at /tables (tables will not persist)");
	}

	lineOut("$ nissy " + args.join(" "));
	try {
		instance.callMain(args);
	} catch (e) {
		// Emscripten throws ExitStatus on exit(); treat that as normal.
		if (!e || e.name !== "ExitStatus") {
			lineErr("[exception] " + (e && e.message ? e.message : String(e)));
			process.exitCode = 1;
		}
	}
	process.exit(process.exitCode || 0);
}).catch((e) => {
	lineErr("[load error] " + (e && e.stack ? e.stack : String(e)));
	process.exit(1);
});
