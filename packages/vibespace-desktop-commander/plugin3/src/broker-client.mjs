import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {endpoint} from './broker-path.mjs';
let connection,connecting;
const pending=new Map();
function connectOnce(){return new Promise((resolve,reject)=>{
 const s=net.createConnection(endpoint);s.setEncoding('utf8');let buf='';
 s.once('connect',()=>{connection=s;resolve(s);});s.once('error',reject);
 s.on('data',chunk=>{buf+=chunk;if(Buffer.byteLength(buf)>12*1024*1024){s.destroy(Error('Response limit'));return;}let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);try{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Object.assign(Error(m.error.message),{code:m.error.code})):p.resolve(m.result);}}catch{s.destroy();}}});
 s.on('close',()=>{if(connection===s)connection=null;for(const [id,p]of pending){if(p.socket===s){clearTimeout(p.timer);p.reject(Object.assign(Error('Connection lost; do not replay mutations. Inspect recorded operation/session/job state.'),{code:'UNCERTAIN_TRANSPORT'}));pending.delete(id);}}});
 s.on('error',()=>{});
});}
async function connect(){
 if(connection&&!connection.destroyed)return connection;if(connecting)return connecting;
 connecting=(async()=>{try{return await connectOnce();}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;const p=spawn(process.execPath,[fileURLToPath(new URL('./broker.mjs',import.meta.url))],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,DESKTOP_COMMANDER_DISABLE_TELEMETRY:'1'}});p.unref();
  for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,100));try{return await connectOnce();}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}}throw Error('Shared service did not start');}
 })().finally(()=>{connecting=null;});return connecting;
}
export async function brokerCall(method,args={}){
 const socket=await connect(),id=randomUUID();
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Object.assign(Error('Tool deadline exceeded; inspect state before retrying a mutation'),{code:'UNCERTAIN_TIMEOUT'}));},Math.max(35000,(args.wait_ms||0)+10000,(args.timeout_ms||0)+5000));pending.set(id,{resolve,reject,timer,socket});socket.write(JSON.stringify({id,method,args})+'\n');});
}
export function disconnectBroker(){connection?.destroy();connection=null;}
export async function serviceTool(name,args){try{const result=await brokerCall(name,args);if(name==='browser_session'||name==='browser_observe')return result;return {isError:name==='native_patch'&&(result.success===false||['failed','uncertain'].includes(result.state)),content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};}catch(e){const error={code:e.code||'SERVICE_ERROR',error:e.message,replaySafe:false};return {isError:true,content:[{type:'text',text:JSON.stringify(error)}],structuredContent:error};}}
