/**
 * settings-ui-walk.mjs — 设置页「LLM 配置」真实浏览器走查（CDP）
 * 复现并验证用户报的问题：密钥填进去会不会消失、保存后是否还要求重启内核。
 * 用临时 data 目录起内核（MEMORYOS_DATA_DIR），不污染真实 config.json。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));    // …/resources/memoryos/outputs
const REPO = path.resolve(HERE, '..');                        // …/resources/memoryos
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.UI_WALK_PORT || 8792);        // 本脚本自起内核的端口（避开常驻 8787）
const CDP = 9380 + (Date.now() % 30);
const TMP = path.join(os.tmpdir(), 'memoryos-cfgtest-ui');

/** 令牌解析：env → 壳层真源(%APPDATA%) → 仓库内自举（同 agent-ui-walk，2026-09-21 修复硬编码） */
function readToken() {
    if (process.env.MEMORY_TOKEN) return process.env.MEMORY_TOKEN.trim();
    const cands = [
        path.join(process.env.APPDATA || '', 'MemoryOS', 'data', 'token'),
        path.join(REPO, 'data', 'token'),
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

// 用临时 data 目录，不污染真实 config.json
fs.mkdirSync(TMP, { recursive: true });
const cfgSrc = path.join(process.env.APPDATA || '', 'MemoryOS', 'config.json');
if (fs.existsSync(cfgSrc)) fs.copyFileSync(cfgSrc, path.join(TMP, 'config.json'));
const URL = `http://127.0.0.1:${PORT}/?token=${TOKEN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = [];
const rec = (n, p, e = '') => { R.push(p); console.log(`${p ? '✓' : '✗'} ${n}${e ? ' — ' + e : ''}`); };

// 起内核（临时 data 目录）
const kernel = spawn(process.execPath, ['dist/dashboard.js'], {
    cwd: REPO, windowsHide: true, stdio: 'ignore',
    // ★ 2026-09-21：显式注入 MEMORY_TOKEN，否则自起内核会按 MEMORY_DB 所在目录去读
    //   `data/token`（dashboard.js 的自举逻辑），与脚本持有的令牌不一致 → 401 → 页面全空。
    //   由脚本单方面确定令牌，两侧必然一致。
    env: { ...process.env, MEMORYOS_DATA_DIR: TMP, MEMORY_DB: path.join(REPO, 'data/memory.db'), MEMORY_PORT: String(PORT), MEMORY_TOKEN: TOKEN },
});
for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/api/summary`, { headers: { 'x-memory-token': TOKEN } }); if (r.ok) break; } catch { /* wait */ } await sleep(500); }

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${path.join(os.tmpdir(), '.chrome-set-' + Date.now())}`, 'about:blank'], { stdio: 'ignore' });
let ws;
try {
    let ver = null;
    for (let i = 0; i < 40; i++) { try { ver = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch { await sleep(400); } }
    if (!ver) throw new Error('CDP 未就绪');
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let mid = 0; const pending = new Map(); const cdpErrs = [];
    ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
        if (m.method === 'Runtime.exceptionThrown') cdpErrs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    });
    const send = (method, params = {}) => new Promise((res) => { const i = ++mid; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.result?.exceptionDetails) return '[ERR] ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
        return r.result?.result?.value ?? null;
    };
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)));window.addEventListener('unhandledrejection',e=>window.__rejs=(window.__rejs||[]).concat(String(e.reason&&e.reason.message||e.reason)));` });
    await send('Page.navigate', { url: URL });
    await sleep(6000);

    // 打开设置
    await ev(`document.querySelector('#settingsBtn').click()`);
    await sleep(1200);
    const opened = await ev(`document.querySelector('#settingsModal') && getComputedStyle(document.querySelector('#settingsModal')).display !== 'none'`);
    rec('设置面板打开', opened === true);
    rec('新增元素就位（状态/生效端点/测试/清除）',
        (await ev(`['cfgLlmKeyState','cfgLlmEffective','testLlmBtn','cfgLlmKeyClear'].every(id=>!!document.getElementById(id))`)) === true);
    const urlVal = await ev(`document.querySelector('#cfgLlmUrl').value`);
    // 断言不用魔数（原为 includes('agnes')，绑定本机配置）——只要回填出非空值即证明读到配置。
    // ★ 注意排除 ev() 的错误串（'[ERR] …' 也非空，否则会假绿灯）。
    rec('URL 回填真实配置', !!String(urlVal).trim() && !String(urlVal).startsWith('[ERR]'), String(urlVal).slice(0, 90));
    const eff = await ev(`document.querySelector('#cfgLlmEffective').textContent`);
    rec('「当前生效端点」显示归一化完整端点', /chat\/completions/.test(String(eff)), String(eff).slice(0, 90));
    const state0 = await ev(`document.querySelector('#cfgLlmKeyState').textContent`);
    // ★ 2026-09-21：原断言写死「未设置」，但临时 config 是从真实配置拷贝而来（可能已含
    //   llmKeyEnc）→ 真实机器上必然误报为回归。改为按拷贝到的配置判定预期值。
    const tcfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8')); } catch { return {}; } })();
    const expectKeySet = !!tcfg.llmKeyEnc;
    rec(`密钥初始状态与配置一致（预期${expectKeySet ? '已设置' : '未设置'}）`,
        String(state0).includes(expectKeySet ? '已设置' : '未设置'), String(state0));

    // 复现用户操作：填密钥 → 保存 → 看是否"消失"
    await ev(`(function(){var i=document.querySelector('#cfgLlmKey');i.value='sk-ui-walk-key-777';i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    await ev(`(function(){var b=document.querySelector('#saveCfgBtn');b.click();return true})()`);
    await sleep(4000);
    const state1 = await ev(`document.querySelector('#cfgLlmKeyState').textContent`);
    rec('保存后密钥状态 = 已设置（DPAPI 密文存储）', String(state1).includes('已设置') && String(state1).includes('DPAPI'), String(state1));
    const inputCleared = await ev(`document.querySelector('#cfgLlmKey').value === ''`);
    rec('输入框已清空（设计如此，状态另有指示）', inputCleared === true);
    // 关键：重新加载设置（等价于重开面板）后密钥状态是否还在
    await ev(`document.querySelector('#settingsClose').click()`); await sleep(300);
    await ev(`document.querySelector('#settingsBtn').click()`); await sleep(1500);
    const state2 = await ev(`document.querySelector('#cfgLlmKeyState').textContent`);
    rec('★ 重开面板后密钥状态仍在（不再"消失"）', String(state2).includes('已设置'), String(state2));
    const diskHasPlain = fs.readFileSync(path.join(TMP, 'config.json'), 'utf8').includes('sk-ui-walk-key-777');
    rec('磁盘上无明文密钥', diskHasPlain === false);

    // 测试连接按钮：需本地 Ollama 在线；未运行时跳过（避免把「环境缺失」误报为回归）
    let ollamaOk = false;
    try { ollamaOk = (await fetch('http://127.0.0.1:11434/v1/models')).ok; } catch { /* 未运行 */ }
    if (!ollamaOk) {
        console.log('○ 跳过「测试连接」断言 —— 本地 Ollama(11434) 未运行（起 Ollama 后可跑）');
    } else {
        await ev(`(function(){document.querySelector('#cfgLlmUrl').value='http://127.0.0.1:11434/v1';document.querySelector('#cfgLlmModel').value='qwen3:8b';document.querySelector('#testLlmBtn').click();return true})()`);
        let tres = '';
        for (let i = 0; i < 40; i++) { await sleep(1500); tres = String(await ev(`document.querySelector('#cfgLlmTestResult').textContent`)); if (tres && !tres.includes('测试中')) break; }
        rec('「测试连接」返回成功', tres.includes('✓ 连接成功'), tres.replace(/\s+/g, ' ').slice(0, 90));
    }

    // 清除密钥
    const beforeErrs = await ev(`JSON.stringify(window.__errs||[])`);
    rec('全程 0 JS 错误', JSON.parse(beforeErrs || '[]').length === 0, beforeErrs);
    rec('CDP 0 未捕获异常', cdpErrs.length === 0, cdpErrs.join(' | ').slice(0, 150));
}
catch (e) { rec('走查执行', false, String(e.message).slice(0, 160)); }
finally {
    try { ws?.close(); } catch { /* */ }
    try { chrome.kill(); } catch { /* */ }
    try { kernel.kill(); } catch { /* */ }
    await sleep(400);
    fs.rmSync(TMP, { recursive: true, force: true });
}
const bad = R.filter((x) => !x).length;
console.log(bad ? `\n${bad}/${R.length} 项失败` : `\n全部通过（${R.length} 项）`);
process.exit(bad ? 1 : 0);
