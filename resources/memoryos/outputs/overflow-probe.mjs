/**
 * overflow-probe.mjs — 定位窄屏（390px）横向溢出的真实元素（临时诊断，非门禁）
 * 复用 outputs/a11y-ui-walk.mjs 的 CDP 连接模式（Node 内置 fetch + WebSocket，零新依赖）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9500 + (Date.now() % 60);
const DIR = path.join(os.tmpdir(), `.chrome-overflow-${Date.now()}`);
const W = Number(process.env.PROBE_W || 390);
const H = Number(process.env.PROBE_H || 844);
const BASE = process.env.PROBE_URL || 'http://127.0.0.1:8787/';
const TOKEN = process.env.PROBE_TOKEN || '';

const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--window-size=${W},${H}`,
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + DIR, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let ws;
const pending = new Map();
let seq = 0;
function send(method, params = {}) {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
    });
}

const PROBE = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = { vw, sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, items: [] };
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.display === 'none') continue;
    const over = Math.round(r.right - vw);
    if (over > 1) {
      out.items.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && el.className.toString().slice(0, 60)) || '',
        id: el.id || '',
        right: Math.round(r.right),
        width: Math.round(r.width),
        over,
        minW: cs.minWidth, w: cs.width, flex: cs.flex,
      });
    }
  }
  out.items.sort((a, b) => b.over - a.over);
  out.items = out.items.slice(0, 25);
  return JSON.stringify(out);
})()`;

try {
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
        await sleep(250);
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = list.find(p => p.type === 'page');
            if (page) wsUrl = page.webSocketDebuggerUrl;
        } catch { /* retry */ }
    }
    if (!wsUrl) throw new Error('CDP 未就绪');

    ws = new WebSocket(wsUrl);
    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    await send('Page.enable');
    const url = BASE + '?token=' + encodeURIComponent(TOKEN) + '#/tasks';
    await send('Page.navigate', { url });
    await sleep(6000);

    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    const data = JSON.parse(r.result.value);
    console.log(`视口 clientWidth=${data.vw} | documentElement.scrollWidth=${data.sw} | body.scrollWidth=${data.bw}`);
    console.log(`横向溢出元素 ${data.items.length} 个（按越界像素降序，取前 25）：`);
    for (const it of data.items) {
        console.log(`  +${String(it.over).padStart(4)}px  <${it.tag}${it.id ? '#' + it.id : ''}${it.cls ? '.' + it.cls.split(' ').join('.') : ''}>  right=${it.right} width=${it.width} minW=${it.minW} w=${it.w} flex=${it.flex}`);
    }
} catch (e) {
    console.error('PROBE ERROR:', e.message);
} finally {
    try { ws && ws.close(); } catch { }
    try { child.kill(); } catch { }
    await sleep(300);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { }
    process.exit(0);
}
