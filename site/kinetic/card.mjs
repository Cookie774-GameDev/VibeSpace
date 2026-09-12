const card=document.querySelector('.kinetic-brand-card');
let canvas=card.querySelector('canvas');
const reduced=matchMedia('(prefers-reduced-motion: reduce)'),START=33;
let draw=null,worker=null,loading=false,ready=false,busy=false,frame=0,last=0,time=START,visible=false,lastPaint=0,bootTimer=0,paintedFrames=0;
const costs=[],pending=new Map(),redraw=[];let sequence=0;
function size(){const rect=canvas.getBoundingClientRect(),scale=Math.min(1.5,devicePixelRatio||1);const width=Math.max(1,Math.min(808,Math.round(rect.width*scale)));return {width,height:Math.round(width*1000/808)}}
function record(cost){costs.push(cost);if(costs.length>240)costs.shift()}
function paint(){
 if(!ready)return Promise.resolve();
 if(busy)return new Promise(resolve=>redraw.push(resolve));
 const dimensions=size();
 if(worker){busy=true;const id=++sequence;return new Promise(resolve=>{pending.set(id,resolve);worker.postMessage({type:'draw',id,time,...dimensions})})}
 const begin=performance.now();
 if(canvas.width!==dimensions.width||canvas.height!==dimensions.height){canvas.width=dimensions.width;canvas.height=dimensions.height;draw(-1)}
 draw(time);record(performance.now()-begin);return Promise.resolve();
}
function tick(stamp){
 frame=0;if(!visible||document.hidden||reduced.matches||!ready)return;
 // Avoid catch-up jumps after blocked browser frames and never queue worker frames.
 time+=Math.min(50,Math.max(0,stamp-last))/1000;last=stamp;
 if(stamp-lastPaint>=1000/60-.5&&!busy){lastPaint=stamp;paint()}
 frame=requestAnimationFrame(tick);
}
function sync(){cancelAnimationFrame(frame);frame=0;last=performance.now();const active=visible&&!document.hidden&&!reduced.matches&&ready;if(worker&&ready){worker.postMessage({type:'active',active});return}if(active)frame=requestAnimationFrame(tick)}
function activate(){clearTimeout(bootTimer);ready=true;time=reduced.matches?37:START;card.dataset.ready='true';paint().then(sync)}
async function fallback(){
 clearTimeout(bootTimer);worker?.terminate();worker=null;busy=false;for(const resolve of pending.values())resolve();pending.clear();
 const replacement=canvas.cloneNode(false);canvas.replaceWith(replacement);canvas=replacement;watch.disconnect();watch.observe(canvas);
 try{const {createMapleV}=await import('./maple-v.mjs?v=20260912-r24');draw=createMapleV(canvas,{ink:'#eee9dd',transparent:true});card.dataset.renderer='main-fallback';activate()}catch{card.dataset.ready='error'}
}
function load(){
 if(loading)return;loading=true;
 if(!canvas.transferControlToOffscreen||typeof Worker==='undefined'){fallback();return}
 try{
  worker=new Worker(new URL('./worker.mjs?v=20260912-r24',import.meta.url),{type:'module'});
  bootTimer=setTimeout(fallback,10000);
  worker.onerror=()=>fallback();
  worker.onmessage=({data})=>{
   if(data.type==='boot'){const offscreen=canvas.transferControlToOffscreen();worker.postMessage({type:'init',canvas:offscreen},[offscreen]);return}
   if(data.type==='ready'){card.dataset.renderer='worker';activate();return}
   if(data.type==='progress'){time=data.time;paintedFrames=data.frames;Object.assign(canvas.dataset,data.state);record(data.cost);return} if(data.type==='painted'){busy=false;Object.assign(canvas.dataset,data.state);record(data.cost);pending.get(data.id)?.();pending.delete(data.id);if(redraw.length){const waiting=redraw.splice(0);paint().then(()=>waiting.forEach(resolve=>resolve()))}}
  };
 }catch{fallback()}
}
// Preload early; advance only when the actual letter canvas is visible.
const preload=new IntersectionObserver(([entry])=>{if(entry.isIntersecting)load()},{rootMargin:'600px'});preload.observe(card);
const watch=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting&&entry.intersectionRatio>=.2;if(visible)load();sync()},{threshold:[0,.2]});watch.observe(canvas);
const sizes=new ResizeObserver(()=>{if(ready)paint()});sizes.observe(card);
document.addEventListener('visibilitychange',sync);
reduced.addEventListener('change',()=>{if(reduced.matches){time=37;paint()}sync()});
window.addEventListener('pagehide',()=>{cancelAnimationFrame(frame);frame=0;worker?.postMessage({type:'active',active:false})});window.addEventListener('pageshow',sync);
window.__kineticCard={get frames(){return paintedFrames},get time(){return time},seek(t){time=t;return paint()},get renderCosts(){return [...costs]},get ready(){return ready}};
