const card=document.querySelector('.kinetic-brand-card'),canvas=card.querySelector('canvas'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
let draw=null,loading=null,frame=0,last=0,time=33,visible=false,costs=[];
function paint(){const begin=performance.now();draw(time);costs.push(performance.now()-begin);if(costs.length>240)costs.shift()}
function tick(stamp){frame=0;if(!visible||document.hidden||reduced.matches||!draw)return;time+=(stamp-last)/1000;last=stamp;paint();frame=requestAnimationFrame(tick)}
function sync(){cancelAnimationFrame(frame);frame=0;if(visible&&!document.hidden&&!reduced.matches&&draw){last=performance.now();frame=requestAnimationFrame(tick)}}
function resize(){const rect=canvas.getBoundingClientRect(),scale=Math.min(1.5,devicePixelRatio||1);const width=Math.max(1,Math.min(808,Math.round(rect.width*scale)));canvas.width=width;canvas.height=Math.round(width*1000/808);if(draw){const t=time;draw(-1);draw(t)}}
async function load(){if(!loading)loading=import('./maple-v.mjs').then(({createMapleV})=>{resize();draw=createMapleV(canvas,{ink:'#eee9dd',transparent:true});if(reduced.matches)time=37;paint();card.dataset.ready='true';sync()}).catch(()=>{card.dataset.ready='error'});return loading}
const observer=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;if(visible)load();sync()},{threshold:0});observer.observe(card);
const sizes=new ResizeObserver(resize);sizes.observe(card);
document.addEventListener('visibilitychange',sync);reduced.addEventListener('change',()=>{if(reduced.matches&&draw){time=37;paint()}sync()});
window.addEventListener('pagehide',()=>{cancelAnimationFrame(frame);frame=0});window.addEventListener('pageshow',sync);
window.__kineticCard={get time(){return time},seek(t){time=t;draw?.(t)},get renderCosts(){return [...costs]},get ready(){return !!draw}};
