// Exact, bounded UTF-8 reads with versioned sparse line checkpoints.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
const MAX_BYTES=4*1024*1024,DEFAULT_BYTES=512*1024,CHUNK=64*1024;
const indexes=new Map();
function integer(v,name,min,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(v)||v<min||v>max)throw new RangeError(`${name} must be an integer between ${min} and ${max}`);return v;}
const stamp=s=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const oversized=()=>new RangeError('Line exceeds bounded read budget. Use options.byteOffset and options.maxBytes, then follow nextByteOffset.');
function cache(file,version){let item=indexes.get(file);if(!item||item.version!==version)item={version,points:new Map([[0,0]])};indexes.delete(file);indexes.set(file,item);while(indexes.size>32)indexes.delete(indexes.keys().next().value);return item;}
function checkpoint(item,line,byte){item.points.set(line,byte);if(item.points.size>4096){for(const key of item.points.keys()){if(key!==0){item.points.delete(key);break;}}}}
async function* scan(file,startByte,signal){
 const stream=createReadStream(file,{start:startByte,highWaterMark:CHUNK,signal});
 let parts=[],size=0,absolute=startByte,pendingCR=false;
 const add=piece=>{if(!piece.length)return;size+=piece.length;if(size>MAX_BYTES)throw oversized();parts.push(piece);};
 const take=nextByte=>{const text=Buffer.concat(parts,size).toString('utf8');parts=[];size=0;return {text,nextByte};};
 try{for await(const chunk of stream){signal?.throwIfAborted();let start=0;
   for(let i=0;i<chunk.length;i++){
     if(pendingCR){pendingCR=false;if(chunk[i]===10){yield take(absolute+i+1);start=i+1;continue;}yield take(absolute+i);start=i;}
     if(chunk[i]===13){add(chunk.subarray(start,i));pendingCR=true;start=i+1;}
     else if(chunk[i]===10){add(chunk.subarray(start,i));yield take(absolute+i+1);start=i+1;}
   }
   add(chunk.subarray(start));absolute+=chunk.length;
 }
 if(pendingCR)yield take(absolute);else if(size)yield take(absolute);
 }finally{stream.destroy();}
}
async function tail(file,n,signal,maxBytes){
 const fd=await fs.open(file,'r');
 try{let position=(await fd.stat()).size,chunks=[],bytes=0,result=[];
  while(position>0){signal?.throwIfAborted();const length=Math.min(CHUNK,position);position-=length;const buf=Buffer.alloc(length);const r=await fd.read(buf,0,length,position);if(r.bytesRead!==length)throw new Error('File changed during read; retry');chunks.unshift(buf);bytes+=length;const text=Buffer.concat(chunks,bytes).toString('utf8');result=text.split(/\r\n|\r|\n/);if(/[\r\n]$/.test(text))result.pop();if(position>0)result.shift();if(result.length>=n||position===0)break;if(bytes>=MAX_BYTES)throw oversized();}
  result=result.slice(-n);if(Buffer.byteLength(result.join('\n'))>maxBytes)throw oversized();return result;
 }finally{await fd.close();}
}
async function bytePage(file,byteOffset,maxBytes,signal){
 const fd=await fs.open(file,'r');
 try{signal?.throwIfAborted();const {size}=await fd.stat();const buf=Buffer.alloc(Math.min(maxBytes+4,Math.max(0,size-byteOffset)));const {bytesRead}=await fd.read(buf,0,buf.length,byteOffset);signal?.throwIfAborted();if(bytesRead&&(buf[0]&0xc0)===0x80)throw new RangeError('byteOffset is inside a UTF-8 character; follow nextByteOffset');let end=Math.min(maxBytes,bytesRead);while(end>0&&end<bytesRead&&(buf[end]&0xc0)===0x80)end--;return {content:buf.subarray(0,end).toString('utf8'),metadata:{byteOffset,nextByteOffset:byteOffset+end,hasMore:byteOffset+end<size,fileSize:size}};
 }finally{await fd.close();}
}
export async function readLargeText(file,options={}){
 const {signal,includeStatusMessage=true}=options;signal?.throwIfAborted();
 const offset=integer(options.offset??0,'offset',-100000),length=integer(options.length??10000,'length',0,100000),maxBytes=integer(options.maxBytes??DEFAULT_BYTES,'maxBytes',1024,MAX_BYTES);
 const before=await fs.stat(file),version=stamp(before);if(options.expectedVersion!==undefined&&options.expectedVersion!==version)throw new Error('File changed since the previous page; re-read from a fresh version');
 let content,metadata,status;
 if(options.byteOffset!==undefined){({content,metadata}=await bytePage(file,integer(options.byteOffset,'byteOffset',0),maxBytes,signal));status=`[UTF-8 byte page; nextByteOffset: ${metadata.nextByteOffset}; hasMore: ${metadata.hasMore}. Continue with options.byteOffset.]`;}
 else if(offset<0){const result=await tail(file,-offset,signal,maxBytes);content=result.join('\n');metadata={linesRead:result.length,hasMore:false};status=`[Reading last ${result.length} lines]`;}
 else{
  const index=cache(file,version);let beginLine=0,beginByte=0;
  for(const [line,byte] of index.points){if(line<=offset&&line>=beginLine){beginLine=line;beginByte=byte;}}
  let number=beginLine,bytes=0,nextByte=beginByte,hasMore=false;const result=[];
  for await(const record of scan(file,beginByte,signal)){
    if(number%1024===0)checkpoint(index,number,nextByte);
    if(number<offset){number++;nextByte=record.nextByte;continue;}
    const added=Buffer.byteLength(record.text)+(result.length?1:0);
    if(result.length===length||bytes+added>maxBytes){if(length>0&&!result.length)throw oversized();hasMore=true;break;}
    result.push(record.text);bytes+=added;number++;nextByte=record.nextByte;
  }
  checkpoint(index,number,nextByte);
  content=result.join('\n');metadata={linesRead:result.length,nextOffset:offset+result.length,nextByteOffset:nextByte,hasMore,scannedFromLine:beginLine};
  status=`[Reading ${result.length} lines from line ${offset}; nextOffset: ${metadata.nextOffset}; hasMore: ${hasMore}]`;
 }
 signal?.throwIfAborted();if(stamp(await fs.stat(file))!==version)throw new Error('File changed during read; retry for a consistent page');
 metadata.version=version;metadata.fileSize=before.size;
 return {content:includeStatusMessage?`${status}\n[version: ${version}]\n\n${content}`:content,mimeType:'text/plain',metadata};
}
