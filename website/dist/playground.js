import { Character, motion, animate, burst } from './character.js';

export function initPlayground() {
  const $=selector=>document.querySelector(selector);
  const yard=$('#play-yard'), wrap=$('#play-character'), pet=$('#play-pet');
  const svg=$('#play-face'), bubble=$('#play-bubble'), effects=$('#play-effects');
  const character=new Character(svg);
  let jobs=[], state='idle', snacks=0, interactions=0, lastInteraction=performance.now();
  let x=0,y=0,drag=null,suppressClick=false, visible=false, surpriseIndex=0;
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
  const position=()=>{
    x=clamp(x,-yard.clientWidth/2+pet.offsetWidth/2+12,yard.clientWidth/2-pet.offsetWidth/2-12);
    y=clamp(y,-yard.clientHeight/2+pet.offsetHeight/2+bubble.offsetHeight+24,yard.clientHeight/2-pet.offsetHeight/2-48);
    const centerX=yard.clientWidth/2+x;
    const bubbleX=clamp(centerX,bubble.offsetWidth/2+12,yard.clientWidth-bubble.offsetWidth/2-12)-centerX;
    wrap.style.setProperty('--bubble-shift',`${bubbleX}px`);
    wrap.style.setProperty('--pet-x',`${x}px`);wrap.style.setProperty('--pet-y',`${y}px`);
  };
  const boundsObserver=new ResizeObserver(position);boundsObserver.observe(yard);
  new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;},{threshold:.15}).observe(yard);
  function center(){const p=pet.getBoundingClientRect(),r=yard.getBoundingClientRect();return {x:p.left-r.left+p.width/2,y:p.top-r.top+p.height/2};}
  function later(fn,delay){jobs.push(setTimeout(fn,delay));}
  function clear(){jobs.forEach(clearTimeout);jobs=[];pet.getAnimations().forEach(a=>a.cancel());effects.replaceChildren();yard.classList.remove('is-dancing','is-napping');$('#nap-label').textContent='Little nap';$('[data-play="nap"]').setAttribute('aria-pressed','false');}
  function say(mood,text){if(character.mood===mood&&bubble.textContent===text)return;character.set(mood);bubble.textContent=text;position();}
  function begin(next){clear();state=next;lastInteraction=performance.now();interactions++;$('#play-counter').textContent=interactions>=8?'Officially besties.':interactions>=3?'Yep. Kibu likes you.':'A good place to procrastinate.';}
  function settle(delay=2400){later(()=>{state='idle';say('idle','your move.');},delay);}
  function hop(){animate(pet,[{transform:'translateY(0) scale(1)'},{transform:'translateY(-25px) scale(.97,1.04)',offset:.42},{transform:'translateY(0) scale(1.08,.92)',offset:.82},{transform:'translateY(0) scale(1)'}],{duration:620});}
  function love(){begin('pet');say('love',['oh. that’s nice.','you get me.','my favorite human.'][interactions%3]);const p=center();burst(effects,p.x,p.y,{hearts:true,color:'#ff6fa8',count:9});hop();settle();}
  pet.addEventListener('click',()=>{if(suppressClick){suppressClick=false;return}love();});
  const surprises=[['cool','too cool for busywork.'],['sneeze','ah… ah… achoo.'],['starstruck','you’re kind of a big deal.'],['kiss','a little thank-you.'],['laugh','you had to be there.'],['wave','hi again, favorite human.']];
  document.querySelectorAll('[data-play]').forEach(button=>button.addEventListener('click',()=>{
    const action=button.dataset.play;
    if(action==='nap'&&state==='nap'){begin('awake');say('yawn','five more minutes?');settle(2600);return;}
    begin(action);
    if(action==='feed'){
      snacks++;say('excited','a little byte?');
      const p=center();
      const snack=document.createElement('span');snack.className='file-snack';snack.textContent=['.txt','.png','.pdf','.zip'][snacks%4];effects.append(snack);
      snack.style.left='20%';snack.style.top='45%';
      const flight=animate(snack,[{transform:'translate(0,0) rotate(-14deg) scale(1)',opacity:1},{transform:`translate(${p.x-yard.clientWidth*.2-20}px,${p.y-yard.clientHeight*.45-20}px) rotate(28deg) scale(.1)`,opacity:0}],{duration:780});
      if(!flight)snack.remove();
      later(()=>{
        snack.remove();say(snacks%3===0?'celebrate':'happy',snacks%3===0?'delicious. five stars.':'nom. zero crumbs.');hop();const p=center();burst(effects,p.x,p.y,{count:14});
        $('#play-counter').textContent=`${snacks} ${snacks===1?'file':'files'} happily snacked on.`;
      },800);settle(3100);
    }
    if(action==='dance'){
      say('music','tiny desk disco.');yard.classList.add('is-dancing');
      animate(pet,[{transform:'translateY(0) rotate(-9deg)'},{transform:'translateY(-22px) rotate(9deg)',offset:.25},{transform:'translateY(0) rotate(-9deg)',offset:.5},{transform:'translateY(-18px) rotate(9deg)',offset:.75},{transform:'translateY(0) rotate(-9deg)'}],{duration:850,iterations:5,easing:'ease-in-out'});
      const p=center();burst(effects,p.x,p.y,{count:16});
      later(()=>{yard.classList.remove('is-dancing');say('cool','still got it.');state='idle';},4300);
    }
    if(action==='nap'){say('sleepy','recharging. zzz.');yard.classList.add('is-napping');$('#nap-label').textContent='Wake up';$('[data-play="nap"]').setAttribute('aria-pressed','true');}
    if(action==='surprise'){const [mood,text]=surprises[surpriseIndex++%surprises.length];say(mood,text);hop();settle(3600);}
  }));
  // Pointer capture keeps a drag continuous; only the pet disables touch scrolling.
  pet.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    suppressClick=false;
    drag={id:event.pointerId,startX:event.clientX,startY:event.clientY,x,y,moved:false};
    pet.setPointerCapture(event.pointerId);
  });
  pet.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.id)return;
    const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;
    if(!drag.moved&&Math.hypot(dx,dy)>6){drag.moved=true;begin('drag');wrap.classList.add('is-dragging');say('surprised','wheee.');}
    if(!drag.moved)return;
    x=drag.x+dx;y=drag.y+dy;position();
    pet.style.setProperty('--drag-tilt',`${clamp(dx/12,-14,14)}deg`);
  });
  function release(event){
    if(!drag||drag.id!==event.pointerId)return;
    const moved=drag.moved;drag=null;wrap.classList.remove('is-dragging');pet.style.removeProperty('--drag-tilt');
    if(moved){suppressClick=true;say('dizzy','nice landing. mostly.');settle(1600);hop();}
  }
  pet.addEventListener('pointerup',release);pet.addEventListener('pointercancel',release);pet.addEventListener('lostpointercapture',release);
  pet.addEventListener('keydown',event=>{
    if(event.key==='Enter'||event.key===' ')suppressClick=false;
    const offsets={ArrowLeft:[-25,0],ArrowRight:[25,0],ArrowUp:[0,-25],ArrowDown:[0,25]};
    if(!offsets[event.key])return;
    event.preventDefault();begin('move');x+=offsets[event.key][0];y+=offsets[event.key][1];position();say('happy','nice spot.');settle();
  });
  yard.addEventListener('pointermove',event=>{
    if(motion.paused||event.pointerType!=='mouse')return;
    const r=yard.getBoundingClientRect();yard.style.setProperty('--light-x',`${event.clientX-r.left}px`);yard.style.setProperty('--light-y',`${event.clientY-r.top}px`);
  },{passive:true});
  setInterval(()=>{
    if(document.hidden||!visible||state!=='idle'||drag||motion.paused)return;
    const idle=performance.now()-lastInteraction;
    if(idle>26000)say('sleepy','just resting my pixels.');
    else if(idle>14000)say('bored','no rush. i live here.');
  },3000);
  const toggle=$('#motion-toggle');
  function syncMotion(paused){toggle.setAttribute('aria-pressed',String(paused));toggle.setAttribute('aria-label',paused?'Resume animations':'Pause animations');toggle.querySelector('span').textContent=paused?'Resume motion':'Pause motion';}
  toggle.addEventListener('click',()=>motion.set(!motion.paused));motion.subscribe(syncMotion);syncMotion(motion.paused);
}
