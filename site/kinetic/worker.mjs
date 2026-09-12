import {createGlyphBatch} from './gpu.mjs?v=20260912-r24';
import {createMapleV} from './maple-v.mjs?v=20260912-r24';
let canvas,draw,batch,active=false,frame=null,last=0,time=33,lastPaint=0,lastReport=0,frames=0;
const schedule=typeof self.requestAnimationFrame==='function'?cb=>self.requestAnimationFrame(cb):cb=>setTimeout(()=>cb(performance.now()),16);
const cancel=typeof self.cancelAnimationFrame==='function'?id=>self.cancelAnimationFrame(id):clearTimeout;
function render(){const begin=performance.now();draw(time);batch?.flush();frames++;return performance.now()-begin}
function tick(stamp){
 frame=null;if(!active)return;
 time+=Math.min(50,Math.max(0,stamp-last))/1000;last=stamp;
 if(stamp-lastPaint>=1000/60-.5){const cost=render();lastPaint=stamp;if(stamp-lastReport>=100){lastReport=stamp;self.postMessage({type:'progress',time,frames,state:canvas.dataset,cost})}}
 frame=schedule(tick);
}
function sync(){if(frame!==null)cancel(frame);frame=null;last=performance.now();if(active)frame=schedule(tick)}
self.onmessage=({data})=>{
 if(data.type==='init'){canvas=data.canvas;canvas.dataset={};batch=createGlyphBatch(canvas);canvas.dataset.backend=batch?'webgl2':'canvas2d';draw=createMapleV(batch?.surface??canvas,{ink:'#eee9dd',transparent:true});self.postMessage({type:'ready'});return}
 if(data.type==='active'){active=data.active;sync();return}
 if(data.type==='draw'){
  const begin=performance.now();
  if(canvas.width!==data.width||canvas.height!==data.height){canvas.width=data.width;canvas.height=data.height;draw(-1)}
  time=data.time;draw(time);batch?.flush();last=performance.now();
  self.postMessage({type:'painted',id:data.id,state:canvas.dataset,cost:performance.now()-begin});
 }
};
self.postMessage({type:'boot'});
