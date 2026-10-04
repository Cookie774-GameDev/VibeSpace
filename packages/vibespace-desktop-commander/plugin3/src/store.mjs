import {Worker} from 'node:worker_threads';
export function createStore(file){
 const worker=new Worker(new URL('./storage-worker.mjs',import.meta.url),{workerData:{file}}),pending=new Map();let seq=0,dead=false,closing=false,shutdown;
 worker.on('message',m=>{const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);});
 const failed=e=>{dead=true;for(const p of pending.values())p.reject(e);pending.clear();};
 worker.on('error',failed);worker.on('exit',()=>failed(Error('Storage worker exited')));
 const call=(op,ns,key,value)=>new Promise((resolve,reject)=>{if(dead||closing&&op!=='close')return reject(Error('Storage unavailable'));if(pending.size>=256&&op!=='close')return reject(Error('Storage busy'));const id=++seq;pending.set(id,{resolve,reject});worker.postMessage({id,op,ns,key,value});});
 const close=()=>{if(shutdown)return shutdown;if(dead)return Promise.resolve();closing=true;const exited=new Promise(resolve=>worker.once('exit',resolve));shutdown=call('close').then(()=>exited).catch(async error=>{await worker.terminate();throw error;});return shutdown;};
 return {get:(ns,k)=>call('get',ns,k),put:(ns,k,v)=>call('put',ns,k,v),list:ns=>call('list',ns),count:ns=>call('count',ns),delete:(ns,k)=>call('delete',ns,k),close};
}
