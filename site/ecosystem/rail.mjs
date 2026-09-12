const section=document.querySelector('.ecosystem');
if(section){
 section.dataset.enhanced='true';
 const track=section.querySelector('.ecosystem-track'),group=section.querySelector('.ecosystem-group'),reduce=matchMedia('(prefers-reduced-motion: reduce)');
 const duplicate=group.cloneNode(true);duplicate.setAttribute('aria-hidden','true');duplicate.removeAttribute('aria-label');track.append(duplicate);
 let visible=false,hovered=false;
 function sync(){const running=visible&&!document.hidden&&!hovered&&!reduce.matches;section.dataset.running=String(running)}
 function resize(){const seconds=group.getBoundingClientRect().width/42;track.style.setProperty('--ecosystem-duration',`${seconds}s`)}
 const observer=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;document.body.classList.toggle("ecosystem-visible",visible);sync()});observer.observe(section);
 track.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse'||e.pointerType==='pen'){hovered=true;sync()}});track.addEventListener('pointerleave',()=>{hovered=false;sync()});
 const sizes=new ResizeObserver(resize);sizes.observe(group);resize();
 document.addEventListener('visibilitychange',sync);reduce.addEventListener('change',sync);sync();
 window.addEventListener('pagehide',()=>{section.dataset.running='false'});window.addEventListener('pageshow',sync);
}

