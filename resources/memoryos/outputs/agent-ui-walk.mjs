/**
 * agent-ui-walk.mjs — Agent 页 CDP 点击巡检（真实 Chrome headless）
 * 依据 cdp-ui-walk 技能铁律：全新 user-data-dir / JSON.stringify 注入中文 / 自动接受 dialog /
 *   addScriptToEvaluateOnNewDocument 抢在页面脚本前装错误收集器（否则漏掉 init 期错误）。
 * 断言：导航存在 → 点击进入 Agent 页 → 状态行拿到模型信息（证明 cookie 鉴权+fetch 通）→
 *       注入中文提问 → 等 agent 作答 → 全程 0 JS 错误 / 0 未捕获 rejection。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // …/resources/memoryos/outputs
const KERNEL = path.resolve(HERE, '..');                     // …/resources/memoryos
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9370 + (Date.now() % 50);                       // 本脚本自用的 CDP 调试端口
const DASH_PORT = Number(process.env.MEMORY_PORT || 8787);   // 被走查的 dashboard 端口
const DIR = path.join(os.tmpdir(), `.chrome-agentwalk-${Date.now()}`);

/**
 * 令牌解析顺序：env `MEMORY_TOKEN` → 壳层真源 `%APPDATA%/MemoryOS/data/token`
 *              → 独立内核自举 `resources/memoryos/data/token`。
 * ★ 2026-09-21 修复：原先硬编码仓库内路径，而 Electron 壳实际用的是 %APPDATA% 那份，
 *   两份互不相同 → 请求 401 → 白页 → 全部断言失败（曾实测：repo 份 a076caef… /
 *   壳层份 466fe31c…；前者请求 401，后者 302）。
 */
function readToken() {
    if (process.env.MEMORY_TOKEN) return process.env.MEMORY_TOKEN.trim();
    const cands = [
        path.join(process.env.APPDATA || '', 'MemoryOS', 'data', 'token'),
        path.join(KERNEL, 'data', 'token'),
    ];
    for (const f of cands) {
        try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch { /* 试下一个 */ }
    }
    throw new Error(`未找到访问令牌：设 MEMORY_TOKEN，或确保 ${cands[0]} 存在`);
}

let TOKEN = '';
try { TOKEN = readToken(); }
catch (e) { console.error('✗ ' + e.message); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error(`✗ 未找到 Chrome：${CHROME}（可用 CHROME_BIN 指定）`); process.exit(1); }
const URL = `http://127.0.0.1:${DASH_PORT}/?token=${TOKEN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = [];
const rec = (name, pass, extra = '') => { R.push({ name, pass, extra }); console.log(`${pass === 'skip' ? 'SKIP' : pass ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${DIR}`, 'about:blank'], { stdio: 'ignore' });

let ws;
const dialogs = [];
const cdpErrs = [];
try {
    // 等 CDP 就绪
    let ver = null;
    for (let i = 0; i < 40; i++) {
        try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
        catch { await sleep(500); }
    }
    if (!ver) throw new Error('Chrome CDP 未就绪（chrome 未安装或端口被占）');
    console.log(`Chrome: ${ver['Browser']}`);

    let page = null;
    for (let i = 0; i < 20; i++) {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((t) => t.type === 'page');
        if (page) break;
        await sleep(300);
    }
    if (!page) throw new Error('找不到 page target');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let mid = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
        if (m.method === 'Page.javascriptDialogOpening') {
            dialogs.push(m.params.message);
            ws.send(JSON.stringify({ id: ++mid, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
        }
        if (m.method === 'Runtime.exceptionThrown') {
            cdpErrs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown');
        }
    });
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++mid; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const ev = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.result?.exceptionDetails) return '[ERR] ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
        return r.result?.result?.value ?? null;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    // 抢在页面脚本前装错误收集器
    await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.__errs=[];window.__rejs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)));window.addEventListener('unhandledrejection',e=>window.__rejs.push(String(e.reason&&e.reason.message||e.reason)));`,
    });
    await send('Page.navigate', { url: URL });
    await sleep(6000); // 等 load() + initXxx 走完

    // 1) 导航项存在
    const navCount = await ev(`document.querySelectorAll('.nav-item[data-route="agent"]').length`);
    rec('导航项 Agent 存在', navCount === 1, `count=${navCount}`);

    // 2) 点击进入 Agent 页
    const clicked = await ev(`(function(){var n=document.querySelector('.nav-item[data-route="agent"]');if(!n)return 'missing';n.click();return true})()`);
    await sleep(2500);
    const activeOk = await ev(`document.querySelector('#page-agent') && document.querySelector('#page-agent').classList.contains('active')`);
    const title = await ev(`document.title`);
    rec('点击导航 → Agent 页激活', clicked === true && activeOk === true, `title=${title}`);

    // 3) 状态行（模型 + 工具面）：证明鉴权 cookie + fetch /api/agent/status 通
    //    断言不用魔数（原为 /qwen3:8b|dashboard|18/，「18」是过期工具数且会随模型名漂移）。
    //    ★ 2026-11-17：现版正常时**刻意隐藏**状态行（app.js initAgent：line.textContent=issue; line.hidden=!issue），
    //    旧断言「文本必须非空」必然误报 → 拆成「接口可达」+「元素状态自洽」两条，不削弱对接口的验证。
    const statusApi = await ev(`fetch('/api/agent/status').then(r=>r.json()).then(j=>({http:'ok',hasMcp:!!(j&&j.mcp)})).catch(e=>({http:'err',msg:String(e&&e.message||e)}))`);
    rec('鉴权 cookie + /api/agent/status 可达', statusApi && statusApi.http === 'ok', JSON.stringify(statusApi).slice(0, 120));
    const statusLine = await ev(`(function(){var e=document.querySelector('#agentStatusLine');return e?{hidden:!!e.hidden,text:String(e.textContent||'')}:null})()`);
    rec('状态行渲染自洽（有提示必可见 / 无提示必隐藏）',
        !!statusLine && (statusLine.text ? !statusLine.hidden : statusLine.hidden),
        JSON.stringify(statusLine).slice(0, 120));
    const writeDisabled = await ev(`(function(){var c=document.querySelector('#agentAllowWrites');return c?(c.disabled?'disabled':'enabled'):'missing'})()`);
    // ★ 2026-09-21：原断言写死 `=== 'disabled'`（假定受限模式开启），而受限模式实际由
    //   config.json 的 restricted 决定（core-process.js:128 `cfg.restricted === true ? "1" : "0"`），
    //   默认关闭 → 勾选框可点 → 原断言必然误报为回归。改为按真实配置判定。
    const cfgRestricted = (() => {
        try {
            const f = path.join(process.env.APPDATA || '', 'MemoryOS', 'config.json');
            return JSON.parse(fs.readFileSync(f, 'utf8')).restricted === true;
        } catch { return false; }
    })();
    rec(`「允许写入」与受限模式一致（restricted=${cfgRestricted}）`,
        writeDisabled === (cfgRestricted ? 'disabled' : 'enabled'), `checkbox=${writeDisabled}`);

    // 4) 注入中文提问并发送（真实 agent 一轮，本地模型较慢）
    const question = '只调用一次 task_next(project="global", as="")，然后用一句话说有没有可做的任务。';
    await ev(`(function(){var t=document.querySelector('#agentInput');t.value=${JSON.stringify(question)};t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    const before = await ev(`document.querySelectorAll('#agentChat > div').length`);
    // ★ 2026-11-17：run 结束（SSE 终态）时前端会把内联过程块 detach/清空，结束时再数 .run-card 必然为 0。
    //   改为在整个 run 期间用 MutationObserver 记录卡片数量峰值，验证「运行中确实渲染过轨迹」。
    await ev(`(function(){window.__maxRunCards=0;var t=document.querySelector('#agentRunLiveTimeline');if(!t)return false;
      var upd=function(){var n=t.querySelectorAll('.run-card').length;if(n>window.__maxRunCards)window.__maxRunCards=n;};upd();
      new MutationObserver(upd).observe(t,{childList:true,subtree:true});return true;})()`);
    await ev(`document.querySelector('#agentSendBtn').click()`);
    let answered = false, bubbles = 0, tail = '', pollMax = 0;
    for (let i = 0; i < 60; i++) { // 最多等 240s
        await sleep(4000);
        bubbles = await ev(`document.querySelectorAll('#agentChat > div').length`);
        const busy = await ev(`document.querySelector('#agentSendBtn').disabled`);
        tail = String(await ev(`(function(){var d=document.querySelectorAll('#agentChat > div');return d.length?d[d.length-1].textContent:''})()`));
        const cards = Number(await ev(`document.querySelectorAll('#agentRunLiveTimeline .run-card').length`)) || 0;
        if (cards > pollMax) pollMax = cards;
        // ★ 2026-09-21：原判定 `bubbles > before && busy === false` 会在「运行中…」占位气泡
        //   仍在时判为完成（假绿灯——实测曾据此报「作答成功」而尾条仍是运行中文案）。
        //   改为额外要求占位文案已消失。
        if (bubbles > before && busy === false && !/运行中/.test(tail)) { answered = true; break; }
    }
    const answerText = tail;
    rec('agent 作答并渲染进对话区', answered, `bubbles ${before}→${bubbles}；尾条：${String(answerText).replace(/\s+/g, ' ').slice(0, 130)}`);
    // ★ 2026-09-21：原断言查 `#agentChat details` 已失效 —— 前端 2026-09-20 把执行记录/步骤
    //   时间线统一渲染到「执行过程」区 `#agentRunLive`，不再写入聊天区（见 app.js:5712）。
    //   工具轨迹现为 `#agentRunLiveTimeline .run-card`（app.js:5172 / index.html:4587）。
    const observed = Number(await ev(`window.__maxRunCards || 0`)) || 0;
    const toolSteps = Number(await ev(`document.querySelectorAll('#agentRunLiveTimeline .run-card').length`)) || 0;
    const peak = Math.max(observed, pollMax, toolSteps);
    // ★ 2026-11-17：上游模型不可用（401/403/429/5xx）时 run 在工具调用前就失败，时间线必然为空。
    //   这种「没步骤」是环境缺凭据/被限流，不是渲染回归 → 判 SKIP 并写明原因；run 正常但无卡片仍判 FAIL。
    const llmDown = /LLM HTTP (?:401|403|429|5\d\d)/.test(String(answerText));
    rec('工具调用轨迹（执行过程时间线）出现', llmDown ? 'skip' : peak >= 1,
        llmDown ? `上游模型不可用，本轮无工具步骤（peak=${peak}）` : `峰值卡片=${peak}（结束时 ${toolSteps}）`);

    // 5) 错误收集
    const errs = await ev(`JSON.stringify(window.__errs)`);
    const rejs = await ev(`JSON.stringify(window.__rejs)`);
    rec('页面 0 JS 错误 / 0 未捕获 Promise', JSON.parse(errs || '[]').length === 0 && JSON.parse(rejs || '[]').length === 0, `errs=${errs} rejs=${rejs}`);
    rec('CDP 0 未捕获异常', cdpErrs.length === 0, cdpErrs.join(' | ').slice(0, 200));
    rec('无阻塞型 dialog', dialogs.length === 0, dialogs.join(' | '));
}
catch (e) {
    rec('巡检执行', false, String(e.message).slice(0, 200));
}
finally {
    try { ws?.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    await sleep(300);
    fs.rmSync(DIR, { recursive: true, force: true });
}
const bad = R.filter((r) => r.pass === false).length;
const skipped = R.filter((r) => r.pass === 'skip').length;
const skipNote = skipped ? `，${skipped} 项 SKIP` : '';
console.log(bad ? `\n${bad}/${R.length} 项失败${skipNote}` : `\n全部通过（${R.length} 项${skipNote}）`);
process.exit(bad ? 1 : 0);
