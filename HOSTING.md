# Hosting the table chunks

> **Hosted at:** `https://raw.githubusercontent.com/ryanpeh/nissy-web/tables/`
> (branch `tables` of `ryanpeh/nissy-web`). The app tries this first, then a
> same-origin `/dist-tables/`. Verified end-to-end: the app downloaded the 3 GB
> from raw and solved `R U F` optimally (`F' U' R' (3)`) in ~347 s (download-bound).

`lightplus/package-tables.sh` turns the generated tables into a set of files the
browser loader (`lightplus/src/streamlib.js`) fetches:

```
dist-tables/
├── index.json                     # { chunkBase, tables:[...] }
├── pt_nxopt31_HTM.manifest.json   # { name, size, chunkSize, sha256, chunks:[...] }
├── pt_nxopt31_HTM.000 … .024      # 96 MB chunks of the 2.30 GiB table
├── pt_drud_sym16_HTM.* , pt_corners_HTM.*
└── invtables.* , mtables.* , ttables.* , symc_moves.* , symc_trans.* , sd_*.*
```

10 tables, 39 chunks, ~2.97 GB. **Every file must be served with:**

- `Access-Control-Allow-Origin` (so the page can read it), and
- HTTP `Range` support (the loader reads 8 MB pieces within each chunk).

`index.json`'s `chunkBase` is the URL prefix prepended to each chunk filename.
It is **empty** for same-origin hosting (e.g. the demo, where `serve.js` serves
the repo root). For remote hosting set it:

```sh
cd lightplus
./set-chunkbase.sh https://raw.githubusercontent.com/<user>/<repo>/tables/
```

## Option A — GitHub raw (a dedicated branch or repo)

`raw.githubusercontent.com` sends `access-control-allow-origin: *` and
`accept-ranges: bytes`.

1. Create an orphan branch (so the ~3 GB stays out of your code history):
   ```sh
   cd /tmp && git init tables && cd tables
   cp -R /path/to/nissy-web/dist-tables/. .
   git add -A && git commit -m "Nissy optimal tables"
   git branch -M tables
   git remote add origin git@github.com:<user>/<repo>.git
   git push origin tables
   ```
2. Set the base: `./set-chunkbase.sh https://raw.githubusercontent.com/<user>/<repo>/tables/`
3. Verify:
   ```sh
   curl -sIL -H "Origin: https://example.com" \
     "https://raw.githubusercontent.com/<user>/<repo>/tables/pt_nxopt31_HTM.manifest.json" \
     | grep -i 'access-control\|accept-ranges'
   ```
   Note: GitHub recommends repos under ~1 GB and the chunks are each <100 MB, so
   this is allowed but heavy; prefer Option B if you can.

## Option B — object storage (R2 / B2 / S3)

Better for ~3 GB. Upload `dist-tables/` and configure CORS to allow `GET` (and
the `Range` header) from your site's origin, e.g. for Cloudflare R2:

```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://<your-site></AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedHeader>Range</AllowedHeader>
    <ExposeHeader>Content-Range,Content-Length,Accept-Ranges</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

Then `./set-chunkbase.sh https://<bucket>.<account>.r2.cloudflarestorage.com/tables/`
(or your custom domain).

## Consuming it in the app

The worker does:

1. `fetch(chunkBase + "index.json")`
2. for each `name` in `tables`: `fetch(chunkBase + name + ".manifest.json")`, and
   prefixes each entry in `chunks` with `chunkBase`
3. `createNissy({ nissyStreamTables: { name: manifest, ... }, ... })`

See `web/nissy-worker.js` (main app) and `lightplus/web/nissy-worker.js` (demo).


## Local test (no upload)

For a quick local run, serve the repo root (so `/dist-tables/` is reachable)
and open the app at `/web/`:

```sh
cd nissy-web/lightplus/web && node serve.js   # serves the nissy-web root on :8792
# open http://localhost:8792/web/   -> choose the "optimal" step
```

The main app reads its table base from `STREAM_INDEX` in `web/nissy-worker.js`
(default `/dist-tables/index.json`, i.e. same-origin). For production, set it to
the hosted `index.json`, e.g.
`https://raw.githubusercontent.com/<user>/<repo>/tables/index.json`, or set
`index.json`'s `chunkBase` if only the chunks live elsewhere.
