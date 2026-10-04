import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createService} from './service.mjs';
import {schemas} from './contracts.mjs';
import {dataDir,endpoint} from './broker-path.mjs';
import {browserSession,browserObserve} from '../runtime/desktop-commander-v3/dist/tools/browser-session.js';
let service,active=0,ready=false;
const server=net.createServer(socket=>{
 socket.setEncoding('utf8');let buffer='',requests=0;
 socket.on('error',()=>{});
 socket.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>5*1024*1024){socket.destroy();return;}let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);void processLine(line);}});
 async function processLine(line){let id;try{
  const r=JSON.parse(line);id=r.id;for(let i=0;!ready&&i<50;i++)await new Promise(r=>setTimeout(r,100));if(!ready)throw Object.assign(Error('Broker starting'),{code:'STARTING'});
  if(active>=64||requests>=8)throw Object.assign(Error('Queue capacity reached'),{code:'BUSY'});active++;requests++;
  try{let result;if(r.method==='browser_session')result=await browserSession(r.args);else if(r.method==='browser_observe')result=await browserObserve(r.args);else{const schema=schemas[r.method];if(!schema)throw Error('Unknown broker method');result=await service.call(r.method,schema.parse(r.args||{}));}socket.write(JSON.stringify({id,result})+'\n');}
  finally{active--;requests--;}
 }catch(e){socket.write(JSON.stringify({id,error:{code:e.code||(e.name==='ZodError'?'INVALID_ARGUMENT':'BROKER_ERROR'),message:String(e.message).slice(0,2000)}})+'\n');}}
});
server.once('error',e=>{if(e.code!=='EADDRINUSE')console.error('Plugin3 broker failed:',e.code);process.exit(e.code==='EADDRINUSE'?0:1);});
await fs.mkdir(dataDir,{recursive:true});
server.listen(endpoint,async()=>{
 try{service=await createService(dataDir);ready=true;await fs.writeFile(path.join(dataDir,'broker.json'),JSON.stringify({pid:process.pid,endpoint,version:'0.4.5',started_at:new Date().toISOString()},null,2));}
 catch(e){console.error('Plugin3 broker initialization failed:',e.message);process.exit(1);}
});
// A pipe socket is local. Existing No Auth cloud configuration is unchanged.
// Same-user tools are trusted; this is coordination, not a shell sandbox.
