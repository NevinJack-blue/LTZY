import {mountMotion} from './motion.js';
const $=s=>document.querySelector(s), main=$('#content'), sheet=$('#sheet'), signout=$('#logout');
const names={home:'统一模型网关',models:'模型目录',docs:'接入文档',status:'服务状态',console:'项目总览',keys:'API 密钥',logs:'请求日志',usage:'用量与预算',ops:'线路与对账'};
const privatePages=new Set(['console','keys','logs','usage','ops']);
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let toastTimer,generation=0,signed=false,modalTrigger,disposeMotion=()=>{};
function notify(text){const n=$('#notice');n.textContent=text;n.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>n.hidden=true,4200)}
function modal(title,html){if(!sheet.open)modalTrigger=document.activeElement;$('#sheet-title').textContent=title;sheet.querySelector('[data-modal-body]').innerHTML=html;if(!sheet.open)sheet.showModal();return sheet}
$('#dismiss').onclick=()=>sheet.close();
sheet.addEventListener('close',()=>{if(sheet.open)return;sheet.querySelector('[data-modal-body]').replaceChildren();if(modalTrigger?.isConnected)modalTrigger.focus()});
sheet.onclick=e=>{if(e.target===sheet){const r=sheet.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)sheet.close()}};
async function api(path,options={}){
 const h=new Headers(options.headers),opts={...options,headers:h,credentials:'same-origin',cache:'no-store'};
 if(opts.body!=null&&typeof opts.body!=='string'){h.set('Content-Type','application/json');opts.body=JSON.stringify(opts.body)}
 const response=await fetch(path,opts),isJson=(response.headers.get('content-type')||'').includes('json');
 const data=isJson?await response.json():await response.text();
 if(!response.ok){const err=new Error(data?.error?.message||'服务暂不可用，请重试。');err.status=response.status;throw err}return data;
}
const go=page=>{if(location.hash==='#'+page)render();else location.hash=page};
function showLogin(root){
 root.innerHTML='<section class="gate"><div class="gate-intro" data-build><small>YOUR SIGNAL. YOUR SPACE.</small><h1>每一次调用，<br>都在掌握之中。</h1><p>进入你的模型工作空间。密钥、路由、用量，在同一个地方流动。</p><div class="gate-orbits" aria-hidden="true"><i></i><i></i><i></i><span>LTZY</span></div></div><form data-build><span class="gate-badge">PRIVATE WORKSPACE</span><h2>欢迎回来</h2><label for="admin-pass">管理员密码</label><input id="admin-pass" type="password" required autocomplete="current-password" maxlength="512"><p class="hint">首次启动后，在数据目录的 <code>admin-password.txt</code> 中查看密码。</p><button class="primary" type="submit">登录工作台 ↗</button><p role="alert"></p></form></section>';
 const form=root.querySelector('form');
 form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('button'),field=form.querySelector('input'),alert=form.querySelector('[role=alert]');b.disabled=true;alert.textContent='';
 try{await api('/api/login',{method:'POST',body:{password:field.value}});field.value='';await render()}
 catch(err){alert.textContent=err.status===401?'密码不正确，请重试。':err.message;field.select()}finally{b.disabled=false}};
}
function animate(root,replay=false){disposeMotion();disposeMotion=mountMotion(root,{replay})||(()=>{})}
async function render(){
 const gen=++generation,raw=location.hash.slice(1).split('?')[0]||'home',page=Object.hasOwn(names,raw)?raw:null;
 disposeMotion();disposeMotion=()=>{};main.firstElementChild?.dispatchEvent(new Event('ltzy:dispose'));const root=document.createElement('div');root.className='view';main.replaceChildren(root);
 if(sheet.open)sheet.close();document.title='LTZY · '+(names[page]||'未找到页面');document.body.dataset.view=page||'missing';
 $('.mast').querySelectorAll('a').forEach(a=>{if(a.hash==='#'+page||(a.className==='console-link'&&privatePages.has(page)))a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});
 window.scrollTo(0,0);
 if(!page){root.innerHTML='<section class="shell-error"><h1>找不到这个页面</h1><a class="button" href="#home">回到首页</a></section>';return}
 root.innerHTML='<div class="shell-loading" role="status"><span class="loading-orb"></span><span>正在连接你的工作空间</span><i></i></div>';
 const ctx={root,api,escape,go,modal,notify};
 try{if(privatePages.has(page)){const {renderDesk}=await import('./desk.js');await renderDesk(page,ctx);if(gen===generation)signed=true}
 else{const {renderPublic}=await import('./public.js');await renderPublic(page,ctx)}}
 catch(err){if(gen!==generation)return;
 if(privatePages.has(page)&&err.status===401){signed=false;showLogin(root)}
 else{root.innerHTML='<section class="shell-error"><h1>页面未能载入</h1><p>'+escape(err.message)+'</p><button class="button" type="button">重新加载</button></section>';root.querySelector('button').onclick=render}}
 finally{if(gen===generation){signout.hidden=!signed;animate(root)}}
}
signout.onclick=async()=>{signout.disabled=true;try{await api('/api/logout',{method:'POST',body:{}});signed=false;signout.hidden=true;go('home')}catch(e){notify(e.message)}finally{signout.disabled=false}};
$('.skip').onclick=e=>{e.preventDefault();main.focus()};
$('#replay').onclick=()=>window.dispatchEvent(new Event('ltzy:replay'));
const motionToggle=$('#motion-toggle');
try{motionToggle.checked=localStorage.getItem('ltzy-reduced-motion')==='true'}catch{}
motionToggle.onchange=()=>{try{localStorage.setItem('ltzy-reduced-motion',String(motionToggle.checked))}catch{}document.documentElement.classList.toggle('motion-quiet',motionToggle.checked);if(motionToggle.checked){disposeMotion();main.querySelectorAll('.pa-reveal').forEach(el=>el.classList.add('pa-visible'))}notify(motionToggle.checked?'已减少动态效果':'已开启完整动效')};
document.documentElement.classList.toggle('motion-quiet',motionToggle.checked);
window.addEventListener('ltzy:replay',()=>{const root=main.firstElementChild;if(root){window.scrollTo({top:0,behavior:'instant'});requestAnimationFrame(()=>animate(root,true))}});
const themeButton=$('#theme-toggle'),qualitySelect=$('#quality-select');
function syncThemeButton(){const dark=document.documentElement.dataset.theme==='dark';themeButton.setAttribute('aria-label',dark?'切换至白天主题':'切换至夜晚主题');themeButton.title=dark?'切换至白天主题':'切换至夜晚主题';themeButton.setAttribute('aria-pressed',String(dark));themeButton.querySelector('[aria-hidden]').textContent=dark?'☀':'☾';themeButton.querySelector('.theme-label').textContent=dark?'白天':'夜晚';document.querySelector('meta[name="theme-color"]').content=dark?'#0a1222':'#f5f8ff'}
syncThemeButton();
themeButton.onclick=()=>{const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;try{localStorage.setItem('ltzy-theme',theme)}catch{}syncThemeButton();window.dispatchEvent(new Event('ltzy:theme'))};
qualitySelect.value=document.documentElement.dataset.qualityChoice||'auto';
qualitySelect.onchange=()=>{const choice=qualitySelect.value;try{localStorage.setItem('ltzy-quality',choice)}catch{}document.documentElement.dataset.qualityChoice=choice;const low=!!(navigator.connection?.saveData||(navigator.deviceMemory&&navigator.deviceMemory<=4)||(navigator.hardwareConcurrency&&navigator.hardwareConcurrency<=4));document.documentElement.dataset.quality=choice==='auto'?(low?'lite':'full'):choice;disposeMotion();main.querySelectorAll('.pa-reveal').forEach(el=>el.classList.add('pa-visible'));window.dispatchEvent(new Event('ltzy:quality'));notify('已切换至'+{auto:'自动性能',lite:'流畅',full:'完整画质'}[choice]+'模式')};
window.addEventListener('hashchange',render);window.addEventListener('pageshow',e=>{if(e.persisted)render()});render();
