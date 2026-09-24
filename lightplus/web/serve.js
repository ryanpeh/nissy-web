/* Tiny static server with HTTP Range support (required by the streaming loader). */
const http=require("http"),fs=require("fs"),path=require("path");
const ROOT="/Users/ryanpeh/Documents/Programming/nissy/nissy-web";
const PORT=8792;
http.createServer((req,res)=>{
  let url=decodeURIComponent(req.url.split("?")[0]);
  let f=path.join(ROOT,url);
  if(url.endsWith("/")) f=path.join(f,"index.html");
  fs.stat(f,(e,st)=>{
    if(e||!st.isFile()){ res.writeHead(404); res.end("not found"); return; }
    const type=f.endsWith(".html")?"text/html":f.endsWith(".js")?"text/javascript":"application/octet-stream";
    const range=req.headers.range;
    if(range){
      const m=/bytes=(\d+)-(\d*)/.exec(range); const start=+m[1]; const end=m[2]?+m[2]:st.size-1;
      res.writeHead(206,{"Content-Range":`bytes ${start}-${end}/${st.size}`,"Accept-Ranges":"bytes","Content-Length":end-start+1,"Content-Type":type,"Cache-Control":"no-store"});
      fs.createReadStream(f,{start,end}).pipe(res);
    } else {
      res.writeHead(200,{"Content-Length":st.size,"Accept-Ranges":"bytes","Content-Type":type,"Cache-Control":"no-store"});
      fs.createReadStream(f).pipe(res);
    }
  });
}).listen(PORT,()=>console.log("serving "+ROOT+" on http://localhost:"+PORT+"/lightplus/web/"));
