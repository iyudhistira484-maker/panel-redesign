import { readdirSync,readFileSync } from 'node:fs';
import {gzipSync} from 'node:zlib';
const assets = readdirSync('dist/assets').map(name=>({name,data:readFileSync(`dist/assets/${name}`)}));
const js=assets.filter(a=>a.name.endsWith('.js')).reduce((sum,a)=>sum+gzipSync(a.data).length,0);
const page=assets.reduce((sum,a)=>sum+(a.name.endsWith('.woff2')?a.data.length:gzipSync(a.data).length),gzipSync(readFileSync('dist/index.html')).length);
console.log(`JS: ${js}/85000 B gzip; total shell: ${page}/225000 B (bundle gzip + fonts)`);
if(js>85000||page>225000) process.exitCode=1;
