const section=document.querySelector('.ecosystem');
if(section){
 section.dataset.enhanced='true';
 const track=section.querySelector('.ecosystem-track'),group=section.querySelector('.ecosystem-group'),button=section.querySelector('[data-ecosystem-pause]'),status=section.querySelector('[data-ecosystem-status]'),reduce=matchMedia('(prefers-reduced-motion: reduce)');
 const duplicate=group.cloneNode(true);duplicate.setAttribute('aria-hidden','true');duplicate.setAttribute('inert','');duplicate.removeAttribute('aria-label');track.append(duplicate);
 let visible=false,paused=false;
 function sync(){const running=visible&&!document.hidden&&!paused&&!reduce.matches;section.dataset.running=String(running);button.hidden=reduce.matches;button.setAttribute('aria-pressed',String(paused));button.textContent=paused?'Resume motion':'Pause motion';status.textContent=reduce.matches?'SWIPE TO EXPLORE':paused?'MOTION PAUSED':'MOVING AUTOMATICALLY'}
 function resize(){const seconds=group.getBoundingClientRect().width/42;track.style.setProperty('--ecosystem-duration',`${seconds}s`)}
 const observer=new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;document.body.classList.toggle("ecosystem-visible",visible);sync()});observer.observe(section);
 const sizes=new ResizeObserver(resize);sizes.observe(group);resize();
 button.addEventListener('click',()=>{paused=!paused;sync()});document.addEventListener('visibilitychange',sync);reduce.addEventListener('change',sync);sync();
 window.addEventListener('pagehide',()=>{section.dataset.running='false'});window.addEventListener('pageshow',sync);
}
