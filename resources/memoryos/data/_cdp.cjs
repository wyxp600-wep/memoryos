(async () => {
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.log('NO_PAGE'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let idc = 0;
const pend = new Map();
const logs = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
  else if (msg.method === 'Runtime.consoleAPICalled') { logs.push(msg.params.args.map(a => String(a.value !== undefined ? a.value : (a.description || ''))).join(' ')); }
};
const send = (method, params) => new Promise((res) => { const i = ++idc; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');
await new Promise((r) => setTimeout(r, 6000));
const expr = "(async () => { const out = {}; const btn = document.querySelector('.task-map-node'); out.nodeFound = !!btn; if (!btn) return JSON.stringify(out); btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 300 })); await new Promise(r => setTimeout(r, 800)); const menu = document.querySelector('#cardCtxMenu'); out.menuShown = !!(menu && menu.classList.contains('show')); out.menuItems = menu ? menu.querySelectorAll('.context-menu-item').length : 0; const item = menu ? menu.querySelector('[data-cardact=\"detail\"]') : null; out.detailItem = !!item; if (item) item.click(); await new Promise(r => setTimeout(r, 1200)); const modal = document.querySelector('#detailModal'); out.detailOpen = !!(modal && modal.classList.contains('show')); return JSON.stringify(out); })()";
const r1 = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
console.log('RESULT:', r1.result && r1.result.result ? String(r1.result.result.value) : JSON.stringify(r1.result));
console.log('LOGS:', JSON.stringify(logs.slice(0, 14)));

})().catch(e => { console.log('ERR', e.message); process.exit(1); });
