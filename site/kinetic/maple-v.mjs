// Fixed glyph grid with source-measured organic density; no orbital particles.
const smooth=x=>{x=Math.max(0,Math.min(1,x));return x*x*x*(x*(x*6-15)+10)};
const mix=(a,b,t)=>a+(b-a)*t;
let field=null;
try{const r=await fetch(new URL('./maple-field.json',import.meta.url));if(!r.ok)throw Error('field');field=await r.json();field.frames=field.frames.map(s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)))}catch{/* A procedural field keeps the scene usable if the data asset is unavailable. */}
// Read the cream mark from the actual website asset. The substantial connected
// components exclude sparkles and preserve both separated logo strokes.
const makeCanvas=()=>typeof document!=='undefined'?document.createElement('canvas'):new OffscreenCanvas(1,1);
let logoPoints=[];
try{
 const image=await createImageBitmap(await (await fetch(new URL('./assets/vibespace-logo.png',import.meta.url))).blob());
 const c=makeCanvas();c.width=image.width;c.height=image.height;const a=c.getContext('2d');a.drawImage(image,0,0);
 const pixels=a.getImageData(0,0,c.width,c.height).data,mask=new Uint8Array(c.width*c.height);
 for(let i=0;i<mask.length;i++)mask[i]=pixels[i*4]>225&&pixels[i*4+1]>205&&pixels[i*4+2]>155&&pixels[i*4+3]>100?1:0;
 let largest=[];const components=[];
 for(let i=0;i<mask.length;i++){if(!mask[i])continue;const component=[],stack=[i];mask[i]=0;while(stack.length){const n=stack.pop();component.push(n);const x=n%c.width,y=Math.floor(n/c.width);for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const xx=x+dx,yy=y+dy,j=yy*c.width+xx;if(xx>=0&&xx<c.width&&yy>=0&&yy<c.height&&mask[j]){mask[j]=0;stack.push(j)}}}components.push(component);if(component.length>largest.length)largest=component;}
 logoPoints=components.filter(c=>c.length>=largest.length*.1).flat().map(i=>({x:i%c.width,y:Math.floor(i/c.width)})).sort((a,b)=>a.y-b.y||a.x-b.x);
}catch{/* Controls remain usable if the local logo asset cannot load. */}
export function createMapleV(canvas,{blue=false,ink="#eee9dd",transparent=false}={}){
 const ctx=canvas.getContext('2d'),w=808,h=1000,step=16,cols=Math.ceil(w/step),rows=Math.ceil(h/step),letters='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/+';
 const atlas=[...letters].map(g=>{const c=makeCanvas();c.width=16;c.height=18;const a=c.getContext('2d');a.font='11px monospace';a.textAlign='center';a.textBaseline='middle';a.fillStyle=ink;a.fillText(g,8,9);return c});
 function source(t){
  const st=field?(1-Math.cos(t*Math.PI/(field.duration*1.5)))*.5*(field.frames.length-1):0,index=Math.floor(st),fraction=st-index,result=[];
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
   const x=col*step+8,y=row*step+8,nx=x/w,ny=y/h,i=row*cols+col;let density;
   if(field){const j=Math.min(field.rows-1,Math.floor(ny*field.rows))*field.cols+Math.min(col,field.cols-1);density=mix(field.frames[index][j],field.frames[Math.min(index+1,field.frames.length-1)][j],fraction)/255}
   else{const wave=Math.sin(nx*9+t*.13+Math.cos(ny*7-t*.08))+Math.cos(ny*10-t*.16+Math.sin(nx*6+t*.11));density=smooth((wave+.2)/.7)}
   if(density<.02)continue;
   result.push({id:i,x,y,character:(i*13+Math.floor(i/17))%letters.length,alpha:density*(blue?.95:.66+(i%5)*.07)});
  }return result;
 }
 let snapshotCycle=-1,snapshot=[],last=-1,lastActive=[],lastAmount=0,lastTransport=false;
 // Materialize inspection data only on request, not thousands of objects per frame.
 Object.defineProperty(canvas,'__letterPositions',{configurable:true,get(){return lastActive.map(p=>({id:p.id,char:letters[p.character],alpha:p.alpha,x:lastTransport?mix(p.x,p.tx,lastAmount)+Math.sin(Math.PI*lastAmount)*p.bend:p.x,y:lastTransport?mix(p.y,p.ty,lastAmount):p.y}))}});
 function assign(cycle){
  snapshot=source(cycle*3+3);
  if(logoPoints.length){
   const xs=logoPoints.map(p=>p.x),ys=logoPoints.map(p=>p.y),minX=Math.min(...xs),minY=Math.min(...ys),lw=Math.max(...xs)-minX,lh=Math.max(...ys)-minY;
   const scale=Math.min(w*.77/lw,h*.69/lh),ox=(w-lw*scale)/2,oy=(h-lh*scale)/2;
   const ordered=[...snapshot].sort((a,b)=>a.y-b.y||a.x-b.x);
   ordered.forEach((p,i)=>{const target=logoPoints[Math.min(logoPoints.length-1,Math.floor((i+.5)*logoPoints.length/ordered.length))];p.tx=ox+(target.x-minX)*scale;p.ty=oy+(target.y-minY)*scale;});
  }else for(const right of [false,true]){
   const group=snapshot.filter(p=>(p.x>=w*.5)===right).sort((a,b)=>a.y-b.y||a.x-b.x);
   const columns=Math.max(4,Math.round(Math.sqrt(group.length*.13*w/(h*.66)))),nrows=Math.ceil(group.length/columns);
   group.forEach((p,i)=>{
    const row=Math.floor(i/columns),col=i%columns,u=row/Math.max(1,nrows-1),width=mix(.145,.075,u);
    p.tx=w*(mix(right?.80:.20,right?.525:.475,u)+(col/(columns-1)-.5)*width);
    p.ty=h*(.16+.66*u);
   });
  }for(const p of snapshot)p.bend=Math.sin(p.id*1.7)*12;snapshotCycle=cycle;
 }
 return time=>{
  if(time===last)return;last=time;
  const cycle=Math.floor(Math.max(0,time)/71),clock=((time%71)+71)%71;
  const amount=clock<3?0:Math.sin(Math.PI*(clock-3)/68)**2,transport=clock>=3;
  if(snapshotCycle!==cycle)assign(cycle);
  const organicTime=cycle*3+Math.min(clock,3);
  const active=transport?snapshot:source(organicTime);
  ctx.setTransform(canvas.width/w,0,0,canvas.height/h,0,0);
  ctx.globalAlpha=1;if(transparent)ctx.clearRect(0,0,w,h);else{ctx.fillStyle=blue?'#0846f5':'#000';ctx.fillRect(0,0,w,h);}
  lastActive=active;lastAmount=amount;lastTransport=transport;
  const bendAmount=Math.sin(Math.PI*amount);
  for(const p of active){
   // Move the very same glyph. Its identity, size and opacity never change
   // during the entire outward and return journey; no V layer is drawn.
   const bend=transport?bendAmount*p.bend:0;
   const x=transport?mix(p.x,p.tx,amount)+bend:p.x,y=transport?mix(p.y,p.ty,amount):p.y;
   ctx.globalAlpha=p.alpha;ctx.drawImage(atlas[p.character],x-8,y-9);
  }
  ctx.globalAlpha=1;
  canvas.dataset.phase=amount>.999?'formed':clock<3?'flowing':clock<37?'assembling':'dispersing';
  canvas.dataset.formation=amount.toFixed(5);canvas.dataset.cycle='71';canvas.dataset.field=field?'source-measured':'fallback';canvas.dataset.logo=logoPoints.length?'official-website-asset':'fallback';
 };
}


