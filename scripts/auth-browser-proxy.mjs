// Disposable loopback HTTPS termination; keep the browser's origin unchanged.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';

const [certPath,keyPath,apiPort = "3200"]=process.argv.slice(2);
createServer({cert:readFileSync(certPath),key:readFileSync(keyPath)}, (req,res)=>{
  const path=req.url;
  if(!path?.startsWith('/') || path.startsWith('//')) {res.writeHead(400).end();return;}
  const upstream=request({hostname:'127.0.0.1',port:path.startsWith('/api/')?Number(apiPort):4173,path,method:req.method,headers:{...req.headers,host:'127.0.0.1'}}, reply=>{
    res.writeHead(reply.statusCode??502,reply.headers);
    reply.pipe(res);
  });
  upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
  req.on('aborted',()=>upstream.destroy());
  res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
  req.pipe(upstream);
}).listen(4443,'127.0.0.1');
