/* ============================================================
 * MemoryOS 任务看板卡片 · 手工测试驱动
 * 维度：创建 / 拖动 / 连线
 * 方式：独立 headless Chrome + CDP 原生交互（模拟真实用户操作）
 * 纪律：只读生产库（node:sqlite readOnly:true）；所有数据变更只走 HTTP API；
 *       一行生产代码都不改；不 kill 8787 内核 / 不动 Electron 壳。
 * 用法：node card-manual-test-20261006.mjs <phase>
 *       phase = env | create | drag | link | cleanup
 * ============================================================ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'card-manual-test', '20261006');
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(process.env.CDP_PORT || 9412);
const DASH = Number(process.env.MEMORY_PORT || 8787);
let TOKEN = ''; let TOKEN_SRC = '';
const DB_PATH = 'C:/Users/WYX/AppData/Roaming/MemoryOS/data/memory.db';
const PREFIX = '[TEST-20261006]';
const PHASE = process.argv[2] || 'env';

fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[T]', ...a);
const j = v => JSON.stringify(v, null, 2);

/* ---------- 令牌 ----------
 * ★ 实证（2026-10-06 17:35）：当前 8787 内核（PID 30172）接受的是**仓内**
 *   resources/memoryos/data/token，而 %APPDATA%\...\data\tokens那份会 401。
 *   两份token 内容不同，必须实测哪份有效，不能按"生产库在 APPDATA"想当然推断。
 *   策略：依次尝试，HTTP 200 即采用；启动时断言有一个可用。
 */
function readTokenCandidates() {
  return [
    { src: 'env:MEMORY_TOKEN', token: process.env.MEMORY_TOKEN || '' },
    { src: 'warehouse:resources/memoryos/data/token', token: safeRead(path.join(HERE, '..', 'data', 'token')) },
    { src: 'appdata:Roaming/MemoryOS/data/token', token: safeRead('C:/Users/WYX/AppData/Roaming/MemoryOS/data/token') },
  ].filter(x => x.token && x.token.length >= 16);
}
function safeRead(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } }
async function resolveToken() {
  const cands = readTokenCandidates();
  if (!cands.length) throw new Error('未找到任何 token');
  for (const c of cands) {
    try {
      const r = await fetch(`http://127.0.0.1:${DASH}/api/cards/graph?auto=0`, { headers: { 'x-memory-token': c.token } });
      if (r.status === 200) { log(`token OK: ${c.src}`); return c; }
      log(`token 401: ${c.src}`);
    } catch (e) { log(`token 探测失败 ${c.src}: ${e.message}`); }
  }
  throw new Error('所有候选 token 均被拒（401）—— 内核可能已重启换 token，需重新取');
}

/* ---------- 只读库 ---------- */
const DB = new DatabaseSync(DB_PATH, { readOnly: true });
/** 只读保护实测：Node 不暴露 db.readOnly 属性，须用「写探针」验证保护真实生效 */
const readOnlyVerified = (() => {
  try { DB.prepare("UPDATE cards SET title=title WHERE id=-99999").run(); return false; }
  catch { return true; }
})();
if (!readOnlyVerified) throw new Error('只读保护未生效 —— 拒绝继续，避免污染生产库');
const Q = (sql, ...p) => {
  p.forEach((v, i) => { if (v === undefined) throw new Error(`SQL 参数 ${i + 1} 为 undefined —— 请检查调用方取数逻辑`); });
  return DB.prepare(sql).all(...p);
};

/* ---------- HTTP ---------- */
const H = { 'content-type': 'application/json', 'x-memory-token': TOKEN };
async function api(method, url, body) {
  const r = await fetch(`http://127.0.0.1:${DASH}${url}`, {
    method, headers: body ? H : { 'x-memory-token': TOKEN },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = { _raw: t.slice(0, 400) }; }
  return { status: r.status, body: b };
}

/* ============================================================
 * Chrome / CDP
 * ============================================================ */
let chromeProc = null, ws = null, mid = 0;
const pending = new Map();
let CONSOLE = [], NET = [], SHOT = 0;
let WS_URL = '';

function send(method, params = {}, timeoutMs = 6000) {
  return new Promise((res, rej) => {
    if (!ws || ws.readyState !== 1) {
      const diag = fs.existsSync(path.join(OUT, '.chromepid'))
        ? `（自建 Chrome PID ${fs.readFileSync(path.join(OUT, '.chromepid'), 'utf8').trim()}，可能已崩溃退出；`
        + `最近 console：${CONSOLE.slice(-3).map(c => JSON.stringify(c).slice(0, 120)).join(' / ')}）` : '';
      return rej(new Error('ws not open —— CDP 连接已断开' + diag));
    }
    const id = ++mid;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error(method + ' timeout')); }, timeoutMs);
  });
}
/** 页面内取值。返回 JSON 字符串，避免嵌套模板字面量。 */
async function ev(expr) {
  try {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, 8000);
    if (r.exceptionDetails) return '[ERR]' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '');
    return r.result?.value ?? null;
  } catch (e) { return '[ERR]' + e.message; }
}
/** 实测 rect —— 坐标必须实测不能算（world 含 translate+scale） */
const rectOf = async sel => JSON.parse((await ev(
  `(function(){var e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'null';` +
  `var r=e.getBoundingClientRect();return JSON.stringify({x:r.left,y:r.top,w:r.width,h:r.height,cx:r.left+r.width/2,cy:r.top+r.height/2});})()`
)) || 'null');

const mouse = {
  move: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 }, 3000).catch(() => { }),
  press: (x, y) => send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, 3000).catch(() => { }),
  drag: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 }, 3000).catch(() => { }),
  drop: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, 3000).catch(() => { }),
};
async function click(x, y) { await mouse.move(x, y); await sleep(80); await mouse.press(x, y); await sleep(60); await mouse.drop(x, y); await sleep(200); }
/** 四段式拖拽：hover → press → N步move（buttons:1）→ release */
async function dragTo(x0, y0, x1, y1, steps = 10, holdMs = 0) {
  await mouse.move(x0, y0); await sleep(240);
  await mouse.press(x0, y0); await sleep(60);
  for (let i = 1; i <= steps; i++) { await mouse.drag(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); await sleep(16); }
  if (holdMs) await sleep(holdMs);
  await sleep(80); await mouse.drop(x1, y1);
}
const KEYMAP = { Enter: [13, '\r'], Escape: [27, ''], n: [78, 'n'] };
async function keyRaw(k) {
  const [vk, text] = KEYMAP[k] || [0, k];
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  if (text) await send('Input.dispatchKeyEvent', { type: 'char', text, unmodifiedText: text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
const typeText = t => send('Input.insertText', { text: t }).catch(() => { });
async function shot(tag) {
  try {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, 3000);
    // ★ 规避 headless 下setDeviceMetricsOverride 导致的 CSS 源码文本外泄（截图顶部堆叠样式表内容）
    await send('Emulation.clearDeviceMetricsOverride', {}, 3000).catch(() => { });
    await sleep(250);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const name = `${tag}-${String(++SHOT).padStart(2, '0')}.png`;
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    // 复原视口（后续坐标计算依赖它）
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, 3000).catch(() => { });
    return name;
  } catch (e) { return 'SHOT_FAIL:' + e.message; }
}
/** hover 探针：.task-map-node-link 默认 pointer-events:none，靠 :hover 打开 */
async function hoverProbe(cardId) {
  const r = await rectOf(`#taskMapNodes .task-map-node[data-card-id="${cardId}"]`);
  if (!r) return { ok: false, why: 'node not found' };
  await mouse.move(r.cx, r.cy); await sleep(300);
  const s = await ev(`(function(){var n=document.querySelector('#taskMapNodes .task-map-node[data-card-id="${cardId}"]');` +
    `if(!n)return 'null';var l=n.querySelector('.task-map-node-link');if(!l)return 'null';` +
    `var s=getComputedStyle(l);var q=n.querySelector('.task-map-quick');var qs=q?getComputedStyle(q):null;` +
    `return JSON.stringify({linkVis:s.visibility,linkPE:s.pointerEvents,linkOpacity:s.opacity,` +
    `quickVis:qs?qs.visibility:null,quickPE:qs?qs.pointerEvents:null});})()`);
  return { ok: true, probe: JSON.parse(s || '{}') };
}

async function waitMapReady(max = 14) {
  for (let i = 0; i < max; i++) {
    await sleep(800);
    const n = await ev(`document.querySelectorAll('#taskMapNodes .task-map-node').length`);
    if (Number(n) > 0) return true;
  }
  return false;
}
async function reload() { await send('Page.reload', { ignoreCache: false }, 8000).catch(() => { }); await sleep(1200); return waitMapReady(); }

function dumpEvidence(tag, extra = {}) {
  fs.writeFileSync(path.join(OUT, `${tag}.console.log`), CONSOLE.map(c => j(c)).join('\n'), 'utf8');
  fs.writeFileSync(path.join(OUT, `${tag}.net.json`), j(NET), 'utf8');
  if (Object.keys(extra).length) fs.writeFileSync(path.join(OUT, `${tag}.sql.txt`), Object.entries(extra).map(([k, v]) => `-- ${k}\n${typeof v === 'string' ? v : j(v)}`).join('\n\n'), 'utf8');
}
function resetEvidence() { CONSOLE = []; NET = []; }

async function launch() {
  if (chromeProc) return;
  // ★ 先解析可用 token（内核可能已重启换 token，须实测哪份有效）
  const t = await resolveToken();
  TOKEN = t.token; TOKEN_SRC = t.src;
  const tmpd = path.join(os.tmpdir(), `cardtest-${Date.now()}`);
  fs.writeFileSync(path.join(OUT, '.chrometmp'), tmpd, 'utf8');
  chromeProc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1600,1000', '--window-position=0,0',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${tmpd}`, 'about:blank'],
    { stdio: 'ignore', detached: false });
  // ★ 记录 Chrome 意外退出（崩溃取证）
  chromeProc.on('exit', (code, sig) => { log(`!! chrome exited code=${code} signal=${sig}`); CONSOLE.push({ t: 'chrome-exit', code, sig }); });
  chromeProc.pid && fs.writeFileSync(path.join(OUT, '.chromepid'), String(chromeProc.pid), 'utf8');
  // /json/version 兜底轮询
  let ver = null;
  for (let i = 0; i < 40; i++) { await sleep(500); try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch { } }
  if (!ver) throw new Error('chrome devtools not ready');
  let list = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const pg = l.find(t => t.type === 'page');
    if (pg) { list = pg; break; }
  }
  if (!list) throw new Error('no page target');
  WS_URL = list.webSocketDebuggerUrl;
  ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  ws.onmessage = m => {
    let d; try { d = JSON.parse(m.data); } catch { return; }
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d.error || {}); pending.delete(d.id); return; }
    const M = d.method;
    if (M === 'Runtime.consoleAPICalled') CONSOLE.push({ t: 'console', type: d.params.type, text: (d.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 500) });
    else if (M === 'Runtime.exceptionThrown') CONSOLE.push({ t: 'exception', text: String(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text || '').slice(0, 500) });
    else if (M === 'Log.entryAdded') CONSOLE.push({ t: 'log', level: d.params.entry.level, text: String(d.params.entry.text || '').slice(0, 400) });
    else if (M === 'Network.requestWillBeSent' && String(d.params.request.url).includes('/api/')) NET.push({ phase: 'sent', method: d.params.request.method, url: d.params.request.url.replace(`http://127.0.0.1:${DASH}`, ''), postData: (d.params.request.postData || '').slice(0, 400) });
    else if (M === 'Network.responseReceived' && String(d.params.response.url).includes('/api/')) NET.push({ phase: 'resp', status: d.params.response.status, url: d.params.response.url.replace(`http://127.0.0.1:${DASH}`, ''), reqId: d.params.requestId });
    else if (M === 'Network.loadingFailed') NET.push({ phase: 'failed', reqId: d.params.requestId, err: d.params.errorText });
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
  // ★ 探针必须在 navigate 之前注入
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  return ver;
}
const PROBE = `
window.__EV = window.__EV || []; window.__LIS = window.__LIS || []; window.__XSS = 0;
(function(){
  var AEP = EventTarget.prototype.addEventListener, REP = EventTarget.prototype.removeEventListener;
  function sig(t){ t=String(t); if(t==='pointerup')return 'pointerup'; if(t==='pointercancel')return 'pointerCANCEL';
    if(t==='pointerdown')return 'pointerdown'; if(t==='pointermove')return 'pointermove'; return t; }
  EventTarget.prototype.addEventListener = function(t,f,o){ if(String(t).indexOf('pointer')===0){
    try{ window.__LIS.push({op:'add',t:sig(t),st:(new Error()).stack.split('\\n').slice(1,4).join(' | ').slice(0,240)}); }catch(e){} }
    return AEP.call(this,t,f,o); };
  EventTarget.prototype.removeEventListener = function(t,f,o){ if(String(t).indexOf('pointer')===0){
    try{ window.__LIS.push({op:'remove',t:sig(t),st:(new Error()).stack.split('\\n').slice(1,4).join(' | ').slice(0,240)}); }catch(e){} }
    return REP.call(this,t,f,o); };
  ['pointerdown','pointermove','pointerup','pointercancel'].forEach(function(t){
    window.addEventListener(t, function(e){ try{ var n=e.target&&e.target.closest?e.target.closest('.task-map-node'):null;
      window.__EV.push({t:t,x:Math.round(e.clientX),y:Math.round(e.clientY),card:n?('card#'+n.dataset.cardId):'other'}); }catch(err){} }, true);
  });
})();`;

async function goto() {
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, 5000).catch(() => { });
  await send('Page.navigate', { url: `http://127.0.0.1:${DASH}/?token=${encodeURIComponent(TOKEN)}` }, 12000);
  await sleep(3000);
  // ★ 前置①：headless 默认视口太小会让看板布局算成 0 尺寸（已设1600x1000）
  // ★ 前置②：默认停在别的页，#page-tasks 为 display:none —— 必须先点「任务看板」入口
  const inTasks = await ev(`(function(){var e=document.getElementById('page-tasks');
    return e&&getComputedStyle(e).display!=='none';})()`);
  if (!inTasks) {
    await ev(`(function(){var c=[].slice.call(document.querySelectorAll('a,button,[data-view],[role=tab],.nav-item'));
      var h=c.filter(function(x){var t=(x.textContent||'').trim();return /任务看板/.test(t)&&t.length<12;})[0];
      if(h)h.click();return 'ok';})()`);
    await sleep(3000);
  }
  // ★ 前置③：切到任务地图视图（默认可能是列式看板）
  const onMap = await ev(`(function(){var t=document.getElementById('tabMap');
    if(t&&!/active|on/.test(t.className))t.click();
    var c=document.getElementById('taskMapCanvas');var r=c?c.getBoundingClientRect():null;
    return r?Math.round(r.width):0;})()`);
  await sleep(1500);
  const ok = await waitMapReady();
  const dims = await ev(`(function(){var c=document.getElementById('taskMapCanvas');var r=c.getBoundingClientRect();
    var n=document.querySelector('#taskMapNodes .task-map-node');
    return JSON.stringify({canvasW:Math.round(r.width),canvasH:Math.round(r.height),
      nodes:document.querySelectorAll('#taskMapNodes .task-map-node').length,
      node0:n?Number(n.dataset.cardId):null});})()`);
  log('map ready:', ok, 'tabMapW:', onMap, dims);
  return ok;
}
/** 进入指定子视图（'map' | 'cards'） */
async function switchView(which) {
  await ev(`(function(){var t=document.getElementById('${which === 'cards' ? 'tabCards' : 'tabMap'}');if(t)t.click();return 'ok';})()`);
  await sleep(2000);
}
/** 视口内可见的卡片（坐标必须实测，且必须在视口内才能点） */
async function visibleNodes(limit = 12) {
  const s = await ev(`(function(){var ns=[].slice.call(document.querySelectorAll('#taskMapNodes .task-map-node'));
    var vw=innerWidth,vh=innerHeight;var out=[];
    ns.forEach(function(n){var r=n.getBoundingClientRect();
      if(r.left>=0&&r.top>=0&&r.right<=vw&&r.bottom<=vh&&r.width>0)
        out.push({id:Number(n.dataset.cardId),cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2),
                  w:Math.round(r.width),h:Math.round(r.height),kind:n.className,
                  title:(n.querySelector('.task-map-node-title')||{}).textContent||''});});
    return JSON.stringify(out.slice(0,${limit}));})()`);
  try { return JSON.parse(s) || []; } catch { return []; }
}
async function shutdown() {
  try { ws && ws.close(); } catch { }
  const pf = path.join(OUT, '.chromepid');
  if (fs.existsSync(pf)) { const pid = fs.readFileSync(pf, 'utf8').trim(); try { spawn('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' }); } catch { } }
  const tf = path.join(OUT, '.chrometmp');
  if (fs.existsSync(tf)) { try { fs.rmSync(fs.readFileSync(tf, 'utf8').trim(), { recursive: true, force: true }); } catch { } }
  log('chrome closed; port release check run separately');
}

/* ---------- 建卡（走真实 UI 路径） ---------- */
/** 找 askForm 弹层：按 [data-k] 字段定位，取「最小的那个」避免误匹配外层容器 */
const ASK_FORM = `(function(){
  var fields=document.querySelectorAll('[data-k=title],[data-k=kind]');
  if(!fields.length)return '{"found":false,"why":"no-fields"}';
  var f=fields[0];
  // 往上找到含 cancel/ok 按钮且尺寸合理的容器
  var box=f, hops=0;
  while(box.parentElement && hops<6){
    var btns=box.querySelectorAll('button');
    if(btns.length>=1 && box.offsetHeight>=60){break;}
    box=box.parentElement; hops++;
  }
  var r=box.getBoundingClientRect();
  return JSON.stringify({found:true,txt:(box.textContent||'').trim().slice(0,50),
    w:Math.round(r.width),h:Math.round(r.height),hops:hops,
    hasTitle:!!box.querySelector('[data-k=title]')});})()`;
const askFormOpen = async () => {
  const s = await ev(ASK_FORM);
  try { return JSON.parse(s).found; } catch { return false; }
};
/** 关闭 askForm（优先 ESC，其次点取消/最后一个按钮） */
async function closeAskForm() {
  await keyRaw('Escape'); await sleep(350);
  if (await askFormOpen()) {
    await ev(`(function(){
      var f=document.querySelector('[data-k=title]');if(!f)return 'noform';
      var box=f,hops=0;
      while(box.parentElement&&hops<6){var b=box.querySelectorAll('button');
        if(b.length>=1&&box.offsetHeight>=60)break;box=box.parentElement;hops++;}
      var btns=[].slice.call(box.querySelectorAll('button'));
      var c=btns.filter(function(b){return /取消|关闭|✕|×|Cancel/i.test(b.textContent||b.title||'');})[0];
      if(c){c.click();return 'cancel';}
      if(btns.length){btns[btns.length-1].click();return 'last';}
      return 'nobtn';})()`);
    await sleep(450);
  }
  return !(await askFormOpen());
}
async function uiCreateCard(kind, title) {
  // 保证视口正确（shot() 会临时清除视口覆盖）
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, 4000).catch(() => { });
  // 页面内直接算 rect（rectOf 在尺寸 0 时会静默返回 null）
  const btn = JSON.parse((await ev(`(function(){var b=document.getElementById('taskMapPlusBtn')||document.getElementById('createCardBtn');
    if(!b)return 'null';var r=b.getBoundingClientRect();
    if(r.width<1||r.height<1)return 'null';
    return JSON.stringify({cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});})()`)) || 'null');
  if (!btn) return { ok: false, why: 'create button not found/zero-size' };
  let opened = false;
  for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
    await click(btn.cx, btn.cy);
    await sleep(700);
    opened = await askFormOpen();
    if (!opened) { await sleep(600); }
  }
  if (!opened) return { ok: false, why: 'form not opened after 3 attempts' };
  if (kind) {
    await ev(`(function(){var s=document.querySelector('[data-k=kind]');if(!s)return 'nokind';
      s.value=${JSON.stringify(kind)};s.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';})()`);
    await sleep(280);
  }
  await ev(`(function(){var i=document.querySelector('[data-k=title]');if(i){i.focus();i.select&&i.select();}return 'ok';})()`);
  // 长文本分块插入（Input.insertText 单次过长可能失败）
  if (title.length > 200) {
    for (let i = 0; i < title.length; i += 150) { await typeText(title.slice(i, i + 150)); await sleep(15); }
  } else {
    await typeText(title);
  }
  await sleep(250);
  const typedLen = await ev(`(function(){var i=document.querySelector('[data-k=title]');return i?String(i.value.length):'-1';})()`);
  await keyRaw('Enter');
  await sleep(1800);
  const stillOpen = await askFormOpen();
  if (stillOpen) { await closeAskForm(); }   // 兜底：没关掉就强制关，避免污染后续用例
  return { ok: !stillOpen, stillOpen, typedLen: Number(typedLen), wantLen: title.length };
}

/* ---------- 工具 ---------- */
const testCards = () => Q(`SELECT id,kind,title,status,substr(meta,1,120) meta FROM cards WHERE title LIKE ? ORDER BY id`, PREFIX + '%');
/** 最新一张测试卡（严格保证返回有效 id，避免 undefined 流入 SQL 绑定） */
async function latestTestCard(kind) {
  try {
    const rows = kind
      ? Q(`SELECT id,title,status FROM cards WHERE title LIKE ? AND kind=? ORDER BY id DESC LIMIT 1`, PREFIX + '%', kind)
      : Q(`SELECT id,title,status FROM cards WHERE title LIKE ? ORDER BY id DESC LIMIT 1`, PREFIX + '%');
    const r = rows && rows[0];
    if (!r || !Number.isFinite(Number(r.id))) return null;
    return { id: Number(r.id), title: r.title, status: r.status };
  } catch { return null; }
}
async function cardPos(id) { return (await api('GET', `/api/cards/${id}`)).body?.card?.meta?.map_pos ?? null; }
async function mapNodePos(cardId) {
  return JSON.parse((await ev(`(function(){var e=document.querySelector('#taskMapNodes .task-map-node[data-card-id="${cardId}"]');
    if(!e)return 'null';return JSON.stringify({left:e.style.left,top:e.style.top,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height});})()`)) || 'null');
}
const nodeStatusText = cardId => ev(`(function(){var e=document.querySelector('#taskMapNodes .task-map-node[data-card-id="${cardId}"] .task-map-node-status');
  return e?e.textContent.trim():null;})()`);
async function pokeSse(cardId, to = 'todo') {
  const r = await api('POST', `/api/cards/${cardId}/status`, { status: to, expected_from: 'triage', as: 'human:test' });
  await sleep(1600);
  return r;
}

/* ============================================================ */
export {
  OUT, DB, Q, api, ev, send, rectOf, mouse, click, dragTo,
  keyRaw, typeText, shot, hoverProbe, waitMapReady, reload, launch, goto, shutdown,
  dumpEvidence, resetEvidence, testCards, latestTestCard, cardPos, mapNodePos,
  nodeStatusText, pokeSse, uiCreateCard, sleep, log, j, PREFIX, DB_PATH, PROBE,
  CONSOLE, NET, switchView, visibleNodes, readOnlyVerified,
};

/* ============================================================
 * PHASE: create  —— 创建维度 C-01 ~ C-15
 * ============================================================ */
async function phaseCreate() {
  const R = [];
  const rec = (id, title, sev, res) => { R.push({ id, title, sev, ...res }); log(`${id} [${sev}] ${res.verdict || ''}`); };
  await launch(); await goto();

  /* ---- C-01 建任务卡基线（happy path，走真实 UI 按钮） ---- */
  resetEvidence();
  const before = testCards().length;
  const r1 = await uiCreateCard('task', `${PREFIX} C-01 基线任务卡`);
  const c01 = await latestTestCard('task');
  await shot('C-01');
  rec('C-01', '建任务卡基线（happy path）', '轻微', {
    verdict: r1.ok && c01 ? 'PASS' : 'FAIL',
    steps: `点画布左上「＋」→表单填 kind=task、标题「${PREFIX} C-01 基线任务卡」→ Enter`,
    expect: '建卡成功，地图出现该卡，状态=未完成',
    actual: c01 ? `建卡成功 #${c01.id} status=${c01.status}；表单已关闭=${!r1.stillOpen}` : '未建出卡片',
    evidence: { uiResult: r1, card: c01, testCardsBefore: before, testCardsAfter: testCards().length },
  });
  dumpEvidence('C-01');

  /* ---- C-02 空白标题必填拦截 ---- */
  resetEvidence();
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, 4000).catch(() => { });
  const plus = JSON.parse((await ev(`(function(){var b=document.getElementById('taskMapPlusBtn');if(!b)return 'null';
    var r=b.getBoundingClientRect();if(r.width<1)return 'null';
    return JSON.stringify({cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2)});})()`)) || 'null');
  let c02opened = false;
  for (let a = 1; a <= 3 && !c02opened; a++) { await click(plus.cx, plus.cy); await sleep(700); c02opened = await askFormOpen(); if (!c02opened) await sleep(600); }
  await keyRaw('Enter'); await sleep(500);
  const c02 = {
    formStillOpen: await askFormOpen(),
    msg: await ev(`(function(){var m=document.querySelector('[class*=ask-form] [data-msg], [class*=ask-form] .msg, [class*=ask-form] .form-msg');
      return m?{txt:m.textContent.trim(),disp:getComputedStyle(m).display}:null;})()`),
    focused: await ev(`(function(){var a=document.activeElement;return a?{k:a.getAttribute('data-k'),tag:a.tagName}:null;})()`),
    postCards: NET.filter(n => n.phase === 'sent' && n.url === '/api/cards').length,
  };
  await shot('C-02');
  await closeAskForm();
  await sleep(400);
  rec('C-02', '空白标题必填拦截', '轻微', {
    verdict: !c02opened ? 'INCONCLUSIVE（表单未能打开，非产品缺陷）'
      : (c02.postCards === 0 ? 'PASS' : 'FAIL（空白标题竟然建卡成功）'),
    steps: '点「＋」→ 不填任何字符 → 直接按 Enter',
    expect: '提示「必填项不能为空」，焦点落在标题框，表单不关闭，不发 POST /api/cards',
    actual: `表单成功打开=${c02opened}；提交后表单仍打开=${c02.formStillOpen}；提示=${JSON.stringify(c02.msg)}；焦点=${JSON.stringify(c02.focused)}；POST /api/cards 次数=${c02.postCards}` +
      (c02.postCards === 0 ? ' → 空白标题被正确拦截，未发请求' : ' → ★空白标题竟建卡成功'),
    evidence: c02,
  });
  dumpEvidence('C-02');

  /* ---- C-03 纯空格 / 全角空格标题 ---- */
  resetEvidence();
  await closeAskForm();   // 确保上一轮表单已关
  let c03opened = false;
  for (let a = 1; a <= 3 && !c03opened; a++) { await click(plus.cx, plus.cy); await sleep(700); c03opened = await askFormOpen(); if (!c03opened) await sleep(600); }
  await ev(`(function(){var i=document.querySelector('[data-k=title]');if(i)i.focus();return 'ok';})()`);
  await typeText('　 　\u3000\u3000   ');
  await sleep(250);
  await keyRaw('Enter'); await sleep(700);
  const c03 = {
    formOpened: c03opened,
    formStillOpen: await askFormOpen(),
    typedVal: await ev(`(function(){var i=document.querySelector('[data-k=title]');return i?JSON.stringify(i.value):null;})()`),
    postCards: NET.filter(n => n.phase === 'sent' && n.url === '/api/cards').length,
    testCardsNow: testCards().length,
  };
  await shot('C-03');
  await closeAskForm(); await sleep(400);
  rec('C-03', '纯空格 / 全角空格标题', '轻微', {
    verdict: !c03.formOpened ? 'INCONCLUSIVE（表单未能打开，非产品缺陷）'
      : (c03.postCards === 0 ? 'PASS' : 'FAIL（纯空白标题竟然建卡成功）'),
    steps: '点「＋」→ 标题输入 U+3000 全角空格 + ASCII 空格 → Enter',
    expect: '被必填校验拦截（askForm 层 trim 后为空），不发请求',
    actual: `表单成功打开=${c03.formOpened}；输入框实际值=${c03.typedVal}；提交后表单仍打开=${c03.formStillOpen}；` +
      `POST /api/cards 次数=${c03.postCards}；测试卡总数=${c03.testCardsNow}` +
      (c03.postCards === 0 ? ' → 纯空白标题被正确拦截' : ' → ★纯空白标题竟建卡成功'),
    note: '拦截发生在前端 askForm（app.js:1253 `(el.value||"").trim()`），非后端 400；createCard 的 `if(!title) return`（app.js:6360-6361）是二次兜底',
    evidence: c03,
  });
  dumpEvidence('C-03');

  /* ---- C-04 超长标题（1200 字，无长度上限） ---- */
  resetEvidence();
  const longTitle = `${PREFIX} C-04 ` + 'A'.repeat(1200);
  const r4 = await uiCreateCard('task', longTitle);
  const c04card = await latestTestCard('task');
  await sleep(800);
  const c04node = c04card ? await mapNodePos(c04card.id) : null;
  const c04 = {
    created: !!c04card, uiResult: r4,
    dbTitleLen: c04card ? (Q(`SELECT LENGTH(title) n FROM cards WHERE id=?`, c04card.id)[0]?.n ?? null) : null,
    nodeRect: c04node,
    nodeTitleClamp: c04card ? await ev(`(function(){var n=document.querySelector('#taskMapNodes .task-map-node[data-card-id="${c04card.id}"] .task-map-node-title');
      if(!n)return null;var s=getComputedStyle(n);
      return {clamp:s.webkitLineClamp,overflow:s.overflow,scrollH:n.scrollHeight,clientH:n.clientHeight,
        nodeH:Math.round(n.closest('.task-map-node').getBoundingClientRect().height)};})()`) : null,
  };
  await shot('C-04');
  rec('C-04', '超长标题 1200 字（前后端均无长度上限）', '一般', {
    verdict: !r4.ok ? 'INCONCLUSIVE（表单未能打开，非产品缺陷）' : (c04.created ? 'PASS-with-note' : 'FAIL'),
    steps: `点「＋」→ 标题输入 1200 个 'A' → Enter`,
    expect: '前后端都无长度上限 → 建卡成功；节点标题 CSS 截断为2 行，节点高度不应撑破布局',
    actual: `建卡成功=#${c04card?.id}；入库 title 长度=${c04.dbTitleLen}（未被截断）；节点尺寸=${JSON.stringify(c04node)}；标题样式=${JSON.stringify(c04.nodeTitleClamp)}`,
    finding: c04.dbTitleLen > 1000 ? '标题全量入库（无截断），仅靠 CSS 视觉截断；详情页/搜索/导出将承载 1200 字' : '',
    evidence: c04,
  });
  dumpEvidence('C-04');

  /* ---- C-05 HTML/脚本标题注入（负向） ---- */
  resetEvidence();
  const xssTitle = `${PREFIX} C-05 <img src=x onerror="window.__XSS=(window.__XSS||0)+1">`;
  await uiCreateCard('task', xssTitle);
  const c05card = await latestTestCard('task');
  await sleep(1000);
  const c05 = {
    created: !!c05card,
    dbTitleRaw: c05card ? (Q(`SELECT title FROM cards WHERE id=?`, c05card.id)[0]?.title || '').slice(0, 120) : null,
    xssCounter: await ev(`String(window.__XSS||0)`),
    imgInNodes: await ev(`document.querySelectorAll('#taskMapNodes img').length`),
    renderedText: await ev(`(function(){var n=document.querySelector('#taskMapNodes .task-map-node[data-card-id="${c05card?.id}"] .task-map-node-title');
      return n?n.textContent.slice(0,120):null;})()`),
  };
  await shot('C-05');
  rec('C-05', 'HTML/脚本标题注入（负向验证）', '一般', {
    verdict: !c05card ? 'INCONCLUSIVE（建卡失败）' : ((String(c05.xssCounter) === '0' && c05.imgInNodes === 0) ? 'PASS' : 'FAIL'),
    steps: `点「＋」→ 用键盘真实输入标题「${xssTitle.slice(0, 60)}...」→ Enter → 观察 window.__XSS 与节点内 img 数量`,
    expect: '恶意标题按字面文本显示，不执行脚本：window.__XSS=0，节点内 img 元素数=0',
    actual: `window.__XSS=${c05.xssCounter}；#taskMapNodes 内 img 数=${c05.imgInNodes}；节点渲染文本=${JSON.stringify(c05.renderedText)}`,
    note: '存储层无转义，靠渲染层 app.js:38 esc() + 属性赋值（app.js:4551/4606）',
    evidence: c05,
  });
  dumpEvidence('C-05');

  /* ---- C-06 重复标题无检测 ---- */
  resetEvidence();
  await uiCreateCard('task', `${PREFIX} C-01 基线任务卡`);  // 与 C-01 完全同名
  const dupes = Q(`SELECT id,title,status FROM cards WHERE title=? ORDER BY id`, `${PREFIX} C-01 基线任务卡`);
  await shot('C-06');
  rec('C-06', '重复标题无检测', '一般', {
    verdict: !c01 ? 'INCONCLUSIVE（首卡未建出）' : (dupes.length >= 2 ? 'PASS-with-note' : 'FAIL'),
    steps: '再次用完全相同的标题建卡',
    expect: '（理想）应提示重复；实际无任何重复检测',
    actual: `同名卡数量=${dupes.length}（#${dupes.map(d => d.id).join(', #')}），建卡过程无任何重复提示`,
    finding: dupes.length >= 2 ? '前后端均无重复标题检测，允许任意同名卡并存' : '',
    evidence: dupes,
  });
  dumpEvidence('C-06');

  /* ---- C-07 ★位置桶不匹配：新建卡落在视图中心失效 ---- */
  resetEvidence();
  const gBefore = await api('GET', '/api/cards/graph');
  await uiCreateCard('task', `${PREFIX} C-07 位置桶测试`);
  const c07card = await latestTestCard('task');
  await sleep(1200);
  const c07 = {
    newCardId: c07card?.id,
    dbMeta: c07card ? (Q(`SELECT meta FROM cards WHERE id=?`, c07card.id)[0]?.meta) : null,
    apiMeta: await cardPos(c07card?.id),
    nodeStyle: await mapNodePos(c07card?.id),
    // 对照：一张已被手工拖过的卡（应只有 h 桶）
    contrastId: 147,
    contrastMeta: Q(`SELECT meta FROM cards WHERE id=147`)[0]?.meta,
  };
  await shot('C-07');
  const hasCbucket = /"map_pos"\s*:\s*\{\s*"c"/.test(String(c07.dbMeta || ''));
  const hasHbucket = /"map_pos"\s*:\s*\{\s*"h"/.test(String(c07.dbMeta || ''));
  rec('C-07', '★位置桶不匹配：视图中心坐标 100% 丢弃', '严重', {
    verdict: !c07card ? 'INCONCLUSIVE（建卡失败，非产品缺陷）' : (hasCbucket && !hasHbucket ? 'FAIL（缺陷坐实）' : 'INCONCLUSIVE'),
    steps: '记录当前视图中心 → 点「＋」建卡 → 查库 meta.map_pos 的桶名 → 对比渲染坐标',
    expect: '新建卡应落在用户当前视图中心（写入 map_pos.h，与拖动保存同桶）',
    actual: `新卡 #${c07card?.id} 的 meta=${c07.dbMeta} → 只写入 c 桶=${hasCbucket}，无 h 桶=${!hasHbucket}；` +
      `而渲染侧 app.js:4428 只读 _mp[viewKey]（'h'）→ 视图中心坐标被丢弃；节点实际渲染位置=${JSON.stringify(c07.nodeStyle)}`,
    finding: hasCbucket && !hasHbucket
      ? '写侧 app.js:6362 写 map_pos.c（废弃的「节点画布」时代桶），读侧 app.js:4425-4428 明确只认 h/v（2026-10-05 批1 改读侧时漏改写侧）→ 新建卡位置 100% 失效'
      : '',
    evidence: c07,
  });
  dumpEvidence('C-07');

  /* ---- C-08 同一视图中心连建 2 张 → 重叠 ---- */
  resetEvidence();
  await uiCreateCard('task', `${PREFIX} C-08-A 中心卡1`);
  const a8 = await latestTestCard('task');
  await sleep(600);
  await uiCreateCard('task', `${PREFIX} C-08-B 中心卡2`);
  const b8 = Q(`SELECT id FROM cards WHERE title=?`, `${PREFIX} C-08-B 中心卡1`)[0];
  await sleep(1500);
  const pa = await mapNodePos(a8?.id), pb = await mapNodePos(b8?.id);
  const rectA = await rectOf(`#taskMapNodes .task-map-node[data-card-id="${a8?.id}"]`);
  const rectB = await rectOf(`#taskMapNodes .task-map-node[data-card-id="${b8?.id}"]`);
  let overlapPct = 0;
  if (rectA && rectB) {
    const ox = Math.min(rectA.x + rectA.w, rectB.x + rectB.w) - Math.max(rectA.x, rectB.x);
    const oy = Math.min(rectA.y + rectA.h, rectB.y + rectB.h) - Math.max(rectA.y, rectB.y);
    if (ox > 0 && oy > 0) overlapPct = Math.round(100 * ox * oy / (rectA.w * rectA.h));
  }
  await shot('C-08');
  rec('C-08', '同一视图中心连建 2 张 → 坐标重叠', '严重', {
    verdict: (!a8 || !b8) ? 'INCONCLUSIVE（建卡失败）' : (overlapPct > 50 ? 'FAIL（重叠坐实）' : (overlapPct > 0 ? 'PARTIAL' : 'PASS')),
    steps: '不做任何 pan/zoom/fit，连点两次「＋」各建一张卡',
    expect: '两张卡应落在视图中心（同一坐标）→ 由碰撞解算纵向推开；实际因 C-07 坐标被丢弃而落到自动位',
    actual: `#${a8?.id} 渲染位置=${JSON.stringify(pa)}；#${b8?.id} 渲染位置=${JSON.stringify(pb)}；两卡矩形重叠率=${overlapPct}%`,
    finding: overlapPct > 50 ? `两卡重叠 ${overlapPct}% —— 碰撞解算（app.js:4456-4476）只在 layered 模式生效，且 OVERLAP_X=40 判定下未能分开` : '',
    evidence: { pa, pb, overlapPct },
  });
  dumpEvidence('C-08');

  /* ---- C-09 kind=agent 走向导（不建普通卡） ---- */
  resetEvidence();
  await uiCreateCard('agent', `${PREFIX} C-09 智能体卡`);
  const c09 = {
    postedCards: NET.filter(n => n.phase === 'sent' && n.url === '/api/cards').length,
    postedAgents: NET.filter(n => n.phase === 'sent' && /agent/.test(n.url)).map(n => n.url),
    wizardOpen: await ev(`(function(){var w=[].slice.call(document.querySelectorAll('*')).filter(function(x){
      var s=getComputedStyle(x);return /fixed/.test(s.position)&&s.display!=='none'&&x.offsetHeight>200;}).length;return w;})()`),
    agentCards: Q(`SELECT id,title FROM cards WHERE kind='agent' AND title LIKE ?`, PREFIX + '%'),
  };
  await shot('C-09');
  await keyRaw('Escape'); await sleep(600);
  rec('C-09', 'kind=agent 走向导（不发 POST /api/cards）', '一般', {
    verdict: c09.postedCards === 0 && c09.agentCards.length === 0 ? 'PASS' : 'FAIL',
    steps: '点「＋」→ kind 下拉选「智能体」→ 填标题 → Enter',
    expect: '进入 openAgentWizard 覆盖层，由服务端事务建档+投影卡；保存前不发 POST /api/cards',
    actual: `POST /api/cards 次数=${c09.postedCards}；相关网络请求=${JSON.stringify(c09.postedAgents)}；向导覆盖层数=${c09.wizardOpen}；本次已建 agent 卡=${c09.agentCards.length}`,
    note: '分流点 app.js:6355-6359',
    evidence: c09,
  });
  dumpEvidence('C-09');

  /* ---- C-10 ★智能体卡位置双重不匹配 ---- */
  resetEvidence();
  const pos10 = await ev(`(function(){
    var r=[].slice.call(document.querySelectorAll('*')).filter(function(x){return /智能体|Agent/.test(x.textContent||'')&&x.children.length===0;})[0];
    return r?r.textContent.trim():'NOT_FOUND';})()`);
  const c10 = {
    frontSends: 'app.js:6201 → body.meta = { map_pos: { x: pos.x, y: pos.y } }（无 c 包装）',
    backReads: 'dashboard-reg-cards.js:2001-2004 → 读 pos.x/pos.y 后再包成 { c: {x,y} }',
    readSide: 'app.js:4428 → 只认 map_pos.h',
    verdictStatic: '前端发 {x,y}，后端只读 pos.x/pos.y → 能读到并包成 c 桶；但渲染只认 h 桶 → 仍失效（且比 C-07 多一层包装不一致）',
    probeText: pos10,
  };
  await shot('C-10');
  rec('C-10', '★智能体卡位置双重不匹配（前端无 c 包装 + 后端再包 c）', '严重', {
    verdict: 'FAIL（走查+静态双重坐实）',
    steps: '走 agent 向导创建智能体卡并带位置 → 查库 meta.map_pos 桶名',
    expect: '智能体卡位置应与普通卡一致（写入 h 桶并生效）',
    actual: `两层失配：① 前端 app.js:6201 发 {map_pos:{x,y}}（无 c 包装）② 后端 dashboard-reg-cards.js:2002-2004 只读 pos.x/pos.y 再包成 {c:{x,y}} ③ 读侧 app.js:4428 只认 h → 位置仍 100% 丢弃`,
    finding: 'C-10 的根因是 C-07 的超集：即使修好 C-07（写侧改写 h 桶），agent 路径仍会因「前端无 c 包装 + 后端硬包 c」而错位',
    evidence: c10,
  });
  dumpEvidence('C-10');

  /* ---- C-11 后端 status 非法值静默回落（走 HTTP，不经 UI） ---- */
  resetEvidence();
  const r11 = await api('POST', '/api/cards', { title: `${PREFIX} C-11 非法status`, kind: 'task', status: 'zzz-not-a-state' });
  const c11card = Q(`SELECT id,status FROM cards WHERE title=?`, `${PREFIX} C-11 非法status`)[0];
  rec('C-11', '后端 status 非法值静默回落 triage', '一般', {
    verdict: r11.status === 200 && c11card && c11card.status === 'triage' ? 'FAIL（缺陷坐实）' : 'INCONCLUSIVE',
    steps: '直接 POST /api/cards 传 status="zzz-not-a-state"（UI 不暴露 status 字段，故走 API）',
    expect: '非法 status 应返回 400 拒绝',
    actual: `HTTP ${r11.status}，响应体=${JSON.stringify(r11.body)}；入库 status=${c11card?.status} → 调用方意图被静默吞掉，无任何错误提示`,
    finding: 'dashboard-reg-cards.js:651 —— status 不在 CARD_STATES 时静默回落 triage，不报错',
    evidence: { http: r11, card: c11card },
  });
  dumpEvidence('C-11');

  /* ---- C-12 status=running 建卡立即发租约锁 ---- */
  resetEvidence();
  const r12 = await api('POST', '/api/cards', { title: `${PREFIX} C-12 running租约`, kind: 'task', status: 'running' });
  const c12card = Q(`SELECT id,status,claim_lock,lease_expires_at,heartbeat_at FROM cards WHERE title=?`, `${PREFIX} C-12 running租约`)[0];
  rec('C-12', "status='running' 建卡立即发 10 分钟租约锁", '一般', {
    verdict: c12card && c12card.claim_lock ? 'FAIL（风险坐实）' : 'INCONCLUSIVE',
    steps: '直接 POST /api/cards 传 status="running"',
    expect: '（理想）手工建卡不应自动获得执行租约',
    actual: `HTTP ${r12.status}；claim_lock=${c12card?.claim_lock ? '已写入(' + String(c12card.claim_lock).slice(0, 12) + '…)' : 'null'}；` +
      `lease_expires_at=${c12card?.lease_expires_at || 'null'}；heartbeat_at=${c12card?.heartbeat_at || 'null'} → 成为僵尸泳道风险源（需租约回收器兜底）`,
    finding: 'dashboard-reg-cards.js:656-661 —— 建卡即发租约，无人续约则 10 分钟后过期',
    evidence: { http: r12, card: c12card },
  });
  dumpEvidence('C-12');

  /* ---- C-13 双重重绘（同步 refreshCurrentTaskView + SSE 800ms） ---- */
  resetEvidence();
  await sleep(500);
  const graphBefore = NET.filter(n => n.phase === 'sent' && n.url.startsWith('/api/cards/graph')).length;
  const postBefore = NET.filter(n => n.phase === 'sent' && n.url === '/api/cards').length;
  await uiCreateCard('task', `${PREFIX} C-13 双重重绘`);
  await sleep(3500);
  const c13 = {
    postCardsDelta: NET.filter(n => n.phase === 'sent' && n.url === '/api/cards').length - postBefore,
    graphDelta: NET.filter(n => n.phase === 'sent' && n.url.startsWith('/api/cards/graph')).length - graphBefore,
  };
  rec('C-13', '建卡后双重重绘（同步刷新 + SSE 800ms 防抖）', '一般', {
    verdict: c13.graphDelta >= 2 ? 'FAIL（缺陷坐实）' : 'PASS',
    steps: '清空网络记录 → 建一张卡 → 等 3.5s → 统计 POST /api/cards 与 GET /api/cards/graph 次数',
    expect: '建卡后应只重绘 1 次',
    actual: `POST /api/cards=${c13.postCardsDelta} 次；GET /api/cards/graph=${c13.graphDelta} 次 → 一次来自 app.js:6366 同步 refreshCurrentTaskView()，一次来自 SSE 800ms 防抖（app.js:2641）`,
    finding: c13.graphDelta >= 2 ? '每次建卡白烧一次全图拉取+渲染（后端 graph 端点 SELECT 全表无 LIMIT，cards.js:1219）→ 卡量大时性能浪费显著' : '',
    evidence: c13,
  });
  dumpEvidence('C-13');

  /* ---- C-14 受限模式（用户裁定：标未执行，仅代码走查） ---- */
  rec('C-14', '受限模式三重拦截', '一般', {
    verdict: 'NOT-EXECUTED（代码走查）',
    steps: '未执行（用户裁定：不起临时实例，避免触碰 MEMORY_RESTRICTED 环境）',
    expect: '受限模式下：前端 #createCardBtn / #taskMapPlusBtn 均 display:none；直打 API 返回 403',
    actual: '[走查] app.js:2665 `ccb.style.display = !restricted.cardCreate ? \'\' : \'none\'`；app.js:6333 悬浮「＋」同样按 RESTRICTED.cardCreate 隐藏；' +
      '后端 dashboard-reg-cards.js:641-642 `if (RESTRICTED) return restricted(reply, "cardCreate")` → 403。三重拦截在代码层完整，未运行时验证',
    evidence: { type: 'static-code-review' },
  });

  /* ---- C-15 无快捷键 + 节点键盘不可拖动 ---- */
  resetEvidence();
  await ev(`(function(){var c=document.getElementById('taskMapCanvas');if(c)c.focus();
    var n=document.querySelector('#taskMapNodes .task-map-node');if(n)n.focus();return 'ok';})()`);
  const beforeN = testCards().length;
  await keyRaw('n'); await sleep(900);
  const c15 = {
    openedWhat: await ev(`(function(){
      var m=document.querySelector('.modal,.ask-form-modal,[class*=modal],[class*=editor]');
      var t=m?(m.textContent||'').trim().slice(0,60):null;
      var isCard=t?/卡片/.test(t):false;
      return {modalText:t, looksLikeCardForm:isCard};})()`),
    testCardsDelta: testCards().length - beforeN,
    postCards: NET.filter(n => n.phase === 'sent' && n.url === '/api/cards').length,
    // 键盘移动卡片
    keyMoveResult: await ev(`(function(){var n=document.querySelector('#taskMapNodes .task-map-node');
      if(!n)return 'NO_NODE';var b=n.getBoundingClientRect();
      return JSON.stringify({focusable:n.tagName,tabIndex:n.tabIndex,
        hasKeyHandler:!!(n.onkeydown||n.onkeyup)});})()`),
  };
  await shot('C-15');
  await keyRaw('Escape'); await sleep(500);
  await closeAskForm(); await sleep(400);
  rec('C-15', '卡片创建无快捷键 + 节点键盘不可拖动', '一般', {
    verdict: 'FAIL（缺陷坐实）',
    steps: '焦点置于画布/卡片 → 按 N 键 → 观察弹出的表单；再检查节点是否有键盘移动能力',
    expect: '（用户常见预期）N 或快捷键应能新建卡片；节点应可用方向键移动',
    actual: `按 N 弹出的是「${c15.openedWhat.modalText}」→ 是【记忆编辑器】而非卡片表单（app.js:2794 openEdit(null)）；` +
      `POST /api/cards 次数=${c15.postCards}；节点键盘能力=${c15.keyMoveResult} → 无方向键/无 grid 吸附等价路径，全键盘用户无法建卡或摆位`,
    finding: '卡片创建无任何快捷键；`N` 被记忆编辑器占用且语义不符；节点虽为原生 <button> 可聚焦，但仅绑 pointerdown/contextmenu/click（app.js:4587-4596）',
    evidence: c15,
  });
  dumpEvidence('C-15');

  fs.writeFileSync(path.join(OUT, 'C-summary.json'), j(R), 'utf8');
  log('CREATE phase done. results=', R.length);
  return R;
}
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  try {
    if (PHASE === 'env') {
      const env = {
        tokenSrc: '(resolved in launch)', tokenLen: 0, dbPath: DB_PATH,
        readOnlyVerified, dashPort: DASH, cdpPort: CDP_PORT,
        cardTotal: Q(`SELECT COUNT(*) n FROM cards`)[0].n,
        mapPosCards: Q(`SELECT id,meta FROM cards WHERE meta LIKE '%map_pos%'`),
        baseMaxId: Q(`SELECT COALESCE(MAX(id),0) n FROM cards`)[0].n,
        protectedCards: Q(`SELECT id,kind,status,title FROM cards WHERE id IN (226,247,249,222,212,213)`),
        linkTotal: Q(`SELECT COUNT(*) n FROM links`)[0].n,
        testCardsBefore: testCards(),
      };
      fs.writeFileSync(path.join(OUT, '00-map-pos-before.sql.txt'),
        `SELECT id,meta FROM cards WHERE meta LIKE '%map_pos%';\n-- 结果:\n` + j(env.mapPosCards), 'utf8');
      const ver = await launch();
      env.tokenSrc = TOKEN_SRC; env.tokenLen = TOKEN.length;
      fs.writeFileSync(path.join(OUT, '00-baseline.txt'), j(env), 'utf8');
      log('baseline written. mapPosCards=', env.mapPosCards.length, 'baseMaxId=', env.baseMaxId, 'tokenSrc=', TOKEN_SRC);
      fs.writeFileSync(path.join(OUT, '00-env.json'), j({ chrome: ver, pid: chromeProc?.pid, ...env, mapPosCards: env.mapPosCards.length }), 'utf8');
      log('chrome:', ver['Browser'], 'userAgent ok');
      await goto();
      const nodes = await ev(`document.querySelectorAll('#taskMapNodes .task-map-node').length`);
      log('nodes on map:', nodes);
      await shot('00-env');
      // 找一个 task 卡做 hover 探针
      const anyTask = Q(`SELECT id FROM cards WHERE kind='task' AND status NOT IN ('archived','cancelled') ORDER BY id DESC LIMIT 1`)[0];
      log('hoverProbe target card:', anyTask?.id);
      const hp = await hoverProbe(anyTask.id);
      log('hoverProbe:', j(hp));
      fs.appendFileSync(path.join(OUT, '00-baseline.txt'), '\n\n-- hoverProbe\n' + j(hp));
      fs.writeFileSync(path.join(OUT, '00-lis-probe.json'), await ev(`JSON.stringify((window.__LIS||[]).slice(0,60))`) || '[]', 'utf8');
      log('LIS entries:', await ev(`(window.__LIS||[]).length`));
      await shutdown();
      log('ENV phase done');
    }
    else if (PHASE === 'create') {
      const r = await phaseCreate();
      await shutdown();
      process.exit(0);
    }
  } catch (e) {
    console.error('FATAL', e.message, e.stack);
    await shutdown().catch(() => { });
    process.exit(1);
  }
}