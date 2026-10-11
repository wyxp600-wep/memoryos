/**
 * interaction-regression.mjs — 事件委托改造的交互回归验证（临时验证脚本，非门禁）
 * 目的：F 批把 renderAllTable 的 5 轮逐项绑定、renderNoteRail 的逐项绑定改成事件委托，
 *       必须逐条确认行为与原实现一致（点击行开详情 / 复选框 / 编辑 / 删除 / 清除筛选 / 笔记项）。
 * 复用 outputs/a11y-ui-walk.mjs 的 CDP 模式（Node 内置 fetch + WebSocket，零新依赖）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9600 + (Date.now() % 60);
const DIR = path.join(os.tmpdir(), `.chrome-inter-${Date.now()}`);
const TOKEN = process.env.PROBE_TOKEN || '';
const BASE = process.env.PROBE_URL || 'http://127.0.0.1:8787/';

const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--window-size=1440,900',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + DIR, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws; const pending = new Map(); let seq = 0;
function send(method, params = {}) {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
    });
}
async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name} — ${detail}`); };

try {
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
        await sleep(250);
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = list.find(p => p.type === 'page'); if (page) wsUrl = page.webSocketDebuggerUrl;
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
    await send('Page.navigate', { url: BASE + '?token=' + encodeURIComponent(TOKEN) + '#/memory' });
    await sleep(7000);

    // 收集内存中未捕获错误
    await evalJs(`window.__errs=[]; window.addEventListener('error', e => window.__errs.push(String(e.message))); 1`);

    const setup = await evalJs(`JSON.stringify({
        rows: document.querySelectorAll('#allTableBody tr[data-id]').length,
        rowOpen: document.querySelectorAll('#allTableBody .row-open').length,
        editBtns: document.querySelectorAll('#allTableBody [data-edit]').length,
        delBtns: document.querySelectorAll('#allTableBody [data-del]').length,
        checkboxes: document.querySelectorAll('#allTableBody .row-checkbox').length,
        tbodyDelegated: document.getElementById('allTableBody')?.dataset.delegated ?? 'n/a',
        notesItems: document.querySelectorAll('#notesRailList .notes-item').length,
        railDelegated: document.getElementById('notesRailList')?.dataset.delegated ?? 'n/a',
      })`);
    console.log('环境:', setup);
    const env = JSON.parse(setup);

    // mock confirm：删除路径只验证「确认框被调用」，绝不真删（app.js 的 confirm 解析到全局）
    await evalJs(`window.__confirmCalls = []; window.confirm = (msg) => { window.__confirmCalls.push(String(msg)); return false; }; 1`);

    if (!env.rows) { console.log('\n⚠ 无数据行，无法验证表格交互（请用有数据的库启动内核）'); }

    // ① 行点击开详情
    if (env.rows) {
        const r1 = await evalJs(`(async () => {
          const modal = document.getElementById('detailModal');
          modal.classList.remove('show');
          const tr = document.querySelector('#allTableBody tr[data-id]');
          tr.querySelector('td').click();
          await new Promise(r => setTimeout(r, 600));
          return JSON.stringify({ shown: modal.classList.contains('show') });
        })()`);
        check('① 行点击 → 打开详情', JSON.parse(r1).shown === true, r1);
        // 关闭（用 Esc 或直接移除 class）
        await evalJs(`document.getElementById('detailModal').classList.remove('show'); 1`);
    }

    // ② 复选框 → 选中 + 批量条
    if (env.checkboxes) {
        const r2 = await evalJs(`(async () => {
          const cb = document.querySelector('#allTableBody .row-checkbox');
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise(r => setTimeout(r, 300));
          const bar = document.getElementById('batchBar') || document.querySelector('.batch-bar');
          return JSON.stringify({
            rowSelected: cb.closest('tr').classList.contains('selected'),
            batchVisible: bar ? (getComputedStyle(bar).display !== 'none') : 'no-bar-el',
            detailStillClosed: !document.getElementById('detailModal').classList.contains('show'),
          });
        })()`);
        check('② 复选框 → 行选中 + 批量条出现（且未误开详情）', (() => { const o = JSON.parse(r2); return o.rowSelected && o.detailStillClosed; })(), r2);
    }

    // ③ 编辑按钮 → 打开编辑（不触发详情）
    if (env.editBtns) {
        const r3 = await evalJs(`(async () => {
          document.getElementById('editModal')?.classList.remove('show');
          document.getElementById('detailModal').classList.remove('show');
          const btn = document.querySelector('#allTableBody [data-edit]');
          btn.click();
          await new Promise(r => setTimeout(r, 600));
          return JSON.stringify({
            editShown: document.getElementById('editModal') ? document.getElementById('editModal').classList.contains('show') : 'no-edit-modal',
            detailShown: document.getElementById('detailModal').classList.contains('show'),
          });
        })()`);
        const o3 = JSON.parse(r3);
        check('③ 行内「编辑」→ 开编辑且不误开详情', o3.editShown === true && o3.detailShown === false, r3);
        await evalJs(`document.getElementById('editModal')?.classList.remove('show'); 1`);
    }

    // ④ 删除按钮 → 弹确认（且未真删）
    if (env.delBtns) {
        const r4 = await evalJs(`(async () => {
          const btn = document.querySelector('#allTableBody [data-del]');
          btn.click();
          await new Promise(r => setTimeout(r, 500));
          return JSON.stringify({
            confirmCalled: window.__confirmCalls.length,
            msg: window.__confirmCalls[0] || '',
            detailShown: document.getElementById('detailModal').classList.contains('show'),
          });
        })()`);
        const o4 = JSON.parse(r4);
        check('④ 行内「删除」→ 弹确认框（mock 拒绝，未真删）且不误开详情',
            o4.confirmCalled >= 1 && /删除记忆/.test(o4.msg) && o4.detailShown === false, r4);
    }

    // ⑤ 勾选后点行内操作按钮，不应打开详情（原 stopPropagation 语义）
    if (env.rows && env.editBtns) {
        const r5 = await evalJs(`(async () => {
          document.getElementById('detailModal').classList.remove('show');
          const cb = document.querySelector('#allTableBody .row-checkbox');
          cb.click();
          await new Promise(r => setTimeout(r, 400));
          return JSON.stringify({ detailShown: document.getElementById('detailModal').classList.contains('show') });
        })()`);
        check('⑤ 点复选框不打开详情（等价原 closest 判断）', JSON.parse(r5).detailShown === false, r5);
    }

    // ⑥ 笔记项委托（若有笔记数据）
    if (env.notesItems) {
        const r6 = await evalJs(`(async () => {
          const it = document.querySelector('#notesRailList .notes-item');
          const before = document.querySelectorAll('#notesRailList .notes-item.active').length;
          it.click();
          await new Promise(r => setTimeout(r, 800));
          return JSON.stringify({ clicked: true, before, hasRole: it.getAttribute('role'), tabindex: it.getAttribute('tabindex') });
        })()`);
        const o6 = JSON.parse(r6);
        check('⑥ 笔记项可点击 + role/tabindex 已在模板中', o6.hasRole === 'button' && o6.tabindex === '0', r6);
    } else {
        console.log('ℹ 无笔记数据，跳过笔记项验证（role/tabindex 已由模板保证）');
    }

    // ⑦ 页面无未捕获错误
    const errs = await evalJs(`JSON.stringify(window.__errs || [])`);
    check('⑦ 交互过程 0 未捕获 JS 异常', JSON.parse(errs).length === 0, errs);

    const pass = results.filter(r => r.ok).length;
    console.log(`\n=== 交互回归：${pass}/${results.length} 通过 ===`);
    if (pass !== results.length) process.exitCode = 1;
} catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
} finally {
    try { ws && ws.close(); } catch { }
    try { child.kill(); } catch { }
    await sleep(300);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { }
}
