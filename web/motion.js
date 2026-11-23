/** LTZY build sequence: measured, sequential, original implementation.
 *  Concept reference only (task ordering / typing feel). No third-party code copied.
 */
const SEEN_KEY = 'ltzy:signal-assembly:v4';
const TEAMS = [
  { name: 'LAYOUT', cmd: 'frame.layout()', color: '#2463f4' },
  { name: 'TYPE', cmd: 'text.compose()', color: '#713de0' },
  { name: 'ROUTE', cmd: 'path.connect()', color: '#00879e' },
  { name: 'BUILD', cmd: 'view.commit()', color: '#c2410c' },
];
let seenMemory = false;
function seen() {
  try { return seenMemory || sessionStorage.getItem(SEEN_KEY) === '1'; }
  catch { return seenMemory; }
}
function remember() {
  seenMemory = true;
  try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
}
function quiet() {
  if (document.documentElement.classList.contains('motion-quiet')) return true;
  try { return localStorage.getItem('ltzy-reduced-motion') === 'true'; }
  catch { return false; }
}
function liteReason() {
  const root = document.documentElement;
  if (root.dataset.quality === 'lite') return 'user-quality';
  if (root.dataset.qualityChoice === 'full') return '';
  if (navigator.connection?.saveData) return 'save-data';
  if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) return 'cpu-cores';
  if (navigator.deviceMemory && navigator.deviceMemory <= 4) return 'device-memory';
  return '';
}
function targets(root) {
  const nodes = [...root.querySelectorAll('[data-build],h1,h2,.pa-codebox,.dk-section,.dk-stats')];
  const rows = nodes.map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(x => x.r.width > 60 && x.r.height > 26 && x.r.top < innerHeight - 24 && x.r.bottom > 60);
  const top = [];
  for (const row of rows) {
    if (top.length >= 4) break;
    if (top.some(x => x.el.contains(row.el))) continue;
    top.push(row);
  }
  return top;
}
const ease = 'cubic-bezier(.16,.8,.24,1)';
const line = 'cubic-bezier(.45,0,.2,1)';

export function mountMotion(root, { replay = false } = {}) {
  if (!root?.isConnected) return () => {};
  const started = performance.now();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const first = replay || !seen();
  remember();
  const reason = liteReason();
  let lite = !!reason;
  let disposed = false, raf = 0, overlay, deadline = 0;
  let previous = 0, frames = 0, frameTotal = 0, worst = 0, samples = 0;
  const animations = [], typers = [], listeners = [];
  const T = replay
    ? { box: 300, boxGap: 210, boxDur: 620, type: 1250, typeGap: 430, typeDur: 800,
        route: 2450, routeDur: 520, build: 2950, buildGap: 120, end: 4000 }
    : { box: 200, boxGap: 150, boxDur: 520, type: 850, typeGap: 330, typeDur: 620,
        route: 1450, routeDur: 400, build: 1650, buildGap: 90, end: 2450 };
  const phaseAt = { LAYOUT: T.box - 120, TYPE: T.type - 120, ROUTE: T.route - 120, BUILD: T.build - 90 };
  const ROUTE_TOTAL = 900;
  const total = first ? T.end : ROUTE_TOTAL;
  const stats = {
    version: 4, mode: quiet() || reduce.matches ? 'quiet' : lite ? 'lite' : 'normal',
    kind: replay ? 'replay' : first ? 'intro' : 'route',
    plannedDuration: total, duration: 0, frames: 0, avgFrameMs: 0, maxFrameMs: 0,
    sampleCount: 0, cursorCount: 0, boxes: 0, typed: 0,
    renderer: 'dom-sequential', networkMeasurement: false, animationOnly: true,
    phases: first ? TEAMS.map(t => ({ role: t.name, startsAt: phaseAt[t.name] })) : [],
    active: false, endedReason: null, liteReason: reason || null, downgraded: false,
  };
  window.__ltzyMotionStats = stats;
  const listen = (el, type, fn, opt) => {
    el.addEventListener(type, fn, opt);
    listeners.push(() => el.removeEventListener(type, fn, opt));
  };
  function finish(why = 'cleanup') {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    clearTimeout(deadline);
    animations.forEach(a => a.cancel());
    listeners.forEach(off => off());
    overlay?.remove();
    stats.active = false;
    stats.duration = Math.round((performance.now() - started) * 100) / 100;
    stats.endedReason = why;
  }
  const cleanup = () => finish('route-cleanup');
  if (stats.mode === 'quiet') { finish('reduced-motion'); return cleanup; }
  const found = targets(root);
  if (!found.length || !Element.prototype.animate) { finish('nothing-to-build'); return cleanup; }
  function play(el, frames, opts = {}) {
    const a = el.animate(frames, { easing: ease, fill: 'both', ...opts });
    animations.push(a);
    return a;
  }
  const startedPhases = {};
  function mark(phase) {
    if (startedPhases[phase]) return;
    startedPhases[phase] = true;
    const chip = overlay?.querySelector('[data-log="' + phase + '"]');
    if (chip) play(chip, [{ opacity: 0, transform: 'translate3d(-8px,0,0)' },
      { opacity: 1, transform: 'translate3d(0,0,0)' }], { duration: 280, easing: line });
  }
  stats.active = true;
  overlay = document.createElement('div');
  overlay.className = 'ltzy-build' + (lite ? ' ltzy-build-lite' : '') +
    (first ? '' : ' ltzy-build-clear');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML =
    '<div class="ltzy-build-head"><b>LTZY / BUILD TRACE</b>' +
    '<span>界面构建演示 · 非网络进度</span></div>' +
    '<div class="ltzy-build-log">' + TEAMS.map(t =>
      '<div data-log="' + t.name + '"><i style="--c:' + t.color + '"></i>' +
      '<span>' + t.name + '</span><code>' + t.cmd + '</code></div>').join('') +
    '</div>' +
    '<div class="ltzy-build-bar"><i></i></div>' +
    '<button type="button" class="ltzy-build-skip">跳过 <span>Esc</span></button>';
  document.body.append(overlay);
  const bar = overlay.querySelector('.ltzy-build-bar > i');
  play(overlay, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: line });
  play(bar, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
    { duration: total - 120, easing: 'linear' });
  const skip = overlay.querySelector('.ltzy-build-skip');
  listen(skip, 'click', () => finish('skip'));
  listen(window, 'keydown', e => { if (e.key === 'Escape') finish('escape'); });
  listen(root, 'pointerdown', () => finish('interaction'), { passive: true });
  listen(window, 'wheel', () => finish('scroll'), { passive: true, once: true });

  // Route transitions keep the overlay transparent and skip heavy decoration;
  // only the team log lights up briefly over the already-rendered page.
  const boxes = [];
  const texts = [];
  const cursors = [];
  if (first) {
  found.forEach((item, i) => {
    const r = item.r;
    const box = document.createElement('div');
    box.className = 'ltzy-box';
    box.style.cssText = 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
    box.innerHTML = '<span>0' + (i + 1) + ' / ' + TEAMS[0].name + '</span>';
    overlay.append(box);
    boxes.push({ el: box, r });
    // A crosshair cursor drags the frame out from the top-left corner to the
    // bottom-right; the box grows with the exact same timing, Figma-style.
    const draw = document.createElement('div');
    draw.className = 'ltzy-cursor ltzy-draw';
    draw.style.setProperty('--c', TEAMS[i % TEAMS.length].color);
    draw.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18">' +
      '<path d="M9 1v16M1 9h16" stroke="var(--c)" stroke-width="1.4" fill="none"/>' +
      '<circle cx="9" cy="9" r="3.4" fill="none" stroke="var(--c)" stroke-width="1.4"/></svg>';
    overlay.append(draw);
    const dFromX = r.left - 22, dFromY = r.top - 18;
    const dToX = r.left + r.width + 10, dToY = r.top + r.height + 10;
    play(draw, [
      { transform: 'translate3d(' + Math.round(dFromX) + 'px,' + Math.round(dFromY) + 'px,0)', opacity: 0 },
      { transform: 'translate3d(' + Math.round(dFromX) + 'px,' + Math.round(dFromY) + 'px,0)', opacity: 1, offset: .1 },
      { transform: 'translate3d(' + Math.round(dToX) + 'px,' + Math.round(dToY) + 'px,0)', opacity: 1, offset: .88 },
      { transform: 'translate3d(' + Math.round(dToX) + 'px,' + Math.round(dToY) + 'px,0)', opacity: 0 },
    ], { duration: T.boxDur, delay: T.box + i * T.boxGap, easing: line });
    play(box, [
      { transform: 'scale(0)' },
      { transform: 'scale(1)' },
    ], { duration: T.boxDur, delay: T.box + i * T.boxGap, easing: line });
    play(box.querySelector('span'), [{ opacity: 0 }, { opacity: 1 }],
      { duration: 180, delay: T.box + i * T.boxGap + T.boxDur * .8, easing: line });
  });
  // Headings are re-typed character by character on their own beat.
  const headings = [...root.querySelectorAll('h1,h2')]
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(x => x.r.width > 80 && x.r.top < innerHeight - 24 && x.r.bottom > 40)
    .slice(0, 3);
  headings.forEach(({ el, r }) => {
    const words = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    if (words.length < 6) return;
    const cs = getComputedStyle(el);
    const ghost = document.createElement('div');
    ghost.className = 'ltzy-type';
    ghost.style.cssText = 'left:' + r.left + 'px;top:' + r.top +
      'px;width:' + Math.min(r.width, innerWidth - 40) + 'px;font-size:' + cs.fontSize +
      ';font-weight:' + cs.fontWeight + ';line-height:' + cs.lineHeight +
      ';letter-spacing:' + cs.letterSpacing + ';color:' + cs.color;
    ghost.innerHTML = '<span class="ltzy-text"></span><i class="ltzy-caret"></i>';
    overlay.append(ghost);
    texts.push({ body: ghost.querySelector('.ltzy-text'),
      caret: ghost.querySelector('.ltzy-caret'), full: words, n: 0,
      from: T.type + texts.length * T.typeGap, dur: T.typeDur });
  });
  stats.boxes = boxes.length;
  stats.typed = texts.length;
  texts.forEach(t => {
    play(t.caret, [{ opacity: 0 }, { opacity: 1 }], { duration: 120, delay: t.from, easing: line });
  });

  // Connector drawn only after the layout boxes have settled.
  if (boxes.length >= 2) {
    const a = boxes[0].r, b = boxes[1].r;
    const x1 = a.left + a.width * .5, y1 = a.top + a.height;
    const x2 = b.left + 18, y2 = b.top + Math.min(b.height * .5, 60);
    const len = Math.hypot(x2 - x1, y2 - y1), angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    const path = document.createElement('div');
    path.className = 'ltzy-route';
    path.innerHTML = '<i></i>';
    path.style.cssText = 'left:' + x1 + 'px;top:' + y1 + 'px;width:' + len + 'px;transform:rotate(' + angle + 'deg)';
    overlay.append(path);
    play(path.querySelector('i'), [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
      { duration: T.routeDur, delay: T.route, easing: line });
    play(path, [{ opacity: 0 }, { opacity: 1 }], { duration: 140, delay: T.route, easing: line });
  }

  const teamTargets = TEAMS.map((t, i) => boxes[i % boxes.length] || boxes[0]);
  const count = lite ? 12 : 16;
  for (let i = 0; i < count; i++) {
    const team = i % 4, worker = Math.floor(i / 4);
    const box = teamTargets[team];
    const c = document.createElement('div');
    c.className = 'ltzy-cursor';
    c.dataset.team = String(team);
    c.style.setProperty('--c', TEAMS[team].color);
    c.innerHTML = '<svg width="16" height="19" viewBox="0 0 22 26"><path d="M2 1.5 19 15 11.5 16.1 8 23Z"></path></svg>' +
      (i < 4 ? '<span>' + TEAMS[team].name + '</span>' : '');
    overlay.append(c);
    cursors.push(c);
    const toX = box.r.left + 12 + (worker / Math.max(1, Math.ceil(count / 4) - 1)) *
      Math.max(60, box.r.width - 44);
    const toY = box.r.top + (worker % 2 === 0 ? 8 : Math.max(8, box.r.height - 30));
    const orbitAngle = (team / 4) * Math.PI * 2 + worker * .4;
    const fromX = toX + Math.cos(orbitAngle) * 130;
    const fromY = toY + Math.sin(orbitAngle) * 90;
    const start = phaseAt[TEAMS[team].name] + worker * 55;
    play(c, [
      { transform: 'translate3d(' + Math.round(fromX) + 'px,' + Math.round(fromY) + 'px,0)', opacity: 0 },
      { transform: 'translate3d(' + Math.round(fromX) + 'px,' + Math.round(fromY) + 'px,0)', opacity: 1, offset: .14 },
      { transform: 'translate3d(' + Math.round(toX) + 'px,' + Math.round(toY) + 'px,0)', opacity: 1 },
      { transform: 'translate3d(' + Math.round(toX) + 'px,' + Math.round(toY) + 'px,0)', opacity: 1, offset: .92 },
      { transform: 'translate3d(' + Math.round(toX + 10) + 'px,' + Math.round(toY + 6) + 'px,0)', opacity: 0 },
    ], { duration: Math.max(420, phaseAt.BUILD + 900 - start), delay: start, easing: ease });
  }
  stats.cursorCount = count;
  } // end first-only build (boxes, typers, connector, cursors)
  play(overlay.querySelector('.ltzy-build-head'), [{ opacity: 0 }, { opacity: 1 }],
    { duration: 320, delay: 120, easing: line });
  finishAfter(first ? T.end - 560 : ROUTE_TOTAL - 400);
  function finishAfter(ms) {
    const wait = Math.max(0, ms - (performance.now() - started));
    deadline = setTimeout(() => {
      if (disposed) return;
      play(overlay, [{ opacity: 1 }, { opacity: 0 }], { duration: 480, easing: line })
        .finished.then(() => finish('completed'), () => finish('completed'));
    }, wait);
  }
  listen(document, 'visibilitychange', () => { if (document.hidden) finish('hidden'); });
  listen(reduce, 'change', e => { if (e.matches) finish('reduced-motion'); });
  listen(window, 'ltzy:quality', () => { if (quiet()) finish('user-quiet'); });
  function tick(now) {
    if (disposed) return;
    if (!root.isConnected) { finish('detached'); return; }
    frames++; stats.frames = frames;
    if (previous) {
      const dt = now - previous;
      frameTotal += dt; samples++; worst = Math.max(worst, dt);
      stats.sampleCount = samples;
      stats.avgFrameMs = Math.round(frameTotal / samples * 100) / 100;
      stats.maxFrameMs = Math.round(worst * 100) / 100;
      if (!lite && samples >= 24 && stats.avgFrameMs > 26) downgrade();
    }
    previous = now;
    const at = now - started;
    if (!first) {
      // Route mode: light the team log rows one by one over the live page.
      const idx = Math.floor(at / 150);
      if (idx !== startedPhases.route && idx >= 0 && idx < TEAMS.length) {
        startedPhases.route = idx;
        const row = overlay.querySelectorAll('.ltzy-build-log > div')[idx];
        if (row) play(row, [{ opacity: 0, transform: 'translate3d(-8px,0,0)' },
          { opacity: 1, transform: 'translate3d(0,0,0)' }], { duration: 220, easing: line });
      }
    } else {
      if (at >= phaseAt.TYPE) mark('TYPE');
      if (at >= phaseAt.ROUTE) mark('ROUTE');
      if (at >= phaseAt.BUILD) mark('BUILD');
      if (at >= phaseAt.LAYOUT) mark('LAYOUT');
    }
    for (const t of texts) {
      if (at < t.from) continue;
      const p = Math.min(1, (at - t.from) / t.dur);
      const n = Math.floor(t.full.length * p);
      if (t.n !== n) { t.n = n; t.body.textContent = t.full.slice(0, n); }
      t.caret.style.opacity = p < 1 || Math.floor(at / 500) % 2 === 0 ? '1' : '0';
      if (p >= 1) t.caret.style.opacity = '0';
    }
    raf = requestAnimationFrame(tick);
  }
  function downgrade() {
    if (lite) return;
    lite = true;
    stats.mode = 'lite';
    stats.liteReason = 'sampled-frame-time';
    stats.downgraded = true;
    overlay.classList.add('ltzy-build-lite');
    cursors.slice(12).forEach(c => { c.getAnimations().forEach(a => a.cancel()); c.remove(); });
    stats.cursorCount = 12;
  }
  raf = requestAnimationFrame(tick);
  return cleanup;
}
