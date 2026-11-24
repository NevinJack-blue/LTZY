const mode = m => m.kind === 'local-test' ? '本地测试' : 'HTTPS 上游';
const capabilities = m => (m.capabilities || []).map(c => ({chat:'对话', stream:'流式'}[c] || c)).join(' / ');
const usd = n => n != null && Number.isFinite(Number(n))
  ? '$' + Number(n).toLocaleString('en-US', {maximumFractionDigits:8}) : '未提供';
const label = s => '<div class="pa-kicker">' + s + '</div>';
const heading = (n,t,p='') => '<header class="pa-pagehead" data-build>' + label(n)
  + '<h1>' + t + '</h1><p>' + p + '</p></header>';
async function copy(text,ctx) {
  try { await navigator.clipboard.writeText(text); ctx.notify('已复制'); }
  catch { ctx.modal('请手动复制','<pre class="pa-manual">' + ctx.escape(text) + '</pre>'); }
}
function terminal() {
  return `<div class="pa-lab" data-build>
    <div class="pa-lab-bar"><span><i></i> LTZY / developer terminal</span><code>v1</code></div>
    <div class="pa-command-tabs" role="group" aria-label="终端命令示例">
      <button data-command="chat" aria-pressed="true">chat.send</button>
      <button data-command="stream" aria-pressed="false">stream.open</button>
      <button data-command="models" aria-pressed="false">models.list</button>
    </div>
    <pre class="pa-terminal-code" tabindex="0"></pre>
    <div class="pa-terminal-footer"><span>示例命令 · 不自动发送请求</span><button data-terminal-copy>复制命令 ↗</button></div>
    <div class="pa-anatomy"><span>REQUEST ANATOMY</span>
      <dl><div><dt>Authorization</dt><dd>Bearer / scoped key</dd></div>
      <div><dt>Transport</dt><dd class="pa-transport">HTTPS → JSON</dd></div>
      <div><dt>Trace</dt><dd>X-Request-ID → receipt</dd></div></dl>
    </div>
  </div>`;
}
function bindTerminal(r,ctx,model) {
  let command='chat';
  const pre=r.querySelector('.pa-terminal-code');
  function draw() {
    const base=location.origin;
    const lines=command==='models'
      ? ['curl -s '+base+'/v1/models', '  -H "Authorization: Bearer $LTZY_API_KEY"']
      : ['curl '+(command==='stream'?'-N ':'-i ')+base+'/v1/chat/completions',
        '  -H "Authorization: Bearer $LTZY_API_KEY"',
        '  -H "Content-Type: application/json"',
        "  -d '"+JSON.stringify({model:model||'YOUR_MODEL_ID',
          messages:[{role:'user',content:'你好'}],max_tokens:64,
          ...(command==='stream'?{stream:true}:{})},null,2)+"'"];
    pre.textContent=lines.join(' '+String.fromCharCode(92,10));
    r.querySelector('.pa-transport').textContent=command==='stream'?'HTTPS → text/event-stream':'HTTPS → application/json';
  }
  r.querySelectorAll('[data-command]').forEach(b=>b.onclick=()=>{
    command=b.dataset.command;
    r.querySelectorAll('[data-command]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
    draw();
  });
  r.querySelector('[data-terminal-copy]').onclick=()=>copy(pre.textContent,ctx);
  draw();
}
function home(r,ctx) {
  r.innerHTML = `
    <header class="pa-hero">
      <div class="pa-hero-copy" data-build>
        ${label('LTZY / MODEL ACCESS & USAGE LEDGER')}
        <h1>模型接入与用量管理，<br><span>在一个工作台完成。</span></h1>
        <p>统一查看可用模型、调用方式和价格，<br>按请求核对线路、用量与费用。</p>
        <div class="pa-actions"><a class="button primary" href="#models">查看模型目录 <span>↗</span></a>
          <a class="pa-link" href="#docs">阅读接入文档 <span>→</span></a></div>
        <ul class="pa-hero-points"><li>免费与收费分开标识</li><li>输入输出分别计价</li><li>请求记录可供核对</li></ul>
        <small class="pa-instance" role="status">正在读取实例配置…</small>
      </div>
      <div class="pa-hero-art">${terminal()}</div>
    </header>
    <div class="pa-bridge" data-build><span>一次请求，完整记录。</span>
      <div><b>兼容接入</b><i>→</i><b>智能选路</b><i>→</i><b>用量结算</b><i>→</i><b>完整回执</b></div></div>
    <section class="pa-workbench pa-reveal" data-build>
      <div class="pa-section-head"><div>${label('REQUEST PROCESSING')}<h2>请求处理与核对</h2></div>
        <p>下面展示一次请求的处理步骤。<br>交互演示不会发送实际模型调用。</p></div>
      <div class="pa-workbody">
        <div class="pa-topology">
          <div class="pa-topology-title"><span>请求路由实验台</span><span class="pa-topology-state">READY</span></div>
          <div class="pa-signal-map">
            <div class="pa-map-client"><i>↗</i><strong>你的应用</strong><small>一个兼容接口</small></div>
            <div class="pa-conduit"></div><div class="pa-map-gateway"><i>LT</i><strong>LTZY</strong><small>鉴权 / 预算 / 路由</small></div>
            <div class="pa-conduit pa-conduit-split"></div>
            <div class="pa-map-upstreams"><div class="pa-preferred"><i></i><span>首选上游<small>按配置优先级</small></span></div>
              <div class="pa-backup"><i></i><span>备用上游<small>仅响应开始前回退</small></span></div></div>
          </div>
          <div class="pa-node-tabs" role="group" aria-label="检查请求路径">
            <button data-node="client" aria-pressed="true">应用端</button>
            <button data-node="gateway" aria-pressed="false">网关</button>
            <button data-node="upstream" aria-pressed="false">上游</button>
          </div>
          <p class="pa-node-spec" aria-live="polite">应用端 / 使用服务端环境变量保存密钥，以 Bearer 发送请求。</p>
          <div class="pa-map-bottom"><code>POST /v1/chat/completions</code><span>同模型 · 安全回退</span></div>
        </div>
        <aside class="pa-inspector"><div class="pa-segment"><button data-mode="0" aria-pressed="true">正常请求</button>
          <button data-mode="1" aria-pressed="false">429 回退</button></div>
          <ol class="pa-stages"></ol><button class="pa-run">运行请求轨迹 ↗</button></aside>
      </div>
      <div class="pa-result"><span aria-live="polite"></span><button class="receipt">查看回执结构 ↗</button></div>
    </section>
    <section class="pa-possibilities pa-reveal" data-build>
      <div class="pa-section-head"><div>${label('WORKSPACE CAPABILITIES')}<h2>接入、计量与权限管理</h2></div>
        <div class="pa-scroll-controls"><button data-scroll="-1" aria-label="向前浏览能力卡片">←</button>
          <button data-scroll="1" aria-label="向后浏览能力卡片">→</button></div></div>
      <div class="pa-card-reel" tabindex="0" aria-label="产品能力，左右滚动浏览">
        <article class="pa-feature pa-feature-blue"><span>ROUTING</span><div class="pa-feature-object pa-routes"><i></i><i></i><i></i></div>
          <h3>模型路由</h3><p>用现有客户端调用已配置模型。首选上游受限时，在响应开始前尝试同模型备用渠道。</p><a href="#models">查看模型与能力 ↗</a></article>
        <article class="pa-feature pa-feature-silver"><span>ACCOUNTING</span><div class="pa-feature-object pa-receipt-object"><b>tokens</b><i></i><i></i><strong>USD / request</strong></div>
          <h3>费用计量</h3><p>输入、输出分开计量，保留当次计价快照。缺失用量标记待核对，不以零费用掩盖未知。</p><a href="#usage">管理用量与预算 ↗</a></article>
        <article class="pa-feature pa-feature-teal"><span>ACCESS CONTROL</span><div class="pa-feature-object pa-key-object">⌁<small>SCOPED ACCESS</small></div>
          <h3>密钥权限</h3><p>独立 API Key、模型权限与撤销管理。管理员会话与调用密钥分离，敏感信息不进入公共页面。</p><a href="#keys">管理 API 密钥 ↗</a></article>
        <article class="pa-feature pa-feature-iris"><span>OBSERVABILITY</span><div class="pa-feature-object pa-trace-object"><i></i><i></i><i></i><i></i></div>
          <h3>请求记录</h3><p>用请求 ID 关联尝试路径、响应状态与结算结果。流式中断后先核对，再决定是否重试。</p><a href="#logs">打开请求日志 ↗</a></article>
      </div>
    </section>
    <section class="pa-trust pa-reveal" data-build><div>${label('DATA & BOUNDARIES')}<h2>数据与处理边界</h2>
      <p>页面配置与计数来自当前实例。<br>本地测试适配器会明确标识，不冒充真实模型。</p></div>
      <div class="pa-trust-list"><details open><summary>你的数据会去哪里？</summary><p>真实推理请求会发送到你配置的 HTTPS 上游。请结合上游的数据政策决定可发送的内容，不要将敏感凭据放入提示词。</p></details>
        <details><summary>本地测试与真实推理有什么区别？</summary><p>本地适配器提供确定性回复，用于验证鉴权、流式传输与计量流程。它不是语言模型，不代表真实模型能力或响应速度。</p></details>
        <details><summary>失败之后，会自动重放吗？</summary><p>响应开始后不再切换上游；流式传输中断可能已有费用产生。请先用请求 ID 检查日志，避免重复调用。</p></details>
      </div></section>
    <section class="pa-endcap pa-reveal" data-build><span>GET STARTED</span><h2>从模型目录开始接入。<br>先确认价格，再创建密钥。</h2>
      <a class="button primary" href="#models">查看模型 ↗</a><a class="pa-link" href="#docs">阅读接入文档 →</a></section>
  `;
  r.querySelectorAll('[data-node]').forEach(b=>b.onclick=()=>{
    r.querySelectorAll('[data-node]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
    r.querySelector('.pa-topology').dataset.selected=b.dataset.node;
    r.querySelector('.pa-node-spec').textContent={
      client:'应用端 / 使用服务端环境变量保存密钥，以 Bearer 发送请求。',
      gateway:'网关 / 验证权限、预留预算，再按已配置优先级选择同模型渠道。',
      upstream:'上游 / 响应开始前允许安全回退；流式开始后不再重放。'
    }[b.dataset.node];
  });
  let fallback=false, sequence=0;
  const stages=r.querySelector('.pa-stages'), message=r.querySelector('.pa-result [aria-live]');
  const run=r.querySelector('.pa-run'), topology=r.querySelector('.pa-topology');
  const items=()=>[['入口鉴权','验证 API Key'],['预算预留','检查可用额度'],
    fallback?['首选限流','429 · 响应尚未开始']:['首选路由','按优先级发送'],
    fallback?['备用响应','同一模型重新选路']:['接收响应','获取模型输出'],['用量结算','保留计价快照']];
  function paint(index) {
    stages.innerHTML=items().map(([a,b],j)=>`<li class="${j<=index?'on':''}"><i>${j<index?'✓':j+1}</i><div><strong>${a}</strong><small>${b}</small></div></li>`).join('');
    topology.classList.toggle('running',index>=0);
    topology.classList.toggle('fallback',fallback);
    r.querySelector('.pa-topology-state').textContent=index<0?'READY':index===4?'COMPLETE':'PROCESSING';
    message.textContent=index<0?'选择场景，查看请求如何穿过网关。':index===4
      ?(fallback?'回退完成 · 首选 429 后切换同模型备用上游。':'请求完成 · 首选上游成功响应。'):'执行中 / '+items()[index][0];
  }
  paint(-1);
  r.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{
    sequence++; fallback=b.dataset.mode==='1';
    r.querySelectorAll('[data-mode]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
    run.disabled=false; run.textContent='运行请求轨迹 ↗'; paint(-1);
  });
  run.onclick=async()=>{
    const token=++sequence; run.disabled=true;
    for(let i=0;i<5;i++) {
      if(token!==sequence||!r.isConnected)return;
      paint(i);
      if(i<4)await new Promise(ok=>setTimeout(ok,matchMedia('(prefers-reduced-motion: reduce)').matches?0:380));
    }
    run.disabled=false; run.textContent='重新运行 ↗';
  };
  r.querySelector('.receipt').onclick=()=>ctx.modal('请求回执结构',
    '<p>以下说明字段，不是实际调用记录。</p><dl class="pa-dl">'
    +'<dt>request_id</dt><dd>每次请求的唯一标识</dd><dt>attempts</dt><dd>'
    +(fallback?'首选 429 → 同模型备用上游':'首选上游成功响应')
    +'</dd><dt>usage</dt><dd>输入与输出 tokens</dd><dt>pricing_snapshot</dt><dd>调用时价格快照</dd>'
    +'<dt>cost / state</dt><dd>已结算费用或待核对状态</dd></dl><a class="button primary" href="#logs">查看真实请求日志 →</a>');
  r.querySelectorAll('[data-scroll]').forEach(b=>b.onclick=()=>r.querySelector('.pa-card-reel').scrollBy({
    left:Number(b.dataset.scroll)*390,
    behavior:matchMedia('(prefers-reduced-motion: reduce)').matches
      || document.documentElement.classList.contains('motion-quiet')?'instant':'smooth'
  }));
}

const priceZero=v=>v!=null&&Number.isFinite(Number(v))&&Number(v)===0;
const isFree=m=>priceZero(m.inputPrice)&&priceZero(m.outputPrice);
const glyphOf=p=>String(p||'??').replace(/[^0-9A-Za-z]/g,'').slice(0,2).toUpperCase()||'??';
function catalog(r,data,ctx) {
  const e=ctx.escape,list=data.models||[];
  const capsOf=m=>(m.capabilities||[]).map(c=>({chat:'对话',stream:'流式'}[c]||c));
  const groups=[
    {id:'free',number:'01',title:'免费分组',desc:'输入与输出单价均为 0 的模型。'},
    {id:'paid',number:'02',title:'收费分组',desc:'存在非零单价的模型，按实际用量计费。'}
  ];
  const groupOf=m=>isFree(m)?'free':'paid';
  const providers=[...new Set(list.map(m=>m.provider))].sort();
  r.innerHTML=`
    <section class="pa-plaza-intro" data-build><div>
      <span class="pa-eyebrow">免费与收费，分开标清楚</span>
      <h1>模型广场</h1>
      <p>当前实例配置的全部模型，按输入与输出单价分成免费与收费两组。价格均为每百万 tokens 的美元单价，来自实时接口。</p></div>
      <div class="pa-public-note"><strong>先看分组，再选模型</strong><span>免费模型单价为 0；收费模型按实际用量计费。</span></div></section>
    <div class="pa-plaza-layout">
      <aside class="pa-catalog-filter" data-build>
        <label>搜索<input type="search" placeholder="搜索模型名称"></label>
        <span class="pa-panel-label">按费用分组</span>
        <div class="pa-group-switch" role="group" aria-label="按费用分组"><span class="pa-switch-thumb" aria-hidden="true"></span>
          ${['all','free','paid'].map(id=>'<button type="button" data-billing="'+id+'" aria-pressed="false">'
            +(id==='all'?'全部':groups.find(g=>g.id===id).title.replace('分组',''))
            +'<span>'+(id==='all'?list.length:list.filter(m=>groupOf(m)===id).length)+'</span></button>').join('')}
        </div>
        <label>供应商<select><option value="">全部供应商</option>
          ${providers.map(p=>'<option value="'+e(p)+'">'+e(p)+'</option>').join('')}</select></label>
        <div class="pa-filter-note"><i>↳</i><p>分组依据实际配置的单价：输入与输出均为 0 归入免费，否则收费。启用不代表上游已通过实时健康探测。</p></div>
      </aside>
      <section class="pa-catalog-results" data-build><div class="pa-tablemeta"><span aria-live="polite"></span><span>USD / 百万 tokens</span></div>
        <div class="pa-models"></div></section>
    </div>`;
  const search=r.querySelector('input'),provider=r.querySelector('select'),rows=r.querySelector('.pa-models');
  let billing='all',switchVersion=0,found=[];
  function updateSwitch() {
    const order=['all','free','paid'];
    r.querySelector('.pa-group-switch').style.setProperty('--billing-index',order.indexOf(billing));
    r.querySelectorAll('[data-billing]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.billing===billing)));
  }
  function observed(m) {const x=m.metrics||{};return `<div class="pa-model-observed"><div><span>已完成成功率</span><strong>${x.successRate==null?'暂无数据':e(String(x.successRate))+'%'}</strong></div><div><span>累计请求</span><strong>${e(String(x.requests||0))} 次</strong></div><div><span>平均响应时间</span><strong>${x.averageLatencyMs==null?'暂无数据':e(String(x.averageLatencyMs))+' ms'}</strong></div></div>`}
  function card(m,i) {const g=groupOf(m),free=g==='free';return `
    <article class="pa-model-card"><div class="pa-modeltop"><span class="pa-provider">${e(m.provider)}</span>
      <span class="pa-badge ${free?'pa-badge-free':'pa-badge-paid'}">${free?'免费':'收费'}</span></div>
      <div class="pa-model-identity"><div class="pa-model-glyph">${e(glyphOf(m.provider))}<span>${m.enabled?'':'·'}</span></div>
        <div><h2>${e(m.id)}</h2><p>${e(mode(m))} · ${m.enabled?'已启用':'已停用'}</p></div></div>
      <p class="pa-model-summary">${m.kind==='local-test'?'用于验证鉴权、流式响应与计量流程的本地测试线路。':'当前实例配置的 HTTPS 上游线路，支持对话与流式调用。'}</p>
      <div class="pa-model-tags"><span class="pa-tag blue">${free?'免费':'收费'}</span>${capsOf(m).map(c=>'<span class="pa-tag">'+e(c)+'</span>').join('')}
        ${m.kind==='local-test'?'<span class="pa-tag">本地测试</span>':''}</div>
      <dl class="pa-modelspec"><div><dt>输入 / 1M tokens</dt><dd>${usd(m.inputPrice)}</dd></div>
        <div><dt>输出 / 1M tokens</dt><dd>${usd(m.outputPrice)}</dd></div>
        <div><dt>上下文窗口</dt><dd>${m.context?e(String(m.context)):'未提供'}</dd></div></dl>
      ${observed(m)}
      <div class="pa-model-actions"><button class="pa-link" data-detail="${i}">查看详情 ↗</button><button class="pa-copy" data-copy="${i}">复制模型 ID</button></div></article>`;}
  function draw() {
    const q=search.value.trim().toLowerCase(),pv=provider.value;
    found=list.filter(m=>(m.id+' '+m.provider).toLowerCase().includes(q)&&(!pv||pv===m.provider)
      &&(billing==='all'||groupOf(m)===billing));
    r.querySelector('[aria-live]').textContent=found.length+' 个匹配模型';
    rows.innerHTML=found.length?groups.filter(g=>billing==='all'||g.id===billing).map(g=>{
      const sub=found.map((m,i)=>({m,i})).filter(x=>groupOf(x.m)===g.id);
      if(!sub.length)return '';
      return '<section class="pa-model-group"><header class="pa-group-head"><span>'+g.number+'</span>'
        +'<h2>'+g.title+'</h2><p>'+e(g.desc)+'</p><span class="pa-group-count">'+sub.length+' 个模型</span></header>'
        +'<div class="pa-model-grid">'+sub.map(x=>card(x.m,x.i)).join('')+'</div></section>';
    }).join(''):'<div class="pa-empty"><h2>没有匹配的模型</h2><p>试试更短的关键词，或切回「全部」分组。</p><button class="button" data-reset>清除筛选</button></div>';
    rows.onclick=ev=>{
      const b=ev.target.closest('button'); if(!b)return;
      if('reset'in b.dataset){search.value=provider.value='';billing='all';updateSwitch();draw();return;}
      if('copy'in b.dataset){copy(found[b.dataset.copy].id,ctx);return;}
      const m=found[b.dataset.detail],free=groupOf(m)==='free';
      const sheet=ctx.modal('模型详情','<h2 class="pa-modelid">'+e(m.id)+'</h2>'
        +'<p class="pa-detail-line">'+e(m.provider)+' · '+e(mode(m))+' · '+e(groups.find(g=>g.id===groupOf(m)).title)
        +' · '+(m.enabled?'已启用':'已停用')+'</p><dl class="pa-dl">'
        +'<dt>能力</dt><dd>'+e(capsOf(m).join(' / ')||'未提供')+'</dd>'
        +'<dt>上下文窗口</dt><dd>'+(m.context?e(String(m.context))+' tokens':'未提供')+'</dd>'
        +'<dt>输入 / 百万 tokens</dt><dd>'+usd(m.inputPrice)+'</dd>'
        +'<dt>输出 / 百万 tokens</dt><dd>'+usd(m.outputPrice)+'</dd></dl>'
        +'<p>'+(m.kind==='local-test'?'确定性测试适配器，不提供真实模型推理。':free?'输入与输出单价均为 0，按配置不产生平台调用费。':'存在非零单价，按实际用量计费；每次请求保留独立价格快照。')+'</p>'
        +observed(m)
        +'<div class="pa-modal-actions"><button class="button" data-copy-id>复制模型 ID</button><a class="button primary" href="#docs">接入文档 →</a></div>');
      sheet.querySelector('[data-copy-id]').onclick=()=>copy(m.id,ctx);
    };
  }
  async function setBilling(next) {
    if(next===billing)return;
    const prev=billing,order=['all','free','paid'];
    const dir=order.indexOf(next)>order.indexOf(prev)?1:-1;
    billing=next; const version=++switchVersion;
    updateSwitch();
    const quiet=matchMedia('(prefers-reduced-motion: reduce)').matches
      ||document.documentElement.classList.contains('motion-quiet');
    if(quiet||!rows.animate){draw();return;}
    rows.getAnimations().forEach(a=>a.cancel());
    const leave=rows.animate([{opacity:1,transform:'translateX(0)'},
      {opacity:0,transform:'translateX('+(-14*dir)+'px)'}],{duration:120,easing:'ease-in',fill:'forwards'});
    try{await leave.finished}catch{}
    if(version!==switchVersion||!r.isConnected)return;
    draw();
    leave.cancel();
    rows.animate([{opacity:0,transform:'translateX('+(14*dir)+'px)'},
      {opacity:1,transform:'translateX(0)'}],{duration:190,easing:'cubic-bezier(.2,.75,.25,1)'});
  }
  r.querySelectorAll('[data-billing]').forEach(b=>b.onclick=()=>setBilling(b.dataset.billing));
  search.oninput=provider.onchange=draw;
  updateSwitch();draw();
}
function docs(r,data,ctx) {
  const models=data.models.filter(m=>m.enabled), e=ctx.escape;
  r.innerHTML=`
    ${heading('DEVELOPER WORKSPACE','接入文档','保留熟悉的接口，把路由、预算与用量交给网关。')}
    <div class="pa-docgrid"><aside class="pa-doc-steps" data-build>
      <a href="#keys"><b>01</b><span>创建 API Key<small>设置模型权限，安全保存密钥</small></span><i>↗</i></a>
      <div><b>02</b><span>发送你的请求<small>选择模型，复制右侧示例</small></span></div>
      <a href="#logs"><b>03</b><span>核对用量回执<small>用请求 ID 找到调用记录</small></span><i>↗</i></a>
      <div class="pa-secret-note"><strong>密钥只留在服务端。</strong><p>使用环境变量 <code>LTZY_API_KEY</code>。不要将它写入浏览器代码或提交到仓库。</p></div>
    </aside><section class="pa-doc-main" data-build>
      <div class="pa-doc-intro"><h2>发送第一条消息</h2><span>POST <code>/v1/chat/completions</code></span></div>
      <div class="pa-doc-options"><label>已启用模型<select>${models.map((m,i)=>'<option value="'+i+'">'+e(m.id)+' · '+mode(m)+'</option>').join('')}</select></label>
        <label class="pa-stream-toggle"><input type="checkbox">流式响应 <code>SSE</code></label></div>
      <div class="pa-codebox"><div class="pa-codebar"><div class="pa-lang"><button aria-pressed="true">cURL</button><button aria-pressed="false">Python</button></div><button data-copy>复制代码 ↗</button></div><pre tabindex="0"></pre></div>
      <div class="pa-doc-note"><span>↳</span><p>示例使用当前页面的域名，不会自动发送请求。使用响应头 <code>X-Request-ID</code> 到<a href="#logs">请求日志</a>核对实际用量。</p></div>
    </section></div>
    <section class="pa-request-spec pa-reveal" aria-label="请求字段规范">
      <div><h2>请求结构</h2><p>兼容接口，显式边界。</p></div>
      <dl><div><dt>model <em>required</em></dt><dd>当前已启用且密钥有权访问的模型 ID。</dd></div>
        <div><dt>messages <em>required</em></dt><dd>包含 role 与 content 的消息数组。</dd></div>
        <div><dt>max_tokens</dt><dd>预留输出预算；示例限制为 64 tokens。</dd></div>
        <div><dt>stream</dt><dd>仅在模型支持流式时启用，按 SSE 逐条读取。</dd></div>
        <div><dt>X-Request-ID <em>response</em></dt><dd>响应头中的调用标识，用于核对日志与费用。</dd></div>
      </dl></section>
    <section class="pa-doc-reference pa-reveal"><div><h2>接口速查</h2><p>精简的协议，清晰的边界。</p></div><div>
      <details open><summary><code>GET /v1/models</code><span>查询可用模型</span></summary><p>携带 Bearer 密钥，获取该密钥允许访问的模型。密钥权限和模型启用状态共同决定可用范围。</p></details>
      <details><summary><code>POST /v1/chat/completions</code><span>对话与流式响应</span></summary><p>传入 model、messages 与 max_tokens；启用 stream 时按 SSE 消费响应。响应开始后不再回退到其他上游。</p></details>
      <details><summary><code>401 / 403 / 429</code><span>鉴权、权限与限流</span></summary><p>检查密钥是否有效、模型权限是否匹配。预算不足时检查限额与预留；限流时稍后重试，不要连续重发。</p></details>
      <details><summary><code>usage / reconciliation</code><span>计量与待核对</span></summary><p>如果上游未返回完整用量，记录会保持待核对。流式中断不等于免费，也不应在确认前盲目重放请求。</p></details>
    </div></section>
  `;
  let lang='cURL';
  const select=r.querySelector('select'),stream=r.querySelector('input'),pre=r.querySelector('pre'),btn=r.querySelector('[data-copy]');
  function draw() {
    const m=models[select.value],url=location.origin+'/v1/chat/completions';
    btn.disabled=!m;
    if(!m){pre.textContent='暂无已启用模型。请先在运营台启用一条路由。';return;}
    stream.disabled=!m.capabilities?.includes('stream'); if(stream.disabled)stream.checked=false;
    const body={model:m.id,messages:[{role:'user',content:'你好'}],max_tokens:64};
    if(stream.checked)body.stream=true;
    const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
    pre.textContent=lang==='cURL'?[
      'curl '+(stream.checked?'-N ':'-i ')+q(url),
      '  -H "Authorization: Bearer $LTZY_API_KEY"',
      "  -H 'Content-Type: application/json'",
      '  -d '+q(JSON.stringify(body,null,2))
    ].join(' '+String.fromCharCode(92,10)):`import json, os, urllib.request

payload = ${JSON.stringify(body,null,2).replace(/"stream": true/, '"stream": True')}
req = urllib.request.Request(
    ${JSON.stringify(url)},
    data=json.dumps(payload).encode(),
    headers={
        "Authorization": "Bearer " + os.environ["LTZY_API_KEY"],
        "Content-Type": "application/json",
    },
)
with urllib.request.urlopen(req) as res:
    print(res.headers.get("X-Request-ID"))
${stream.checked?'    for line in res:\n        print(line.decode().rstrip())':'    print(json.load(res))'}`;
  }
  select.onchange=stream.onchange=draw;
  r.querySelectorAll('.pa-lang button').forEach(b=>b.onclick=()=>{
    lang=b.textContent;
    r.querySelectorAll('.pa-lang button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));draw();
  });
  btn.onclick=()=>copy(pre.textContent,ctx);draw();
}
function status(r,data,ctx) {
  const s=data.status,e=ctx.escape,date=new Date(s.updatedAt),total=Number(s.requests)||0;
  const success=total?Math.min(100,Math.max(0,Number(s.successful)/total*100)):0;
  r.innerHTML=`
    <div class="pa-status-title">${heading('INSTANCE OBSERVATORY','实例状态','没有模拟历史曲线，只有当前实例的实际记录。')}<button class="button" data-refresh>刷新数据 ↻</button></div>
    <section class="pa-status-banner" data-build><div><span class="pa-status-dot"></span><strong>公开接口可访问</strong></div>
      <span>最后更新 ${e(Number.isNaN(date.valueOf())?String(s.updatedAt):date.toLocaleString('zh-CN'))}</span></section>
    <div class="pa-status-layout"><section class="pa-status-main" data-build>
      <div class="pa-stats">${[['累计请求',s.requests],['成功完成',s.successful],['失败请求',s.failed]].map(([a,b])=>'<div><span>'+a+'</span><strong>'+e(String(b))+'</strong></div>').join('')}</div>
      <div class="pa-distribution"><div class="pa-status-orb" style="--success:${success}%"><div><strong>${total?success.toFixed(1)+'%':'—'}</strong><span>${total?'请求成功占比':'尚无调用样本'}</span></div></div>
        <div><span class="pa-panel-label">REQUEST OUTCOMES</span><h2>${total?'每条记录，都有归处。':'一切就绪，等待首条请求。'}</h2><p>成功 ${e(String(s.successful))} / 总计 ${e(String(s.requests))}</p>
          <p>统计包含本地测试适配器调用，不代表真实上游可用率。不根据累计计数推算历史 SLA。</p><a class="pa-link" href="#logs">查看请求明细 ↗</a></div></div>
    </section><aside class="pa-lane-summary" data-build><span class="pa-panel-label">ROUTE CONFIGURATION</span><div class="pa-lane-number">${e(String(s.enabledLanes))}<small>/ ${e(String(s.totalLanes))}</small></div>
      <h2>当前启用渠道</h2><p>启用表示允许参与路由，不代表上游已经通过实时健康探测。</p><a class="pa-link" href="#models">查看已配置模型 →</a>
      <div class="pa-lane-visual" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></aside></div>
    <section class="pa-status-definitions pa-reveal"><h2>如何理解这些数字？</h2><div><article><h3>接口可访问 ≠ 上游健康</h3><p>此页面成功读取公共接口，仅表明当前网关可以响应。上游实际结果请以调用日志为准。</p></article><article><h3>累计计数 ≠ 历史监控</h3><p>当前接口没有提供时间序列，所以不展示虚构的延迟曲线、在线时长或历史事件。</p></article></div></section>
  `;
  r.querySelector('[data-refresh]').onclick=()=>renderPublic('status',ctx);
}
function reveal(r) {
  const root=r.parentElement, media=matchMedia('(prefers-reduced-motion: reduce)');
  const elements=[...r.querySelectorAll('.pa-reveal')];
  const quiet=()=>media.matches || document.documentElement.classList.contains('motion-quiet');
  let observer, preferenceObserver;
  function dispose() {
    observer?.disconnect();
    preferenceObserver?.disconnect();
    media.removeEventListener('change',updatePreference);
    root.removeEventListener('ltzy:dispose',dispose);
  }
  function updatePreference() {
    if(!quiet())return;
    elements.forEach(el=>el.classList.add('pa-visible'));
    dispose();
  }
  if(quiet()) {elements.forEach(el=>el.classList.add('pa-visible'));return;}
  observer=new IntersectionObserver(entries=>{
    entries.forEach(entry=>{
      if(entry.isIntersecting) {
        entry.target.classList.add('pa-visible');
        observer.unobserve(entry.target);
      }
    });
    if(!r.isConnected)dispose();
  },{threshold:.08});
  elements.forEach(el=>observer.observe(el));
  preferenceObserver=new MutationObserver(updatePreference);
  preferenceObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  media.addEventListener('change',updatePreference);
  root.addEventListener('ltzy:dispose',dispose,{once:true});
}
export async function renderPublic(page,ctx) {
  ctx.root.innerHTML='<div class="pa pa-page-'+page+'"></div>';
  const r=ctx.root.firstElementChild;
  if(page==='home') {
    home(r,ctx);bindTerminal(r,ctx);reveal(r);
    try {
      const {models}=await ctx.api('/api/public');if(!r.isConnected)return;
      const enabled=models.filter(x=>x.enabled);
      bindTerminal(r,ctx,enabled[0]?.id);
      r.querySelector('.pa-instance').textContent=enabled.length&&enabled.every(x=>x.kind==='local-test')
        ?'当前实例仅启用本地测试 · 不调用外部服务'
        :'当前实例 · '+enabled.length+' 个已启用模型（免费 '+enabled.filter(isFree).length
          +' / 收费 '+(enabled.length-enabled.filter(isFree).length)+'）';
    } catch {if(r.isConnected)r.querySelector('.pa-instance').textContent='暂时无法读取实例配置。';}
    return;
  }
  r.innerHTML='<p class="pa-loading" role="status">正在读取当前实例…</p>';
  try {
    const data=await ctx.api('/api/public');if(!r.isConnected)return;
    ({models:catalog,docs,status}[page])(r,data,ctx);reveal(r);
  } catch {
    if(!r.isConnected)return;
    r.innerHTML='<div class="pa-empty"><h1>暂时无法读取数据</h1><p>请检查网关服务，再重新加载。</p><button class="button">重试</button></div>';
    r.querySelector('button').onclick=()=>renderPublic(page,ctx);
  }
}
