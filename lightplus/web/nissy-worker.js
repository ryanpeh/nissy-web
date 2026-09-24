/* Demo worker: streaming loader, chunked sources from per-table manifests. */
importScripts("out/nissy.js");

var instance = null, ready = false, currentId = null, pending = [];
var NAMES = ["pt_nxopt31_HTM","pt_corners_HTM","pt_drud_sym16_HTM","invtables","mtables","ttables","symc_moves","symc_trans","sd_cp_16_new","sd_eofbepos_16_new"];
var PREFIX = "/dist-tables/";

function post(m){ self.postMessage(m); }
function emit(t,l){ post({ id: currentId, type: t, line: l }); }

function loadManifests() {
  return Promise.all(NAMES.map(function (n) {
    return fetch(PREFIX + n + ".manifest.json").then(function (r) {
      if (!r.ok) throw new Error("manifest " + n + ": HTTP " + r.status);
      return r.json();
    }).then(function (m) {
      m.chunks = m.chunks.map(function (c) { return PREFIX + c; });
      return [n, m];
    });
  })).then(function (pairs) {
    var map = {};
    pairs.forEach(function (p) { map[p[0]] = p[1]; });
    return map;
  });
}

loadManifests().then(function (tables) {
  return createNissy({
    locateFile: function (p) { return "out/" + p; },
    nissyStreamTables: tables,
    nissyStreamLog: function (name, off, len) { post({ type: "stream", name: name, off: off, len: len }); },
    print:    function (l) { emit("out", String(l)); },
    printErr: function (l) { emit("err", String(l)); }
  });
}).then(function (m) {
  instance = m; ready = true; post({ type: "ready" });
  pending.splice(0).forEach(run);
}).catch(function (e) {
  post({ type: "fatal", message: String(e && e.stack || e) });
});

function run(msg) {
  currentId = msg.id;
  try { instance.callMain(msg.args); }
  catch (e) { if (!e || e.name !== "ExitStatus") emit("err", "[exception] " + e); }
  post({ id: currentId, type: "done" });
  currentId = null;
}
self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || msg.type !== "run") return;
  if (!ready) { pending.push(msg); return; }
  run(msg);
};
