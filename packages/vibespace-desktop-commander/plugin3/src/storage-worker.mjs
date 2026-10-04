import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(workerData.file);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(ns TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(ns,id));');
const get=db.prepare('SELECT value FROM records WHERE ns=? AND id=?');
const put=db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(ns,id) DO UPDATE SET value=excluded.value');
parentPort.on('message',({id,op,ns,key,value})=>{
 try{
  let result;
  if(op==='close'){db.close();parentPort.postMessage({id,result:true});parentPort.close();return;}
  if(op==='get'){const r=get.get(ns,key);result=r?JSON.parse(r.value):null;}
  else if(op==='put'){put.run(ns,key,JSON.stringify(value));result=true;}
  else if(op==='list')result=db.prepare('SELECT value FROM records WHERE ns=? ORDER BY id LIMIT 10000').all(ns).map(r=>JSON.parse(r.value));
  else if(op==='count')result=db.prepare('SELECT count(*) AS n FROM records WHERE ns=?').get(ns).n;
  else if(op==='delete'){db.prepare('DELETE FROM records WHERE ns=? AND id=?').run(ns,key);result=true;}
  else throw Error('Invalid storage operation');
  parentPort.postMessage({id,result});
 }catch(e){parentPort.postMessage({id,error:e.message});}
});
