#!/usr/bin/env node
/*
 * Split a large pruning-table file into <100 MB chunks and write a manifest.
 *
 *   node chunk-table.js <file> <outdir> [chunkMB=96]
 *
 * Output: <outdir>/<name>.000, .001, ... and <outdir>/manifest.json with
 * { name, size, chunkSize, count, sha256, chunks:[...] }. The browser loader
 * (streamlib.js) can consume this manifest as Module.nissyStreamTables[name].
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const [, , file, outdir, chunkMBArg] = process.argv;
if (!file || !outdir) {
	console.error("usage: node chunk-table.js <file> <outdir> [chunkMB]");
	process.exit(2);
}
const CHUNK = Math.floor((Number(chunkMBArg) || 96) * 1024 * 1024);
const size = fs.statSync(file).size;
const name = path.basename(file);
fs.mkdirSync(outdir, { recursive: true });

const fd = fs.openSync(file, "r");
const buf = Buffer.allocUnsafe(CHUNK);
const sha = crypto.createHash("sha256");
const chunks = [];
let off = 0, i = 0;
while (off < size) {
	const n = Math.min(CHUNK, size - off);
	let got = 0;
	while (got < n) {
		const r = fs.readSync(fd, buf, got, n - got, off + got);
		if (r <= 0) throw new Error("short read at " + (off + got));
		got += r;
	}
	const part = buf.subarray(0, n);
	sha.update(part);
	const fn = name + "." + String(i).padStart(3, "0");
	fs.writeFileSync(path.join(outdir, fn), part);
	chunks.push(fn);
	off += n;
	i++;
}
fs.closeSync(fd);

const manifest = {
	name: name,
	size: size,
	chunkSize: CHUNK,
	count: chunks.length,
	sha256: sha.digest("hex"),
	chunks: chunks
};
fs.writeFileSync(path.join(outdir, name + ".manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("wrote " + chunks.length + " chunks (" + (size / 1048576).toFixed(1) + " MB) to " + outdir);
console.log("manifest: " + path.join(outdir, name + ".manifest.json"));
