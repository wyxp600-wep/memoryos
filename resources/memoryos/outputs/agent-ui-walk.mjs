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

const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9370 + (Date.now() % 50);
const DIR = `${os.tmpdir().replace(/\\/g, '/')}/.chrome-agentwalk-${Date.now()}`;
const TOKEN = fs.readFileSync('C:/Users/WYX/Desktop/MemoryOS/resources/memoryos/data/token', 'utf8').trim();
const URL = `http://127.0.0.1:8787/?token=${TOKEN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = [];
const rec = (name, pass, extra = '') => { R.push({ name, pass, extra }); console.log(`${pass ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); };

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
    const statusText = await ev(`document.querySelector('#agentStatusLine').textContent`);
    rec('状态行拉到模型/工具面', /qwen3:8b|dashboard|18/.test(String(statusText)), String(statusText).slice(0, 120));
    const writeDisabled = await ev(`(function(){var c=document.querySelector('#agentAllowWrites');return c?(c.disabled?'disabled':'enabled'):'missing'})()`);
    rec('受限模式 → 「允许写入」置灰', writeDisabled === 'disabled', `checkbox=${writeDisabled}`);

    // 4) 注入中文提问并发送（真实 agent 一轮，本地模型较慢）
    const question = '只调用一次 task_next(project="global", as="")，然后用一句话说有没有可做的任务。';
    await ev(`(function(){var t=document.querySelector('#agentInput');t.value=${JSON.stringify(question)};t.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    const before = await ev(`document.querySelectorAll('#agentChat > div').length`);
    await ev(`document.querySelector('#agentSendBtn').click()`);
    let answered = false, bubbles = 0;
    for (let i = 0; i < 60; i++) { // 最多等 240s
        await sleep(4000);
        bubbles = await ev(`document.querySelectorAll('#agentChat > div').length`);
        const busy = await ev(`document.querySelector('#agentSendBtn').disabled`);
        if (bubbles > before && busy === false) { answered = true; break; }
    }
    const answerText = await ev(`(function(){var d=document.querySelectorAll('#agentChat > div');return d.length?d[d.length-1].textContent:''})()`);
    rec('agent 作答并渲染进对话区', answered, `bubbles ${before}→${bubbles}；尾条：${String(answerText).replace(/\s+/g, ' ').slice(0, 130)}`);
    const toolChip = await ev(`document.querySelectorAll('#agentChat details').length`);
    rec('工具调用轨迹折叠块出现', Number(toolChip) >= 1, `details=${toolChip}`);

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
const bad = R.filter((r) => !r.pass).length;
console.log(bad ? `\n${bad}/${R.length} 项失败` : `\n全部通过（${R.length} 项）`);
process.exit(bad ? 1 : 0);
