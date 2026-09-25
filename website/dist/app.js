import { Character, motion, animate, burst } from './character.js';
import { initPlayground } from './playground.js';

const files = [
  ['PDF', 'invoice-september.pdf', 'Today', ''],
  ['PNG', 'Screenshot 2026-09-22.png', 'Yesterday', 'img'],
  ['XLS', 'budget-final-v3.xlsx', 'Yesterday', 'sheet'],
  ['PDF', 'brand-guidelines.pdf', 'Monday', ''],
  ['JPG', 'IMG_2048.jpg', 'Monday', 'img'],
  ['PDF', 'project-proposal.pdf', 'Sunday', '']
];
const tasks = {
  organize: { request:'“Organize my Downloads.”', ready:'A place for everything. Ready?', progress:'Finding a home for every file…', done:'6 files. 3 folders. A little more breathing room.', title:'Downloads' },
  find: { request:'“Find the invoice from September.”', ready:'I know it’s around here somewhere.', progress:'Looking through Downloads…', done:'Found it. Right where you didn’t look.', title:'Downloads' },
  rename: { request:'“Give these screenshots tidy names.”', ready:'A little order goes a long way.', progress:'Tidying up those filenames…', done:'Same screenshots. Much better names.', title:'Screenshots' }
};
const screenshots = ['Screenshot 2026-09-22 at 10.42.03.png','Screenshot 2026-09-22 at 10.45.11.png','Screenshot 2026-09-22 at 11.02.38.png','Screenshot 2026-09-22 at 11.14.52.png'];
let selected='organize', phase='ready', timer, helloTimer;
const $ = (s) => document.querySelector(s);
const list = $('#file-list');
const hero = new Character($('#hero-face'));
const demoEffects = document.createElement('div');
demoEffects.className='demo-effects';demoEffects.setAttribute('aria-hidden','true');$('.desktop-stage').append(demoEffects);
let runVersion=0;
let demoTimers=[];
function later(fn,ms){demoTimers.push(setTimeout(fn,motion.paused?0:ms));}
function row(type,name,kind,style='',state='') {
  const item=document.createElement('div'); item.className=`file-row ${state}`;
  const icon=document.createElement('span'); icon.className=`file-icon ${style}`;icon.textContent=type;icon.setAttribute('aria-hidden','true');
  const label=document.createElement('span');label.className='file-name';label.textContent=name;
  const meta=document.createElement('span');meta.className='file-kind';meta.textContent=kind;
  item.append(icon,label,meta);return item;
}
function renderFiles(done=false){
  list.replaceChildren();
  if(selected==='organize' && done){
    [['Documents','3 files'],['Images','2 files'],['Spreadsheets','1 file']].forEach(([name,count],i)=>{const el=row('',name,count,'folder','new');el.style.animationDelay=`${i*90}ms`;list.append(el)});
  }else if(selected==='rename'){
    screenshots.forEach((name,i)=>list.append(row('PNG',done?`screenshot-${String(i+1).padStart(2,'0')}.png`:name,done?'Renamed':'PNG','img',done?'highlight new':'')));
  }else{
    files.forEach((f,i)=>list.append(row(...f,done&&selected==='find'?(i===0?'highlight':'muted'):'')));
  }
  $('#file-count').textContent=selected==='rename'?(done?'4 screenshots · renamed':'4 screenshots · untidy names'):selected==='find'&&done?'1 match · September invoice':done?'3 folders · all sorted':'6 files · a little chaos';
}
function face(mood){hero.set(mood)}
function reset(task=selected){clearTimeout(timer);clearTimeout(helloTimer);demoTimers.forEach(clearTimeout);demoTimers=[];runVersion++;list.getAnimations({subtree:true}).forEach(a=>a.cancel());$('#demo').classList.remove('is-working');selected=task;phase='ready';$('#window-title').textContent=tasks[task].title;$('#request').textContent=tasks[task].request;$('#response').textContent=tasks[task].ready;$('#run-demo').disabled=false;$('#run-demo').setAttribute('aria-label',`Run the ${task} demo`);$('#run-symbol').textContent='↑';$('#pet-bubble').textContent='hi, i’m kibu.';face('idle');document.querySelectorAll('[data-task]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.task===task)));renderFiles()}
function run(){
  if(phase==='done'){reset();return}
  if(phase==='running')return;
  const version=++runVersion;
  phase='running';$('#demo').classList.add('is-working');$('#response').textContent=tasks[selected].progress;$('#run-demo').disabled=true;$('#run-symbol').textContent='·';$('#pet-bubble').textContent='on it.';face('working');
  const rows=[...list.children];
  rows.forEach((item,i)=>later(()=>{
    if(version!==runVersion)return;
    if(selected==='organize')animate(item,[{transform:'translateX(0)',opacity:1},{transform:'translateX(45px) scale(.85)',opacity:0}],{duration:360,fill:'forwards'});
    if(selected==='find'){
      rows.forEach(row=>row.classList.remove('scanning'));
      item.classList.add('scanning');
    }
    if(selected==='rename'){
      item.querySelector('.file-name').textContent=`screenshot-${String(i+1).padStart(2,'0')}.png`;
      item.classList.add('highlight');
      animate(item,[{transform:'translateY(4px)',opacity:.35},{transform:'translateY(0)',opacity:1}]);
    }
  },220+i*150));
  timer=setTimeout(()=>{
    if(version!==runVersion)return;
    phase='done';renderFiles(true);$('#demo').classList.remove('is-working');$('#response').textContent=tasks[selected].done;$('#run-demo').disabled=false;$('#run-demo').setAttribute('aria-label','Reset the demo');$('#run-symbol').textContent='↶';$('#pet-bubble').textContent='all done.';face('proud');
    const pet=$('#pet').getBoundingClientRect(),stage=$('.desktop-stage').getBoundingClientRect();
    burst(demoEffects,pet.left-stage.left+pet.width/2,pet.top-stage.top+pet.height/2,{count:15});
    animate($('#hero-face'),[{transform:'translateY(0) rotate(0deg)'},{transform:'translateY(-18px) rotate(-7deg)',offset:.4},{transform:'translateY(0) rotate(0deg)'}],{duration:650});
  },motion.paused?30:1450);
}
document.querySelectorAll('[data-task]').forEach(b=>b.addEventListener('click',()=>reset(b.dataset.task)));
$('#run-demo').addEventListener('click',run);
let pets=0;
$('#pet').addEventListener('click',()=>{
  clearTimeout(helloTimer);pets++;face(pets%4===0?'shy':'love');$('#pet-bubble').textContent=['oh, hey you.','more of that, please.','we’re friends now.','okay, now i’m blushing.'][(pets-1)%4];
  const pet=$('#pet').getBoundingClientRect(),stage=$('.desktop-stage').getBoundingClientRect();
  burst(demoEffects,pet.left-stage.left+pet.width/2,pet.top-stage.top+pet.height/3,{hearts:true,color:'#ff6fa8',count:7});
  animate($('#hero-face'),[{transform:'scale(1)'},{transform:'scale(1.1,.93)',offset:.35},{transform:'scale(1)'}]);
  helloTimer=setTimeout(()=>{face(phase==='running'?'working':phase==='done'?'happy':'idle');$('#pet-bubble').textContent=phase==='running'?'on it.':phase==='done'?'all done.':'hi, i’m kibu.'},2400);
});
$('#hero-cta').addEventListener('click',()=>{if(phase==='ready')run()});
reset();

initPlayground();

// Motion adds depth, while content remains visible when scripts or motion are off.
const revealObserver=new IntersectionObserver(entries=>{
  for(const entry of entries)if(entry.isIntersecting){
    animate(entry.target,[{opacity:.25,transform:'translateY(22px)'},{opacity:1,transform:'translateY(0)'}],{duration:750});
    revealObserver.unobserve(entry.target);
  }
},{threshold:.12});
document.querySelectorAll('.control-content,.section-note,.playground').forEach(el=>revealObserver.observe(el));
const scene=$('#demo');
let tiltFrame;
scene.addEventListener('pointermove',event=>{
  if(motion.paused||event.pointerType!=='mouse')return;
  cancelAnimationFrame(tiltFrame);
  tiltFrame=requestAnimationFrame(()=>{
    const r=scene.getBoundingClientRect();
    scene.style.setProperty('--tilt-x',`${(event.clientX-r.left-r.width/2)/r.width*3}deg`);
    scene.style.setProperty('--tilt-y',`${-(event.clientY-r.top-r.height/2)/r.height*3}deg`);
  });
});
scene.addEventListener('pointerleave',()=>{cancelAnimationFrame(tiltFrame);scene.style.setProperty('--tilt-x','0deg');scene.style.setProperty('--tilt-y','0deg');});
motion.subscribe(paused=>{
  if(paused){cancelAnimationFrame(tiltFrame);document.getAnimations().forEach(a=>a.cancel());scene.style.setProperty('--tilt-x','0deg');scene.style.setProperty('--tilt-y','0deg');}
});
