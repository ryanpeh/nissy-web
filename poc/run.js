/*
 * Node harness for the Nissy wasm POC.
 *
 *   node run.js [command args...]        # default: solve eofb "R U F"
 *   node run.js solve eofb "R U F"
 *
 * Captures the module's stdout/stderr and prints it.
 */
"use strict";

const path = require("path");

const out = [];

const args = process.argv.slice(2);
const cmd = args.length > 0 ? args : ["solve", "eofb", "R U F"];

const createModule = require(path.join(__dirname, "out", "nissy.js"));

createModule({
  print: (s) => out.push(s),
  printErr: (s) => out.push("[stderr] " + s)
}).then((instance) => {
  out.push("$ nissy " + cmd.join(" "));
  try {
    instance.callMain(cmd);
  } catch (e) {
    // Emscripten throws ExitStatus on exit(); treat that as normal.
    if (!e || e.name !== "ExitStatus") {
      out.push("[exception] " + (e && e.message ? e.message : String(e)));
    }
  }
  process.stdout.write(out.join("\n") + "\n");
  process.exit(0);
}).catch((e) => {
  out.push("[load error] " + (e && e.stack ? e.stack : String(e)));
  process.stdout.write(out.join("\n") + "\n");
  process.exit(1);
});
