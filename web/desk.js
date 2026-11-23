const sections={console:['项目总览','Overview'],keys:['API 密钥','Access keys'],logs:['请求日志','Requests'],usage:['用量与预算','Usage & budget'],ops:['线路与对账','Operations']};
const traceLabels={reserved:'预算预留',attempt:'尝试上游',first_byte:'收到首字节',settled:'用量结算',fallback:'切换备用线路',rejected:'上游拒绝',failed:'请求失败',interrupted:'请求中断',pending:'等待核对',reconciled:'人工核对结算',incomplete_response:'上游响应不完整',void:'不计费用'};
const labels={success:'成功',failed:'失败',interrupted:'已中断',running:'进行中',settled:'已结算',pending:'待核对',reserved:'已预留',void:'未计费'};
const fmt=(n,d=0)=>n==null?'—':Number(n).toLocaleString('en-US',{maximumFractionDigits:d});
const money=n=>n==null?'—':'$'+
Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:9});
const when=v=>{if(!v)return '—';
 const d=new Date(typeof v==='number'&&v<1e12?v*1000:v);return Number.isNaN(+d)?'—':d.toLocaleString('zh-CN',{hour12:false})};
const icon=(name)=>{const paths={console:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',keys:'M15 3a6 6 0 0 0-5.5 8.4L3 18v3h3v-3h3v-3l2.6-2.6A6 6 0 1 0 15 3Z',logs:'M5 3h14v18H5zM9 8h6M9 12h6M9 16h4',usage:'M4 20h16M7 16V9M12 16V4M17 16v-5',ops:'M4 6h16M4 18h16M8 3v6M16 15v6'};return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+
paths[name]+
'"/></svg>'};
const link=(page,text,primary=false)=>'<a class="dk-btn '+
(primary?'dk-primary':'')+
'" href="#'+
page+
'">'+
text+
'</a>';
const section=(title,body,aside='')=>'<section class="dk-section" data-build><div class="dk-heading"><h2>'+
title+
'</h2>'+
aside+
'</div>'+
body+
'</section>';
const empty=(title,text='')=>'<div class="dk-empty"><span class="dk-empty-icon">'+
icon('logs')+
'</span><strong>'+
title+
'</strong>'+
(text?'<p>'+
text+
'</p>':'')+
'</div>';
const stat=(label,value,sub='')=>'<div class="dk-stat" data-build><span>'+
label+
'</span><strong>'+
value+
'</strong>'+
(sub?'<small>'+
sub+
'</small>':'')+
'</div>';
const table=(heads,rows)=>'<div class="dk-table-wrap"><table class="dk-table"><thead><tr>'+
heads.map(h=>'<th scope="col">'+
h+
'</th>').join('')+
'</tr></thead><tbody>'+
rows.map(r=>'<tr>'+
r.map((c,i)=>'<td data-label="'+
heads[i]+
'">'+
c+
'</td>').join('')+
'</tr>').join('')+
'</tbody></table></div>';
const csv='<a class="dk-btn" href="/api/usage.csv" download>导出 CSV ↓</a>';
const field=(name,value)=>'<div><dt>'+
name+
'</dt><dd>'+
value+
'</dd></div>';
export async function renderDesk(page,ctx){
 const {root,api,escape,modal,notify}=ctx,e=v=>escape(String(v??'—')),data=await api('/api/workspace');
 const {keys,budget:b,requests,lanes,usage}=data,active=keys.filter(k=>!k.revoked),pending=data.pending??requests.filter(r=>r.settlement==='pending');
 const total=usage.reduce((s,u)=>s+Number(u.requests),0),tokens=usage.reduce((s,u)=>s+Number(u.inputTokens||0)+Number(u.outputTokens||0),0);
 const badge=v=>'<span class="dk-tag '+
(['pending','interrupted','failed'].includes(v)?'dk-warn':v==='success'||v==='settled'?'dk-good':'')+
'">'+
e(labels[v]||v)+
'</span>';
 const charge=r=>r.settlement==='settled'?money(r.cost):e(labels[r.settlement]||r.settlement);
 const receipts=rows=>table(['请求 / 时间','模型 / 线路','状态','延迟','费用'],rows.map(r=>['<button class="dk-id" data-receipt="'+
e(r.id)+
'">'+
e(r.id)+
'</button><small>'+
when(r.createdAt)+
'</small>',e(r.model)+
'<small>'+
e(r.lane)+
'</small>',badge(r.status),fmt(r.latencyMs)+
' ms',charge(r)]));
 const budgetSummary='<div class="dk-stats">'+
stat('预算上限',money(b.limit),'项目硬上限')+stat('已结算',money(b.spent),'已确认用量')+stat('已预留',money(b.reserved),'进行中与待核对')+stat('可用额度',money(b.remaining),'后续请求可用')+
'</div>';
 const next=active.length?link('docs','查看接入示例 ↗',true):link('keys','创建 API 密钥',true);
 function allocation(){const pct=n=>b.limit>0?Math.min(100,Math.max(0,Number(n)/Number(b.limit)*100)):0;return '<div class="dk-allocation" role="img" aria-label="预算分配：已结算 '+
e(money(b.spent))+
'，预留 '+
e(money(b.reserved))+
'，可用 '+
e(money(b.remaining))+
'"><span style="width:'+
pct(b.spent)+
'%"></span><i style="width:'+
pct(b.reserved)+
'%"></i></div><div class="dk-legend"><span><i></i>已结算 '+
money(b.spent)+
'</span><span><i></i>已预留 '+
money(b.reserved)+
'</span><span><i></i>可用 '+
money(b.remaining)+
'</span></div>'}
 function distribution(){const max=Math.max(1,...usage.map(u=>Number(u.requests)));return usage.length?'<div class="dk-bars">'+
usage.map(u=>'<div><div><b>'+
e(u.model)+
'</b><span>'+
fmt(u.requests)+
' 次</span></div><div class="dk-bar"><span style="width:'+
Number(u.requests)/max*100+
'%"></span></div><small>'+
fmt(Number(u.inputTokens)+Number(u.outputTokens))+
' tokens · '+
money(u.cost)+
'</small></div>').join('')+
'</div>':empty('暂无模型用量','发送第一次请求后显示真实累计分布。')}
 function health(){
 const count=status=>requests.filter(r=>r.status===status).length;
 const ok=count('success'),bad=count('failed')+count('interrupted'),running=count('running');
 const completed=ok+bad,rate=completed?Math.round(ok/completed*100):0;
 return '<section class="dk-signal" data-build><div class="dk-signal-title">'+

 '<span class="dk-kicker">REQUEST SIGNAL</span><h2>每次调用，都有据可循。</h2>'+

 '<p>从路由选择到用量结算，记录真实请求的完整路径。</p>'+
link('logs','打开请求账本 ↗')+
 '</div><div class="dk-health-ring" style="--rate:'+
rate+
'%" role="img" aria-label="最近 '+

 requests.length+
' 笔请求中成功 '+
ok+
' 笔"><div><strong>'+
 (completed?rate+
'%':'—')+
 '</strong><span>已完成成功率</span></div></div><div class="dk-signal-values">'+

 '<div><i class="dk-dot teal"></i><b>'+
fmt(ok)+
'</b><span>成功</span></div>'+

 '<div><i class="dk-dot rose"></i><b>'+
fmt(bad)+
'</b><span>失败 / 中断</span></div>'+

 '<div><i class="dk-dot iris"></i><b>'+
fmt(pending.length)+
'</b><span>等待核对</span></div>'+

 '<div><i class="dk-dot blue"></i><b>'+fmt(running)+'</b><span>进行中</span></div><small>最近 '+
requests.length+
' 笔 · 仅已完成请求计入成功率，不代表历史趋势</small></div></section>';
 }
 function tokenChart(){
 if(!tokens)return section('Token 构成',empty('暂无已确认的 token 用量','请求完成并结算后显示真实输入与输出占比。'));
 const input=usage.reduce((s,u)=>s+Number(u.inputTokens||0),0);
 const output=usage.reduce((s,u)=>s+Number(u.outputTokens||0),0);
 const pct=tokens?input/tokens*100:0;
 return section('Token 构成','<div class="dk-token-chart"><div><strong>'+
fmt(tokens)+
 '</strong><span>累计计量 tokens</span></div><div class="dk-token-track" role="img" aria-label="输入 '+

 fmt(input)+
'，输出 '+
fmt(output)+
' tokens"><span style="width:'+
pct+
'%"></span></div>'+

 '<div class="dk-token-labels"><span><i class="dk-dot blue"></i>输入 <b>'+
fmt(input)+
 '</b></span><span><i class="dk-dot iris"></i>输出 <b>'+
fmt(output)+
'</b></span></div></div>');
 }
 function accessSummary(){return '<div class="dk-access-summary" data-build><div class="dk-access-orb">'+

 icon('keys')+
'</div><div><span class="dk-kicker">ACCESS CONTROL</span><h2>权限分开，访问可控。</h2>'+

 '<p>调用密钥用于服务端，仅读密钥仅访问模型目录。撤销后立即拒绝新的请求。</p></div>'+

 '<div class="dk-access-count"><strong>'+
active.length+
'</strong><span>有效密钥 / '+
keys.length+
' 个</span></div></div>';}
 function terminal(){
 const snapshots={
  workspace:{source:'GET /api/workspace',activeKeys:active.length,requests:total,
   tokens,budget:{limit:b.limit,spent:b.spent,reserved:b.reserved,remaining:b.remaining}},
  routes:lanes.map(l=>({id:l.id,model:l.model,kind:l.kind,enabled:l.enabled,priority:l.priority})),
  receipt:requests[0]?{id:requests[0].id,model:requests[0].model,status:requests[0].status,
   settlement:requests[0].settlement,trace:requests[0].trace}:null
 };
 return '<details class="dk-terminal" data-build><summary><span class="dk-terminal-led"></span>'+ 
  '项目检查器 <small>只读 · 当前账本快照</small><span class="dk-terminal-expand">展开 JSON ↓</span></summary>'+ 
  '<div class="dk-terminal-tabs" role="group" aria-label="检查数据">'+
  Object.keys(snapshots).map((name,i)=>'<button type="button" class="dk-terminal-tab" data-snapshot="'+name+
   '" aria-pressed="'+(i===0)+'">'+name+'</button>').join('')+
  '</div><pre data-terminal-output>'+e(JSON.stringify(snapshots.workspace,null,2))+'</pre>'+ 
  '<span hidden data-terminal-data>'+e(JSON.stringify(snapshots))+'</span></details>';
 }
 function overview(){return health()+
'<div class="dk-stats dk-overview-stats">'+
stat('累计请求',fmt(total),'全量已记录请求')+stat('累计 tokens',fmt(tokens),'输入 + 输出')+stat('有效密钥',fmt(active.length),'共 '+
fmt(keys.length)+
' 个密钥')+stat('启用线路',fmt(lanes.filter(l=>l.enabled).length),'共 '+
fmt(lanes.length)+
' 条线路')+
'</div><div class="dk-dashboard">'+
section('预算运行状况','<div class="dk-balance" title="精确可用额度 '+
money(b.remaining)+
'">$'+
Number(b.remaining).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+
'<small>USD 可用</small></div>'+
allocation()+
'<div class="dk-panel-foot"><span>预算上限 '+
money(b.limit)+
'</span>'+
link('usage','管理预算 →')+
'</div>')+section('模型调用分布',distribution(),'<span class="dk-muted">累计 · 按请求数</span>')+
'</div>'+
(pending.length?'<a class="dk-alert-summary" href="#ops"><strong>'+
pending.length+
' 条请求待核对</strong><span>用量尚未确认，已保留预算。进入对账 →</span></a>':'')+section('最近请求',requests.length?receipts(requests.slice(0,5)):empty('还没有请求记录','创建密钥并发送模型请求；此处将展示真实路由与计量结果。')+
'<div class="dk-empty-action">'+
next+
'</div>',link('logs','查看全部 →'));}
 function keyPage(){return accessSummary()+
'<div class="dk-key-layout">'+
section('项目密钥',keys.length?table(['名称 / 权限','密钥前缀','创建时间','状态','操作'],keys.map((k,i)=>['<b>'+
e(k.name)+
'</b><small>'+
 (k.scope==='read'?'仅读取模型目录':'模型调用与目录读取')+
'</small>','<code>'+
e(k.prefix)+
'…</code>',when(k.created_at),k.revoked?'<span class="dk-tag">已撤销</span>':'<span class="dk-tag dk-good">有效</span>',k.revoked?'—':'<button class="dk-action dk-danger" data-revoke="'+
i+
'">撤销</button>'])):empty('尚未创建密钥','按应用隔离权限，独立管理和撤销。'),'<span class="dk-muted">'+
fmt(active.length)+
' 个有效</span>')+
'<aside class="dk-create" data-build><div class="dk-create-icon">'+
icon('keys')+
'</div><h2>创建 API 密钥</h2><p>为每个应用创建独立密钥。</p><form data-form="create"><label for="dk-name">密钥名称</label><input id="dk-name" name="name" maxlength="80" required placeholder="例如：订单服务 / 开发" autocomplete="off"><label for="dk-scope">权限范围</label><select id="dk-scope" name="scope"><option value="chat">模型调用与目录读取</option><option value="read">仅读取模型目录</option></select><div class="dk-notice">明文仅显示一次。创建后请立即保存到密码管理器，不要放入前端代码。</div><button class="dk-btn dk-primary">创建密钥</button></form></aside></div>';}
 function logs(){return '<form class="dk-filters" data-form="filters"><label>请求 ID<input type="search" name="query" placeholder="搜索请求 ID"></label><label>模型<select name="model"><option value="">全部模型</option>'+
[...new Set(requests.map(r=>r.model))].map(m=>'<option value="'+
e(m)+
'">'+
e(m)+
'</option>').join('')+
'</select></label><label>状态<select name="status"><option value="">全部状态</option>'+
Object.keys(labels).slice(0,4).map(s=>'<option value="'+
s+
'">'+
labels[s]+
'</option>').join('')+
'</select></label><button class="dk-action" type="reset">清空筛选</button></form><div class="dk-request-layout"><section class="dk-section" data-results data-build></section><aside class="dk-inspector" data-inspector data-build>'+
empty('选择一条请求','查看实际线路、路由轨迹、价格快照与结算明细。')+
'</aside></div>';}
 function billing(){return budgetSummary+tokenChart()+
'<div class="dk-billing-layout">'+
section('按模型归集',usage.length?table(['模型','请求数','输入 tokens','输出 tokens','已结算'],usage.map(u=>[e(u.model),fmt(u.requests),fmt(u.inputTokens),fmt(u.outputTokens),money(u.cost)])):empty('暂无用量','真实请求计量将按模型累计。'),csv)+section('项目硬预算','<form data-form="budget"><p>新请求需有足够的可用额度。预算不能低于已结算与预留之和。</p><label for="dk-limit">预算上限（USD）</label><input name="limit" id="dk-limit" type="number" min="0" max="1000000000" step="0.000001" value="'+
e(b.limit)+
'" required>'+
allocation()+
'<button class="dk-btn dk-primary">更新预算</button></form>')+
'</div>';}
 function ops(){return '<div class="dk-ops-summary"><div><span class="dk-live-dot"></span><b>'+
lanes.filter(l=>l.enabled).length+
' / '+
lanes.length+
' 条线路已启用</b><p>线路变更只影响后续请求，不改变已有计量。</p></div><a class="dk-btn" href="#status">公开服务状态 ↗</a></div>'+
section('路由线路',lanes.length?table(['线路 / 模型','连接类型','优先级','状态','操作'],lanes.map((l,i)=>{const last=l.enabled&&lanes.filter(x=>x.model===l.model&&x.enabled).length===1;return ['<b>'+
e(l.id)+
'</b><small>'+
e(l.model)+
'</small>',l.kind==='local-test'?'本地测试适配器':'HTTPS 上游',fmt(l.priority),l.enabled?'<span class="dk-tag dk-good">已启用</span>':'<span class="dk-tag">已停用</span>',last?'<span class="dk-muted">最后可用线路</span>':'<button class="dk-action" data-lane="'+
i+
'">'+
(l.enabled?'停用':'启用')+
'</button>']})):empty('未配置线路'))+
'<div class="dk-reconcile-layout">'+
section('费用核对','<div class="dk-recon"><div><span class="dk-muted">账本已结算 · USD</span><strong>'+
money(b.spent)+
'</strong><p>导出明细，仅合计已结算金额。</p>'+
csv+
'</div><form data-form="compare"><label for="dk-reference">明细合计（USD）</label><input type="number" name="reference" id="dk-reference" step="any" min="0" required placeholder="0.000000"><button class="dk-btn">核对差额</button><output aria-live="polite"></output></form></div>')+section('待核对请求',pending.length?pending.map((r,i)=>'<form class="dk-settle" data-form="settle" data-index="'+
i+
'"><button type="button" class="dk-id" data-receipt="'+
e(r.id)+
'">'+
e(r.id)+
' ↗</button><small>'+
e(r.model)+
'</small><label>确认输入 tokens<input type="number" min="0" step="1" max="10000000" required name="inputTokens"></label><label>确认输出 tokens<input type="number" min="0" step="1" max="10000000" required name="outputTokens"></label><label>核对依据<input maxlength="240" name="note" required placeholder="凭据编号，不含敏感信息"></label><button class="dk-btn dk-primary">预览结算</button></form>').join(''):empty('没有待核对请求','未确认的用量不会计入已结算费用。'),'<span class="dk-tag">'+
pending.length+
' 待处理</span>')+
'</div>';}
 function receipt(r,scroll=true){const html='<article class="dk-receipt"><header><div><span class="dk-muted">请求详情</span><h2>'+
e(r.model)+
'</h2></div>'+
badge(r.status)+
'</header><code class="dk-request-id">'+
e(r.id)+
'</code><button class="dk-action" data-copy-id>复制请求 ID</button><dl>'+
field('请求时间',when(r.createdAt))+field('实际线路',e(r.lane))+field('延迟',r.latencyMs==null?'—':fmt(r.latencyMs)+
' ms')+
'</dl><h3>路由轨迹</h3>'+
(r.trace?.length?'<ol class="dk-trace">'+
r.trace.map(t=>'<li><b>'+
e(traceLabels[t.event]||(/^http_/.test(t.event)?'上游返回 HTTP '+
t.event.slice(5):t.event))+
'</b><span>'+
e(t.lane)+
'</span><small>'+
fmt(t.ms)+
' ms</small></li>').join('')+
'</ol>':'<p>暂无轨迹记录。</p>')+
'<h3>计量明细</h3><dl>'+
field('输入 / 输出 tokens',fmt(r.inputTokens)+
' / '+
fmt(r.outputTokens))+field('输入 / 输出单价',money(r.price?.input)+
' / '+
money(r.price?.output)+
' · 每百万 tokens')+field('计价版本',e(r.price?.version))+field('结算状态',badge(r.settlement))+
'</dl>'+
(r.audit?'<h3>核对记录</h3><p>'+
e(r.audit.note)+
' · '+
when(r.audit.at)+
'</p><p>输入 '+
fmt(r.audit.inputTokens)+
' / 输出 '+
fmt(r.audit.outputTokens)+
'</p>':'')+
'<div class="dk-total"><b>本次费用</b><strong>'+
charge(r)+
'</strong></div></article>';
 const panel=q('[data-inspector]');
 if(panel){panel.innerHTML=html;desk.querySelectorAll('[data-receipt]').forEach(x=>x.setAttribute('aria-pressed',String(x.dataset.receipt===r.id)));
 if(scroll&&matchMedia('(max-width: 1100px)').matches)panel.scrollIntoView({behavior:scrollBehavior(),block:'start'});}else modal('请求详情',html);
 const c=(panel||document).querySelector('[data-copy-id]');
 if(c)c.onclick=()=>copy(r.id);}
 async function copy(text){try{await navigator.clipboard.writeText(text);notify('已复制')}catch{notify('无法访问剪贴板，请手动选择文本复制。')}}
 const view={console:overview,keys:keyPage,logs,usage:billing,ops};
 root.innerHTML='<div class="dk"><aside class="dk-side" data-build><a class="dk-project" href="#console"><span class="dk-marker">L</span><div><b>默认项目</b><small>LTZY / WORKSPACE</small></div></a><span class="dk-nav-label">工作空间</span><nav aria-label="控制台导航">'+
Object.entries(sections).map(([k,[name]])=>'<a href="#'+
k+
'" aria-label="'+e(name)+'" '+
(k===page?'aria-current="page"':'')+
'>'+
icon(k)+
'<span>'+
name+
'</span></a>').join('')+
'</nav><a class="dk-doc" href="#docs">接入文档 ↗</a><div class="dk-side-foot"><span class="dk-live-dot"></span>来自项目账本 · 手动刷新</div></aside><div class="dk-main" data-page="'+
page+
'"><header class="dk-pagehead"><div><div class="dk-breadcrumb">工作空间 <span>/</span> '+
sections[page][1]+
'</div><h1 data-build>'+
sections[page][0]+
'</h1></div><button class="dk-btn" data-refresh>刷新数据 ↻</button></header><div data-confirm></div>'+
view[page]()+((page==='console'||page==='ops')?terminal():'')+
'</div></div>';
 const desk=root.querySelector('.dk'),q=s=>desk.querySelector(s);let busy=false,confirmed=null;
 const scrollBehavior=()=>document.documentElement.classList.contains('motion-quiet')||
 matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth';
 function showConfirm(text,action,fn){confirmed=fn;
 const box=q('[data-confirm]');box.innerHTML='<div class="dk-confirm" role="group" aria-label="确认操作"><p>'+
text+
'</p><div><button class="dk-btn dk-primary" data-yes>'+
action+
'</button> <button class="dk-btn" data-no>取消</button></div></div>';box.scrollIntoView({behavior:scrollBehavior(),block:'nearest'});box.querySelector('[data-no]').focus();}
 function clear(){confirmed=null;q('[data-confirm]').replaceChildren();}
 async function perform(fn){if(busy)return;busy=true;desk.setAttribute('aria-busy','true');try{await fn()}catch(err){if(err?.status===401){ctx.go(page);notify('会话已过期，请重新登录。')}else notify(err?.message||'操作未完成，请刷新后重试。')}finally{busy=false;desk.removeAttribute('aria-busy')}}
 async function refresh(){if(desk.isConnected)await renderDesk(page,ctx)}
 async function mutate(path,body,msg){await api(path,{method:'POST',body});clear();notify(msg);
 await refresh();}
 function filter(){const f=new FormData(q('[data-form="filters"]')),s=f.get('query').trim().toLowerCase(),rows=requests.filter(r=>r.id.toLowerCase().includes(s)&&(!f.get('model')||f.get('model')===r.model)&&(!f.get('status')||f.get('status')===r.status));q('[data-results]').innerHTML='<div class="dk-heading"><h2>请求明细</h2><span class="dk-muted">'+
rows.length+
' 条 · 最近 200 笔内</span></div>'+
(rows.length?receipts(rows):empty(requests.length?'没有匹配的请求':'尚无请求记录',requests.length?'调整条件或清空筛选。':'发起模型请求，然后刷新日志。'));}
 if(page==='logs'){filter();q('[data-form="filters"]').onsubmit=ev=>ev.preventDefault();q('[data-form="filters"]').oninput=filter;q('[data-form="filters"]').onreset=()=>setTimeout(filter,0);
 const id=new URLSearchParams(location.hash.split('?')[1]||'').get('id');
 if(id){q('[name=query]').value=id;filter();
 const r=requests.find(r=>r.id===id);
 if(r)receipt(r);else notify('当前日志中未找到此请求。')}
 else if(requests.length)receipt(requests[0],false);}
 desk.addEventListener('click',ev=>{const t=ev.target.closest('button');
 if(!t||busy)return;
 const a=t.dataset;
 if('snapshot'in a){
 const terminal=q('.dk-terminal'),snapshots=JSON.parse(terminal.querySelector('[data-terminal-data]').textContent);
 terminal.querySelector('[data-terminal-output]').textContent=JSON.stringify(snapshots[a.snapshot],null,2);
 terminal.querySelectorAll('[data-snapshot]').forEach(b=>b.setAttribute('aria-pressed',String(b===t)));
 }
 else if('receipt'in a){const r=requests.find(r=>r.id===a.receipt)||pending.find(r=>r.id===a.receipt);
 if(r)receipt(r)}
 else if('refresh'in a)perform(refresh);else if('revoke'in a){const k=keys[a.revoke];showConfirm('撤销「'+
e(k.name)+
'」？使用此密钥的新请求将被拒绝，此操作无法撤回。','确认撤销',()=>mutate('/api/keys/revoke',{id:k.id},'密钥已撤销'));}
 else if('lane'in a){const l=lanes[a.lane];showConfirm((l.enabled?'停用':'启用')+
'线路 '+
e(l.id)+
'？这将改变 '+
e(l.model)+
' 后续请求的路由候选。','确认变更',()=>mutate('/api/lanes',{id:l.id,enabled:!l.enabled},'线路状态已更新'));}
 else if('yes'in a&&confirmed)perform(confirmed);else if('no'in a)clear();});
 desk.addEventListener('submit',ev=>{ev.preventDefault();
 if(busy)return;
 const f=ev.target,v=new FormData(f);
 if(f.dataset.form==='create'){const name=v.get('name').trim();
 if(!name)return notify('请输入密钥名称');perform(async()=>{const {secret}=await api('/api/keys',{method:'POST',body:{name,scope:v.get('scope')}});modal('保存新密钥','<div class="dk-secret"><p>「'+
e(name)+
'」已创建。关闭后无法再查看明文，请先保存到密码管理器。</p><code>'+
e(secret)+
'</code><button class="dk-btn dk-primary" data-copy-key>复制密钥</button></div>');
 const c=document.querySelector('[data-copy-key]');
 if(c)c.onclick=()=>copy(secret);
 await refresh()});}
 else if(f.dataset.form==='budget'){const limit=Number(v.get('limit'));
 if(limit+1e-12<Number(b.spent)+Number(b.reserved))return notify('预算不能低于已结算与预留之和');showConfirm('将项目硬预算从 '+
money(b.limit)+
' 更新为 '+
money(limit)+
'？','确认更新',()=>mutate('/api/budget',{limit},'预算已更新'));}
 else if(f.dataset.form==='settle'){const r=pending[Number(f.dataset.index)],inputTokens=Number(v.get('inputTokens')),outputTokens=Number(v.get('outputTokens')),note=v.get('note').trim();
 if(!note)return notify('请填写核对依据');showConfirm('按请求单价结算 '+
e(r.id)+
'？输入 '+
fmt(inputTokens)+
'、输出 '+
fmt(outputTokens)+
' tokens，预计 '+
money(Math.ceil(inputTokens*r.price.input+outputTokens*r.price.output)/1e6)+
'。依据：'+
e(note)+
'。提交后不能重复结算。','确认结算',()=>mutate('/api/reconcile',{id:r.id,inputTokens,outputTokens,note},'已结算并记录核对依据'));}
 else if(f.dataset.form==='compare'){const delta=Math.round((Number(v.get('reference'))-Number(b.spent))*1e9)/1e9;f.querySelector('output').textContent=delta===0?'金额一致。此核对未更改账本。':'明细'+
(delta>0?'高于':'低于')+
'账本 '+
money(Math.abs(delta))+
'。请检查导出时间和结算状态。';}});
}
