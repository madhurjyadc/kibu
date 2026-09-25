import { faceGrid } from './faces.js';

export const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
let paused = motionPreference.matches;
const listeners = new Set();
export const motion = {
  get paused() { return paused; },
  set(value) {
    paused = value;
    document.documentElement.classList.toggle('motion-paused', value);
    document.documentElement.classList.toggle('motion-enabled', !value);
    for (const listener of listeners) listener(value);
  },
  subscribe(listener) { listeners.add(listener); }
};
motionPreference.addEventListener('change', event => motion.set(event.matches));
motion.set(paused);

const accents = { love:'#ff6fa8', kiss:'#ff6fa8', shy:'#ff6fa8', sleepy:'#8fb4ff', thinking:'#8fb4ff', surprised:'#ffb23e', nervous:'#ffb23e', starstruck:'#ffe066' };
const speeds = { working:90, thinking:380, sleepy:900, dance:220, music:420, celebrate:170, sneeze:330, wave:260, laugh:140, proud:320 };
const characters = [];
const pointer = { x:innerWidth/2, y:innerHeight/2 };
document.addEventListener('pointermove', event => { pointer.x=event.clientX; pointer.y=event.clientY; }, { passive:true });
let active = true;
document.addEventListener('visibilitychange', () => { active=!document.hidden; });
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) characters.find(c => c.svg===entry.target).visible=entry.isIntersecting;
});

export class Character {
  constructor(svg) {
    this.svg=svg;
    this.dots=[...svg.querySelectorAll('.kb-dot')];
    this.led=svg.querySelector('.kb-led');
    this.mood='idle'; this.visible=true; this.lastKey='';
    this.nextBlink=performance.now()+2400+Math.random()*2500;
    characters.push(this); observer.observe(svg);
    this.draw(0);
  }
  set(mood) { this.mood=mood; this.lastKey=''; this.draw(performance.now()); }
  draw(now) {
    const rect=this.svg.getBoundingClientRect();
    const look=motion.paused?{x:0,y:0}:{x:Math.max(-1,Math.min(1,(pointer.x-rect.left-rect.width/2)/160)),y:Math.max(-1,Math.min(1,(pointer.y-rect.top-rect.height/2)/150))};
    const blinking=!motion.paused&&now>=this.nextBlink&&now<this.nextBlink+140;
    if(now>this.nextBlink+140)this.nextBlink=now+2600+Math.random()*3800;
    const frame=motion.paused?0:Math.floor(now/(speeds[this.mood]||350));
    const grid=faceGrid(this.mood,frame,look,blinking);
    const key=this.mood+[...grid.entries()].flat().join(',');
    if(key===this.lastKey)return;
    this.lastKey=key;
    const accent=accents[this.mood]||'#d4ff3a';
    this.svg.dataset.mood=this.mood;
    this.led.setAttribute('fill',accent);
    this.dots.forEach((dot,index)=>{
      const cell=grid.get(index);
      dot.setAttribute('fill',cell==='accent'?accent:cell?'#f3f4ef':'#ffffff');
      dot.setAttribute('opacity',cell?'1':'.07');
      dot.setAttribute('r',cell?'2.05':'1.35');
    });
  }
}
// One shared, throttled clock. Hidden and offscreen characters do no work.
setInterval(()=>{if(active&&!motion.paused)for(const c of characters)if(c.visible)c.draw(performance.now());},90);
motion.subscribe(()=>{for(const c of characters){c.lastKey='';c.draw(performance.now());}});

export function animate(element,keyframes,options={}) {
  if(motion.paused)return null;
  const animation=element.animate(keyframes,{duration:550,easing:'cubic-bezier(.2,.8,.2,1)',...options});
  return animation;
}

export function burst(container,x,y,{color='#d4ff3a',hearts=false,count=12}={}) {
  if(motion.paused)return;
  // Keep rapid taps bounded and clean up every particle after its animation.
  if(container.childElementCount>50)return;
  for(let i=0;i<count;i++){
    const particle=document.createElement('span');
    particle.className=hearts?'particle heart':'particle';
    particle.style.left=`${x}px`;particle.style.top=`${y}px`;particle.style.color=color;particle.style.background=hearts?'transparent':color;
    if(hearts)particle.textContent='♥';
    container.append(particle);
    const angle=(Math.PI*2*i/count)-Math.PI/2;
    const distance=40+Math.random()*80;
    const animation=animate(particle,[{transform:'translate(0,0) scale(.5)',opacity:1},{transform:`translate(${Math.cos(angle)*distance}px,${Math.sin(angle)*distance-30}px) rotate(${Math.random()*150}deg) scale(0)`,opacity:0}],{duration:700+Math.random()*450});
    if(animation)animation.finished.catch(()=>{}).finally(()=>particle.remove());else particle.remove();
  }
}
