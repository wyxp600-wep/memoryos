/**
 * P1 · 隔离实例核心模块
 * 职责：mkdtemp + VACUUM INTO 导副本 + env 隔离 + openDb/buildApp/listen(port 0)
 *       + CDP(Chrome port 0) + 实例身份门 + 交互原语（dragNode/linkDrag/panCanvas/worldScale）
 * 被P2/P3 复用。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KERNEL = path.resolve(HERE, '..');           // resources/memoryos
const DIST = path.join(KERNEL, 'dist');
const OUT = path.join(HERE, 'card-manual-test', '20261006');
const PROD_DB = 'C:/Users/WYX/AppData/Roaming/MemoryOS/data/memory.db';
const PROD_TOKEN_FILE = 'C:/Users/WYX/AppData/Roaming/MemoryOS/data/token';
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PREFIX = '[TEST-20261006]';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[P1]', ...a);
const j = v => JSON.stringify(v, null, 2);

let WS, DB_COPY, DATA_DIR, TOKEN, PORT, app, db, chromeProc, ws, mid = 0;
let pending = new Map();
let CONSOLE = [], NET = [], SHOT = 0;
let EXPECTED_NODES = -1;

export { WS, DB_COPY, TOKEN, PORT, CONSOLE, NET, sleep, log, j, OUT, PREFIX, KERNEL, PROD_DB };

/* ================= env 隔离五条 ================= */
function isolateEnv() {
  process.env.MEMORYOS_DATA_DIR = DATA_DIR;   // ① 最高优先级 → config.json 落副本
  process.env.MEMORY_DB = DB_COPY;            // ② 显式副本
  process.env.MEMORY_TOKEN = TOKEN;           // ③ 即兴 token，与 buildApp opts 双保险
  process.env.EMBED_MODE = 'fake';            // ④ 显式，不留空（embed.js:14 缺省 fake）
  process.env.MEMORY_RESTRICTED = '0';        // ⑤ 防 shell 常驻 '1'
  process.env.MEMORY_PORT = '0';              // 0 = OS 分配
  process.env.MEMORY_HOST = '127.0.0.1';
}

/* ================= 启动 ================= */
export async function boot() {
  WS = fs.mkdtempSync(path.join(os.tmpdir(), 'cardtest-20261006-'));
  DB_COPY = path.join(WS, 'memory.db');
  DATA_DIR = path.join(WS, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });        // openDb 无 mkdir，目录必须先建
  TOKEN = 'cardtest-' + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
  log('WS =', WS);

  // ① 导副本（源只读）
  const t0 = Date.now();
  const src = new DatabaseSync(PROD_DB, { readOnly: true });
  src.exec(`VACUUM INTO '${DB_COPY.replace(/'/g, "''")}'`);
  const srcCount = src.prepare('SELECT COUNT(*) n FROM cards').get().n;
  src.close();
  log(`副本导出 ${Date.now() - t0}ms/ ${(fs.statSync(DB_COPY).size / 1048576).toFixed(1)}MB (源 ${srcCount} 卡)`);

  // ② 副本体检
  const ck = new DatabaseSync(DB_COPY, { readOnly: true });
  const ic = Object.values(ck.prepare('PRAGMA integrity_check').get())[0];
  if (ic !== 'ok') throw new Error('副本损坏: ' + ic);
  const cp = {
    cards: ck.prepare('SELECT COUNT(*) n FROM cards').get().n,
    links: ck.prepare('SELECT COUNT(*) n FROM links').get().n,
    events: ck.prepare('SELECT COUNT(*) n FROM card_events').get().n,
    kindDist: ck.prepare('SELECT kind, COUNT(*) n FROM cards GROUP BY kind').all(),
    statusDist: ck.prepare('SELECT status, COUNT(*) n FROM cards GROUP BY status').all(),
  };
  ck.close();
  log('副本体检:', JSON.stringify({ cards: cp.cards, links: cp.links }));

  // ③ env 隔离必须在 import dashboard.js 之前（RESTRICTED 在模块体求值）
  isolateEnv();

  // ④ 启内核
  const { openDb } = await import(pathToFileURL(path.join(DIST, 'db.js')).href);
  const { buildApp } = await import(pathToFileURL(path.join(DIST, 'dashboard.js')).href);
  db = openDb(DB_COPY);
  app = buildApp(db, { token: TOKEN });
  await app.listen({ host: '127.0.0.1', port: 0 });          // 0 = OS 分配
  PORT = app.server.address().port;
  log('内核已启: 127.0.0.1:' + PORT, '(生产是 8787)');

  // ⑤ 建种子卡（API 建卡，副本零成本）
  const seed = [];
  for (const [tag, kind] of [['D1', 'task'], ['D2', 'task'], ['D3', 'task'], ['D4', 'task'], ['L1', 'task'], ['L2', 'task']]) {
    const r = await api('POST', '/api/cards', { title: `${PREFIX} ${tag} ${kind}种子卡`, kind });
    if (r.status === 200) seed.push({ tag, kind, id: r.body.id });
  }
  // 一颗agent 卡（供 L-15 测非法前置）
  const ag = await api('POST', '/api/cards', { title: `${PREFIX} L3 agent种子卡`, kind: 'agent' });
  if (ag.status === 200) seed.push({ tag: 'L3', kind: 'agent', id: ag.body.id });
  log('种子卡:', JSON.stringify(seed.map(s => `${s.tag}#${s.id}`)));
  EXPECTED_NODES = seed.length + 1;   // 至少含种子卡

  // ⑥ 身份门（四条）
  const prodTok = fs.readFileSync(PROD_TOKEN_FILE, 'utf8').trim();
  if (PORT === 8787) throw new Error('★ 隔离实例误占生产端口');
  if (TOKEN === prodTok) throw new Error('★ token 撞生产');
  const g = await api('GET', '/api/cards/graph?auto=0');
  const localCards = q(`SELECT COUNT(*) n FROM cards`)[0].n;
  if (localCards !== cp.cards + seed.length) throw new Error(`★ 副本库卡数异常: ${localCards} != ${cp.cards}+${seed.length}`);
  log(`身份门通过: port=${PORT}(≠8787) token≠prod graph.nodes=${(g.nodes || []).length} localCards=${localCards}`);

  fs.writeFileSync(path.join(OUT, 'P1-instance.json'), j({
    port: PORT, token: TOKEN, ws: WS, dbCopy: DB_COPY, dataDir: DATA_DIR,
    prodSource: PROD_DB, srcCards: srcCount, copy: cp, seed, graphNodes: (g.nodes || []).length,
  }), 'utf8');

  // ⑦ Chrome（port 0 + 独立 user-data-dir）
  await launchChrome();
  return { port: PORT, copy: cp, seed, graphNodes: (g.nodes || []).length };
}

/* ================= 只读查询（副本） ================= */
export function q(sql, ...p) {
  p.forEach((v, i) => { if (v === undefined) throw new Error(`SQL 参数 ${i + 1} undefined`); });
  return db.prepare(sql).all(...p);
}
export const q1 = (sql, ...p) => { p.forEach((v, i) => { if (v === undefined) throw new Error(`SQL 参数 ${i + 1} undefined`); }); return db.prepare(sql).get(...p); };

/* ================= HTTP ================= */
export async function api(method, url, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method, headers: body ? { 'content-type': 'application/json', 'x-memory-token': TOKEN } : { 'x-memory-token': TOKEN },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = { _raw: t.slice(0, 300) }; }
  return { status: r.status, body: b };
}

/* ================= CDP ================= */
export function send(method, params = {}, timeoutMs = 8000) {
  return new Promise((res, rej) => {
    if (!ws || ws.readyState !== 1) return rej(new Error('ws not open —— CDP 已断开（实例崩溃？Chrome 退出？）'));
    const id = ++mid; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error(method + ' timeout')); }, timeoutMs);
  });
}
export async function ev(expr) {
  try {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 10000);
    if (r.exceptionDetails) return '[ERR]' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || '');
    return r.result && r.result.value;
  } catch (e) { return '[ERR]' + e.message; }
}
export async function rectOf(sel) {
  const s = await ev(`(function(){var e=document.querySelector(${JSON.stringify(sel)});
    if(!e)return 'null';var r=e.getBoundingClientRect();
    return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2});})()`);
  try { return JSON.parse(s); } catch { return null; }
}

export const mouse = {
  move: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, 3000).catch(() => { }),
  press: (x, y) => send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, 3000).catch(() => { }),
  drag: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, 3000).catch(() => { }),
  drop: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, 3000).catch(() => { }),
};
export async function click(x, y) { await mouse.move(x, y); await sleep(100); await mouse.press(x, y); await sleep(70); await mouse.drop(x, y); await sleep(250); }
export async function clickSel(sel) {
  const r = await rectOf(sel);
  if (!r || r.w < 1) throw new Error('clickSel 目标尺寸为 0: ' + sel);
  await click(Math.round(r.cx), Math.round(r.cy));
  return r;
}
const KEYMAP = { Enter: [13, '\r'], Escape: [27, ''] };
export async function key(k) {
  const [vk, t] = KEYMAP[k] || [0, k];
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  if (t) await send('Input.dispatchKeyEvent', { type: 'char', text: t, unmodifiedText: t });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
export async function typeText(t) { await send('Input.insertText', { text: t }).catch(() => { }); }

export async function shot(tag) {
  try {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, 3000).catch(() => { });
    await send('Emulation.clearDeviceMetricsOverride', {}, 3000).catch(() => { });
    await sleep(250);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const name = `${tag}-${String(++SHOT).padStart(2, '0')}.png`;
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, 3000).catch(() => { });
    return name;
  } catch (e) { return 'SHOT_FAIL:' + e.message; }
}

export function dump(tag, extra = {}) {
  fs.writeFileSync(path.join(OUT, `${tag}.console.log`), CONSOLE.map(c => j(c)).join('\n'), 'utf8');
  fs.writeFileSync(path.join(OUT, `${tag}.net.json`), j(NET), 'utf8');
  if (Object.keys(extra).length) fs.writeFileSync(path.join(OUT, `${tag}.sql.txt`),
    Object.entries(extra).map(([k, v]) => `-- ${k}\n${typeof v === 'string' ? v : j(v)}`).join('\n\n'), 'utf8');
}
export const resetEv = () => { CONSOLE = []; NET = []; };

/* ================= 探针（必须在 goto 之前注入） ================= */
const PROBE = `
window.__EV = window.__EV || []; window.__LIS = window.__LIS || []; window.__XSS = 0;
window.__probeState = { scale: 1, tx: 0, ty: 0 };
(function(){
  var AEP = EventTarget.prototype.addEventListener, REP = EventTarget.prototype.removeEventListener;
  function sig(t){ t=String(t);
    if(t==='pointerup')return 'pointerup'; if(t==='pointercancel')return 'pointerCANCEL';
    if(t==='pointerdown')return 'pointerdown'; if(t==='pointermove')return 'pointermove'; return t; }
  EventTarget.prototype.addEventListener = function(t,f,o){ if(String(t).indexOf('pointer')===0){
    try{ var st=(new Error()).stack.split('\\n').slice(1,5).join(' | ').slice(0,260);
      window.__LIS.push({op:'add',t:sig(t),st:st,fn:String(f).slice(0,60)}); }catch(e){} }
    return AEP.call(this,t,f,o); };
  EventTarget.prototype.removeEventListener = function(t,f,o){ if(String(t).indexOf('pointer')===0){
    try{ window.__LIS.push({op:'remove',t:sig(t),fn:String(f).slice(0,60)}); }catch(e){} }
    return REP.call(this,t,f,o); };
  ['pointerdown','pointermove','pointerup','pointercancel'].forEach(function(t){
    window.addEventListener(t, function(e){ try{ var n=e.target&&e.target.closest?e.target.closest('.task-map-node'):null;
      window.__EV.push({t:t,x:Math.round(e.clientX),y:Math.round(e.clientY),card:n?('card#'+n.dataset.cardId):'other'}); }catch(err){} }, true);
  });
  // 读 world 的 CSS transform 反推 scale/pan（_taskMapState 是闭包变量读不到）
  setInterval(function(){
    try{ var w=document.getElementById('taskMapWorld'); if(!w) return;
      var m=new WebKitCSSMatrix(getComputedStyle(w).transform);
      window.__probeState={scale:m.a, tx:m.e, ty:m.f}; }catch(e){}
  }, 120);
})();`;

/* ================= Chrome ================= */
async function launchChrome() {
  const tmpd = path.join(WS, 'chrome-profile');
  fs.mkdirSync(tmpd, { recursive: true });
  chromeProc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1600,1000', '--remote-debugging-port=0', `--user-data-dir=${tmpd}`, 'about:blank'], { stdio: 'ignore' });
  chromeProc.on('exit', (c, s) => { log('!! chrome exit code=' + c + ' sig=' + s); CONSOLE.push({ t: 'chrome-exit', c, s }); });
  // port 0 → 从 DevToolsActivePort 读
  const f = path.join(tmpd, 'DevToolsActivePort');
  let cdpPort = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (fs.existsSync(f)) { const c = fs.readFileSync(f, 'utf8').split('\n'); if (c[0] && c[0].trim()) { cdpPort = Number(c[0].trim()); if (cdpPort) break; } }
  }
  if (!cdpPort) throw new Error('Chrome DevToolsActivePort 未就绪');
  log('CDP 端口(OS 分配):', cdpPort);
  let pg = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    pg = l.find(t => t.type === 'page'); if (pg) break;
  }
  if (!pg) throw new Error('无 page target');
  ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  ws.onmessage = m => {
    let d; try { d = JSON.parse(m.data); } catch { return; }
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d.error || {}); pending.delete(d.id); return; }
    const M = d.method;
    if (M === 'Runtime.consoleAPICalled') CONSOLE.push({ t: 'console', ty: d.params.type, text: (d.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 400) });
    else if (M === 'Runtime.exceptionThrown') CONSOLE.push({ t: 'exception', text: String((d.params.exceptionDetails && d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || '').slice(0, 400) });
    else if (M === 'Log.entryAdded') CONSOLE.push({ t: 'log', lv: d.params.entry.level, text: String(d.params.entry.text || '').slice(0, 300) });
    else if (M === 'Network.requestWillBeSent' && String(d.params.request.url).includes('/api/')) NET.push({ ph: 'sent', m: d.params.request.method, u: d.params.request.url.replace(`http://127.0.0.1:${PORT}`, ''), pd: (d.params.request.postData || '').slice(0, 300) });
    else if (M === 'Network.responseReceived' && String(d.params.response.url).includes('/api/')) NET.push({ ph: 'resp', s: d.params.response.status, u: d.params.response.url.replace(`http://127.0.0.1:${PORT}`, '') });
    else if (M === 'Network.loadingFailed') NET.push({ ph: 'failed', err: d.params.errorText });
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });   // ★ 必须在 navigate 之前
  log('CDP 就绪，探针已注入');
}

/* ================= 页面就绪（三前置） ================= */
export async function goto() {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}` }, 15000);
  // ① 等 #page-tasks 出现并变VISIBLE（HIDDEN 则点侧栏「任务看板」）
  let pt = 'MISS', tries = 0;
  for (let k = 0; k < 25; k++) {
    await sleep(700); tries = k + 1;
    pt = await ev(`(function(){var e=document.getElementById('page-tasks');
      if(!e)return 'MISS';return getComputedStyle(e).display==='none'?'HIDDEN':'VISIBLE';})()`);
    if (pt === 'VISIBLE') break;
    if (pt === 'HIDDEN') await ev(`(function(){var c=[].slice.call(document.querySelectorAll('a,button,.nav-item'))
      .filter(function(x){return /任务看板/.test((x.textContent||'').trim())&&(x.textContent||'').trim().length<12;})[0];
      if(c)c.click();return 'ok';})()`);
  }
  log(`#page-tasks: ${pt} (第${tries}次轮询)`);
  if (pt !== 'VISIBLE') throw new Error('#page-tasks 未就绪（token 鉴权失败？）');
  // ② 切任务地图视图
  await ev(`(function(){var t=document.getElementById('tabMap');if(t)t.click();return 'ok';})()`);
  await sleep(2000);
  // ③ 等节点渲染
  let n = 0;
  for (let k = 0; k < 14; k++) { await sleep(700); n = Number(await ev(`document.querySelectorAll('#taskMapNodes .task-map-node').length`)) || 0; if (n > 0) break; }
  const dims = await ev(`(function(){var c=document.getElementById('taskMapCanvas');if(!c)return 'NO_CANVAS';
    var r=c.getBoundingClientRect();return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height)});})()`);
  log('节点数:', n, 'canvas:', dims);
  if (!n) throw new Error('任务地图无节点渲染');
  // ④ 缩小到合适比例并把测试卡移入视口
  await ev(`(function(){
    var bs=[].slice.call(document.querySelectorAll('button'));
    var b=bs.filter(function(x){return /适配全图|全图|适应|fit/i.test((x.textContent||'')+(x.title||''));})[0];
    if(b){b.click();return 'fit-clicked';}return 'no-fit-btn';})()`);
  await sleep(1800);
  const after = await ev(`(function(){return JSON.stringify({
    nodes:document.querySelectorAll('#taskMapNodes .task-map-node').length,
    scale:(window.__probeState&&window.__probeState.scale)||1});})()`);
  log('fit 后:', after);
  // ⑤ 测试卡在视口内与否由调用方按需 focusOn()；这里只报可见数
  const visAfter = await visibleNodes(30);
  log('页面就绪后可见节点:', visAfter.length, JSON.stringify(visAfter.slice(0, 6)));
  return { nodes: n, dims: JSON.parse(String(dims)), afterFit: JSON.parse(String(after)), visibleAfter: visAfter.length, visList: visAfter };
}

/* ================= 交互原语 ================= */
export async function worldScale() {
  const s = await ev(`(function(){var w=document.getElementById('taskMapWorld');
    if(!w)return 1;var m=new WebKitCSSMatrix(getComputedStyle(w).transform);return m.a||1;})()`);
  return Number(s) || 1;
}
export async function worldToScreen(wx, wy) {
  return JSON.parse(await ev(`(function(){var w=document.getElementById('taskMapWorld');
    var r=w.getBoundingClientRect();var s=(window.__probeState&&window.__probeState.scale)||1;
    return JSON.stringify({x:Math.round(r.left+${wx}*s), y:Math.round(r.top+${wy}*s)});})()`));
}
const nodeSel = id => `#taskMapNodes .task-map-node[data-card-id="${id}"]`;

/** hover 卡片主体（让 pointer-events 生效），返回实测 rect */
export async function anchorCard(id) {
  const sel = nodeSel(id);
  await mouse.move(5, 5); await sleep(120);
  let r = await rectOf(sel);
  if (!r || r.w < 1) throw new Error('卡片不可见: ' + id);
  await mouse.move(Math.round(r.cx), Math.round(r.cy));
  await sleep(320);                                   // 等 0.18s opacity 过渡
  r = await rectOf(sel);
  return r;
}
/** 卡片上用于按下的点：优先标题区，避开快捷条与连线圆点 */
async function grabPoint(id) {
  return JSON.parse(await ev(`(function(){var n=document.querySelector('${nodeSel(id)}');
    if(!n)return 'null';
    var t=n.querySelector('.task-map-node-title'), q=t&&t.getBoundingClientRect();
    if(q&&q.width>20&&q.height>8) return JSON.stringify({x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2)});
    var b=n.getBoundingClientRect(); return JSON.stringify({x:Math.round(b.left+50),y:Math.round(b.top+b.height/2)});})()`));
}
/** 拖动卡片：世界位移 → 屏幕位移 × scale */
export async function dragNode(id, dxW, dyW, { steps = 12, holdMs = 0, onMid = null } = {}) {
  const r = await anchorCard(id);
  const from = await grabPoint(id);
  if (!from) throw new Error('grabPoint 失败: ' + id);
  const scale = await worldScale();
  const sx = Math.round(r.cx), sy = Math.round(r.cy);
  await mouse.move(from.x, from.y); await sleep(240);
  await mouse.press(from.x, from.y); await sleep(70);
  let midDone = false;
  for (let i = 1; i <= steps; i++) {
    await mouse.drag(Math.round(from.x + dxW * scale * i / steps), Math.round(from.y + dyW * scale * i / steps));
    await sleep(16);
    if (onMid && !midDone && i >= Math.floor(steps / 2)) { midDone = true; await onMid({ sx, sy, from, scale, nodeLeft: await ev(`parseFloat(document.querySelector('${nodeSel(id)}').style.left)||0`) }); }
  }
  if (holdMs) await sleep(holdMs);
  await sleep(90);
  await mouse.drop(Math.round(from.x + dxW * scale), Math.round(from.y + dyW * scale));
  await sleep(1100);                                  // > suppressClick 60ms
  return { from, scale, startScreen: { x: sx, y: sy } };
}
/** 平移画布：必须点在空白 canvas（elementFromPoint 校验） */
export async function panCanvas(dx, dy) {
  const pt = await ev(`(function(){var c=document.getElementById('taskMapCanvas');
    if(!c)return 'null';var cr=c.getBoundingClientRect();
    for(var y=Math.round(cr.top)+6; y<innerHeight-30; y+=13)
      for(var x=Math.round(cr.left)+6; x<innerWidth-30; x+=17){
        var t=document.elementFromPoint(x,y);
        if(t&&t.id==='taskMapCanvas') return JSON.stringify({x:x,y:y});}
    return 'null';})()`);
  const p = JSON.parse(pt);
  if (!p) throw new Error('找不到空白 canvas 点（节点铺满画布？）');
  const before = await ev(`JSON.stringify(window.__probeState||{})`);
  await mouse.move(p.x, p.y); await sleep(220);
  await mouse.press(p.x, p.y); await sleep(70);
  for (let i = 1; i <= 8; i++) { await mouse.drag(Math.round(p.x + dx * i / 8), Math.round(p.y + dy * i / 8)); await sleep(16); }
  await mouse.drop(Math.round(p.x + dx), Math.round(p.y + dy));
  await sleep(350);
  const after = await ev(`JSON.stringify(window.__probeState||{})`);
  return { p, before: JSON.parse(before || '{}'), after: JSON.parse(after || '{}') };
}
/** 放大画布到指定scale（连线圆点太小不好点，默认放大到 1.0） */
export async function zoomTo(target = 1.0) {
  const cur = await worldScale();
  if (cur >= target - 0.02) { log(`zoomTo: 当前 scale=${cur.toFixed(3)} 已足够`); return cur; }
  // 用工具栏的放大按钮逐步放大（app.js 的 taskMapZoomInBtn），更贴近真实用户
  let guard = 0;
  while (await worldScale() < target - 0.02 && guard++ < 12) {
    const r = await rectOf('#taskMapZoomInBtn');
    if (!r || r.w < 1) {
      // 回退：派发 wheel 事件
      const c = await rectOf('#taskMapCanvas');
      if (!c) break;
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(c.cx), y: Math.round(c.cy), deltaX: 0, deltaY: -120 }, 3000).catch(() => { });
      await sleep(200);
      continue;
    }
    await click(Math.round(r.cx), Math.round(r.cy));
    await sleep(220);
  }
  const after = await worldScale();
  log(`zoomTo: ${cur.toFixed(3)} -> ${after.toFixed(3)}`);
  return after;
}
/** 连线手势（不 release）：hover 主体 → 放大保证圆点可点 → 实测圆点 → press → move 到目标中心 */
export async function linkHold(srcId, dstId) {
  // ★ 策略：不zoom、不 pan（193 卡铺满时二者都会失败）。直接在当前 scale 下操作。
  //圆点大小 = 22 * scale；scale>=0.4 时约 9px，仍在 CDP 整数坐标精度内（实测可点）。
  await anchorCard(srcId);                                     // ① 让圆点 pointer-events 生效
  const dot = await rectOf(`${nodeSel(srcId)} .task-map-node-link`);   // ② 实测
  if (!dot || dot.w < 1) throw new Error('连线圆点未出现（hover 未生效）');
  const dstC = await rectOf(nodeSel(dstId));
  if (!dstC || dstC.w < 1) throw new Error('目标卡不在 DOM: ' + dstId);
  const vw = Number(await ev('innerWidth')), vh = Number(await ev('innerHeight'));
  if (dstC.cx < 0 || dstC.cx > vw || dstC.cy < 0 || dstC.cy > vh)
    throw new Error(`目标卡不在视口内 (${Math.round(dstC.cx)},${Math.round(dstC.cy)}) viewport=${vw}x${vh}`);
  const dstGrab = { x: Math.round(dstC.cx), y: Math.round(dstC.cy) };
  await mouse.move(Math.round(dot.cx), Math.round(dot.cy)); await sleep(300);
  await mouse.press(Math.round(dot.cx), Math.round(dot.cy)); await sleep(100);
  for (let i = 1; i <= 12; i++) {
    await mouse.drag(Math.round(dot.cx + (dstGrab.x - dot.cx) * i / 12), Math.round(dot.cy + (dstGrab.y - dot.cy) * i / 12));
    await sleep(25);
  }
  await sleep(250);
  const probe = {
    hoverId: await ev(`(function(){var n=document.querySelector('.task-map-node.link-target');
      return n?Number(n.dataset.cardId):null;})()`),
    draftD: await ev(`(function(){var p=document.querySelector('#taskMapEdges path.task-map-edge-line');
      return p?String(p.getAttribute('d')).slice(0,70):null;})()`),
    linkingClass: await ev(`(function(){var e=document.getElementById('taskMapEdges');
      return e?e.classList.contains('task-map-linking'):null;})()`),
    lastMove: await ev(`(function(){var e=window.__EV||[];for(var i=e.length-1;i>=0;i--){
      if(e[i].t==='pointermove')return JSON.stringify({x:e[i].x,y:e[i].y});}return 'null';})()`),
  };
  return { dot, dstGrab, probe: { ...probe, lastMove: probe.lastMove && probe.lastMove !== 'null' ? JSON.parse(probe.lastMove) : null }, at: dstGrab };
}
export async function linkDrop(srcId, dstId) {
  const h = await linkHold(srcId, dstId);
  // ★ drop 前把鼠标移到目标点再 release（部分实现需最后 move 定位）
  await mouse.move(h.at.x, h.at.y);
  await sleep(120);
  await mouse.drop(h.at.x, h.at.y);
  await sleep(1800);
  return h;
}
/** 连线放手并诊断：抓 up 前后 hoverId / gesture 残留 / 网络请求 */
export async function linkDropDiagnose(srcId, dstId) {
  const h = await linkHold(srcId, dstId);
  const before = await ev(`(function(){return JSON.stringify({
    hoverId:(document.querySelector('.task-map-node.link-target')||{}).dataset?Number(document.querySelector('.task-map-node.link-target').dataset.cardId):null,
    linking:document.getElementById('taskMapEdges').classList.contains('task-map-linking'),
    tmp:!!document.querySelector('#taskMapEdges path.task-map-edge-line')});})()`);
  await mouse.move(h.at.x, h.at.y);
  await sleep(120);
  const netBefore = NET.length;
  await mouse.drop(h.at.x, h.at.y);
  await sleep(2200);
  const after = await ev(`(function(){return JSON.stringify({
    linking:document.getElementById('taskMapEdges').classList.contains('task-map-linking'),
    tmp:!!document.querySelector('#taskMapEdges path.task-map-edge-line'),
    linkTarget:!!document.querySelector('.task-map-node.link-target')});})()`);
  const evTail = (await evDump()).slice(-8);
  const net = NET.slice(netBefore).filter(n => n.u && /links|graph/.test(n.u));
  return { h, before: JSON.parse(String(before)), after: JSON.parse(String(after)), evTail, net, rows: linkRows(srcId, dstId) };
}
export async function lisDump() { try { return JSON.parse((await ev(`JSON.stringify(window.__LIS||[])`)) || '[]'); } catch { return []; } }
export async function evDump() { try { return JSON.parse((await ev(`JSON.stringify(window.__EV||[])`)) || '[]'); } catch { return []; } }

/* ================= 断言查询 ================= */
export const cardPos = id => q1(`SELECT meta FROM cards WHERE id=?`, Number(id))?.meta;
export const cardMapPos = id => { try { return JSON.parse(cardPos(id) || '{}').map_pos || null; } catch { return null; } };
export const nodeStyle = async id => JSON.parse((await ev(`(function(){var e=document.querySelector('${nodeSel(id)}');
  if(!e)return 'null';return JSON.stringify({left:e.style.left,top:e.style.top,
  w:Math.round(e.getBoundingClientRect().width),h:Math.round(e.getBoundingClientRect().height)});})()`)) || 'null');
export const linkRows = (src, dst) => q(`SELECT id,src_id,dst_id,kind FROM links WHERE src_kind='card' AND src_id=? AND dst_id=?`, Number(src), Number(dst));
export const eventCount = (cardId, kind) => q1(`SELECT COUNT(*) n FROM card_events WHERE card_id=? AND action=?`, Number(cardId), kind).n;
export const visibleNodes = async (limit = 14) => {
  const s = await ev(`(function(){var ns=[].slice.call(document.querySelectorAll('#taskMapNodes .task-map-node'));
    var vw=innerWidth,vh=innerHeight;var out=[];
    ns.forEach(function(n){var r=n.getBoundingClientRect();
      if(r.left>=0&&r.top>=0&&r.right<=vw&&r.bottom<=vh&&r.width>0)
        out.push({id:Number(n.dataset.cardId),cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2),
                  w:Math.round(r.width),h:Math.round(r.height),
                  title:((n.querySelector('.task-map-node-title')||{}).textContent||'').slice(0,30)});});
    return JSON.stringify(out.slice(0,${limit}));})()`);
  try { return JSON.parse(s) || []; } catch { return []; }
};
/** 触发 SSE（改自建卡状态），返回是否成功 */
export async function pokeSse(cardId, from = 'triage', to = 'todo') {
  const r = await api('POST', `/api/cards/${cardId}/status`, { status: to, expected_from: from, as: 'human:test' });
  await sleep(1700);
  return r;
}
/** 触发重绘（保探针，不 reload）—— 建卡走同步 refreshCurrentTaskView */
export async function triggerRedraw() {
  const r = await api('POST', '/api/cards', { title: `${PREFIX} 触发重绘 ${Date.now()}`, kind: 'task' });
  await sleep(2000);
  return r;
}
export async function resetStatus(cardId) {
  const cur = q1(`SELECT status FROM cards WHERE id=?`, Number(cardId))?.status;
  if (cur === 'triage') return;
  const map = { todo: 'triage', ready: 'todo', running: 'ready', review: 'running', done: 'review', failed: 'triage', blocked: 'triage', cancelled: 'triage' };
  const next = map[cur];
  if (!next) return;
  await api('POST', `/api/cards/${cardId}/status`, { status: next, expected_from: cur, as: 'human:test' });
  await sleep(400);
}

/** 把画布平移到让指定卡片进入视口中心（按世界坐标反算 pan 量） */
export async function focusOn(cards) {
  if (!cards || !cards.length) throw new Error('focusOn 无卡片');
  // 取这些卡的 DOM style（世界坐标）
  const pts = [];
  for (const id of cards) {
    const p = JSON.parse(await ev(`(function(){var e=document.querySelector('${nodeSel(id)}');
      if(!e)return 'null';
      var t=e.querySelector('.task-map-node-title'), r=(t||e).getBoundingClientRect();
      return JSON.stringify({x:parseFloat(e.style.left)||0, y:parseFloat(e.style.top)||0,
        w:r.width, h:r.height});})()`) || 'null');
    if (p) pts.push(p);
  }
  if (!pts.length) throw new Error('focusOn: 目标卡不在 DOM');
  // 目标：让这批卡的包围盒中心落到视口中心
  const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x + p.w));
  const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y + p.h));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const vw = Number(await ev('innerWidth')), vh = Number(await ev('innerHeight'));
  const cur = JSON.parse((await ev(`JSON.stringify(window.__probeState||{})`)) || '{}');
  const worldRect = JSON.parse(await ev(`(function(){var w=document.getElementById('taskMapWorld');
    var r=w.getBoundingClientRect();return JSON.stringify({l:r.left,t:r.top});})()`));
  // worldRect.l = tx + cx*scale ；要使 (cx,cy) 落在视口中心：tx' = vw/2 - cx*scale
  const scale = cur.scale || 1;
  const wantTx = Math.round(vw / 2 - cx * scale);
  const wantTy = Math.round(vh / 2 - 40 - cy * scale);
  const curTx = Math.round(worldRect.l), curTy = Math.round(worldRect.t);
  const dx = wantTx - curTx, dy = wantTy - curTy;
  log(`focusOn: 目标卡包围盒 world(${Math.round(minX)},${Math.round(minY)})-(${Math.round(maxX)},${Math.round(maxY)}) 中心(${Math.round(cx)},${Math.round(cy)}) scale=${scale.toFixed(3)} 平移(${dx},${dy})`);
  const r = await panCanvas(dx, dy);
  const after = await ev('JSON.stringify(window.__probeState||{})');
  log('focusOn 后:', after);
  return { pts, dx, dy, before: cur, after: JSON.parse(after || '{}') };
}

/* ================= 收尾 ================= */
export async function shutdown() {
  try { ws && ws.close(); } catch { }
  try { if (chromeProc) chromeProc.kill(); } catch { }
  try { await app && app.close(); } catch { }
  try { db && db.close(); } catch { }
  if (WS && fs.existsSync(WS)) { try { fs.rmSync(WS, { recursive: true, force: true }); } catch { } }
  log('已收尾: app/db 关闭, Chrome kill, WS 删除');
}
/** 生产库零污染指纹。
 *  ★ digest 覆盖 meta/status/title 全字段，但**内核自身与用户会话也会改生产库**
 *    （实测 #238 的 map_pos 被真实拖动、updated_at 变化）。因此：
 *    - 主断言用【计数项+ testCards】—— 只有测试写入才会变
 *    - digest 变化单独输出，报告里交叉updated_at 佐证归属
 */
export function prodFingerprint() {
  const d = new DatabaseSync(PROD_DB, { readOnly: true });
  const f = {
    cards: d.prepare('SELECT COUNT(*) n FROM cards').get().n,
    links: d.prepare('SELECT COUNT(*) n FROM links').get().n,
    cardMem: d.prepare('SELECT COUNT(*) n FROM card_memory').get().n,
    events: d.prepare('SELECT COUNT(*) n FROM card_events').get().n,
    testCards: d.prepare("SELECT COUNT(*) n FROM cards WHERE title LIKE '[TEST-20261006]%'").get().n,
    maxCardId: d.prepare('SELECT COALESCE(MAX(id),0) n FROM cards').get().n,
  };
  d.close(); return f;
}
/** digest + 近40 分钟被改的卡（供人工判归属） */
export function prodDetail() {
  const d = new DatabaseSync(PROD_DB, { readOnly: true });
  const now = Date.now();
  const recent = d.prepare('SELECT id,kind,status,substr(title,1,30) t,updated_at FROM cards WHERE updated_at IS NOT NULL ORDER BY id').all()
    .filter(r => (now - new Date(r.updated_at).getTime()) < 40 * 60 * 1000)
    .map(r => ({ id: r.id, status: r.status, upd: r.updated_at }));
  const dg = crypto.createHash('sha256')
    .update(JSON.stringify(d.prepare('SELECT id,kind,status,title,meta FROM cards ORDER BY id').all())).digest('hex');
  d.close();
  return { digest: dg, recentChanged: recent };
}
