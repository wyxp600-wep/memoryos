/**
 * workbench-ui-walk.mjs — Orca 融合 P0+P1 前端自走查（真实 Chrome headless，CDP，零新增依赖）
 *
 * 覆盖（2026-10-03 CLAIM §5；P0+P1 对应 dashboard-reg-workbench.js，P2 对应 dashboard-reg-term.js / dashboard-reg-github.js）：
 *   W1 P0 附件上传：拖拽 drop 事件 → /api/artifacts/upload → 输入框内联插入（≤64KB 文本全文内联）
 *   W2 P1 卡片「工作区」Tab：无 worktree 时展示共享优先 policy + 创建按钮
 *   W3 创建 worktree 并关联卡片（走真实 API，种子卡）
 *   W4 diff 渲染：wb-line 行数 > 0 且含种子改动内容
 *   W5 行级批注：点 ✎ → 表单 → 提交 → 行下 .wb-ann 徽标出现 + API 落库
 *   W6 回传批注给 Agent：汇总为卡片评论（POST /api/cards/:id/comment）
 *   W7 清理 worktree：清理按钮 → askForm → DELETE → 卡片关联归位
 *   W8 空体 DELETE（带 json content-type）容错回归
 *   W9 P2 准终端抽屉打开 + cwd 下拉加载
 *   W10 终端真执行 git --version（SSE 流式输出 + [exit 0]）
 *   W11/W12 后端安全口径：非白名单 400 / cwd 越界 400
 *   W13 分屏切换（Pane 2 显隐）
 *   W14 GitHub 区块渲染（配置字段齐全）
 *   W15 保存 owner/repo → 状态徽标回显（temp config 隔离）
 *   W16 issue 关联本卡 → ref + 状态徽标回显
 *   W17 建 PR 写侧降级：本仓无 origin → 409 no-remote hint 展示
 *   CDP 0 未捕获异常（与 a11y 门禁同口径）
 *
 * 隔离要点：本机 shell 注入 MEMORYOS_DATA_DIR=生产目录 → 必须在启动时覆盖到临时目录，
 *   否则 W15 的 repo/token 会写进**生产 config.json**（P2 首跑实际踩中，见 CLAIM §4）。
 *
 * 用法：node outputs/workbench-ui-walk.mjs        （自起 temp 实例 + temp 库，不碰生产内核/生产库/生产 config）
 *       可用 CHROME_BIN 指定 Chrome；产物仅打印，不写基线。
 * 退出码：0 全过；1 有 FAIL 或执行异常。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KERNEL = path.resolve(HERE, '..');
const DIST = path.join(KERNEL, 'dist');
const REPO = path.resolve(KERNEL, '..', '..');            // 仓根（.worktrees 落这里）
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.WB_PORT || 8791 + (Date.now() % 60));
const TOKEN = 'wb-walk-' + Date.now();
const DIR = path.join(os.tmpdir(), `.chrome-wbwalk-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) { console.error('✗ 未找到 Chrome：' + CHROME + '（可用 CHROME_BIN 指定）'); process.exit(1); }

const { openDb } = await import(`file:///${DIST}/db.js`);
const { buildApp } = await import(`file:///${DIST}/dashboard.js`);

const R = [];
const rec = (name, ok, extra = '') => { R.push({ name, ok }); console.log((ok ? '✓ ' : '✗ ') + name + (extra ? ' — ' + extra : '')); };

let ws, app, db;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-db-'));
// ★ P2 隔离：本机 shell 常驻 MEMORYOS_DATA_DIR=生产目录（dataDirOf 优先级高于 MEMORY_DB 反推），
//   不覆盖则本脚本的 artifacts / config（W15 的 repo+token）会写进生产目录。钉到临时目录。
process.env.MEMORYOS_DATA_DIR = path.join(WS, 'data');
let cardId = 0;
const H = { 'content-type': 'application/json', 'x-memory-token': TOKEN };
let chrome = null;
try {
    // ── 1. temp 实例 + 种子数据 ──
    db = openDb(path.join(WS, 't.db'));
    cardId = Number(db.prepare(`INSERT INTO cards (title, kind, board, status) VALUES ('workbench 自走查种子卡','task','default','running')`).run().lastInsertRowid);
    app = await buildApp(db, { token: TOKEN });
    await app.listen({ port: PORT, host: '127.0.0.1' });
    const api = (m, u, b) => fetch('http://127.0.0.1:' + PORT + u, { method: m, headers: b ? H : { 'x-memory-token': TOKEN }, ...(b ? { body: JSON.stringify(b) } : {}) });

    // ── 2. 种子 worktree（不关联卡片 —— W2c 要验证「未关联」态；W3 再由 UI 创建并关联）──
    const rCreate = await api('POST', '/api/worktrees', { name: 'wb-walk-1' });
    if (!rCreate.ok) throw new Error('种子 worktree 创建失败：' + (await rCreate.text()).slice(0, 200));
    fs.appendFileSync(path.join(REPO, '.worktrees', 'wb-walk-1', 'README.md'), '\n<!-- workbench-ui-walk-probe -->\n');

    // ── 3. Chrome + CDP ──
    chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
        '--window-size=1440,900', '--remote-debugging-port=' + (PORT + 1000), '--user-data-dir=' + DIR, 'about:blank'], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 40; i++) {
        try { ver = await (await fetch('http://127.0.0.1:' + (PORT + 1000) + '/json/version')).json(); break; }
        catch { await sleep(500); }
    }
    if (!ver) throw new Error('Chrome CDP 未就绪');
    let page = null;
    for (let i = 0; i < 20; i++) {
        const list = await (await fetch('http://127.0.0.1:' + (PORT + 1000) + '/json/list')).json();
        page = list.find((t) => t.type === 'page');
        if (page) break;
        await sleep(300);
    }
    if (!page) throw new Error('找不到 page target');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let mid = 0;
    const pending = new Map();
    const cdpErrs = [];
    ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
        if (m.method === 'Runtime.exceptionThrown') cdpErrs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || 'unknown');
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
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/?token=' + TOKEN });
    await sleep(6000);

    // ── W1：P0 附件拖拽上传（DataTransfer drop → 输入框内联）── 先切到 agent 路由（输入区在该页初始化）
    await ev(`(function(){var n=document.querySelector('.nav-item[data-route="agent"]');if(n)n.click();return 1})()`);
    await sleep(2500);
    const zone = await ev(`(function(){var z=document.getElementById('agentInputZone');return z?'ok':'no-zone'})()`);
    if (zone === 'ok') {
        await ev(`(function(){
          var z=document.getElementById('agentInputZone');
          var dt=new DataTransfer();
          dt.items.add(new File(['probe content 走查内联'], 'wb-attach-probe.txt', {type:'text/plain'}));
          z.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
          return 'ok';
        })()`);
        await sleep(1800);
        const val = await ev(`(document.getElementById('agentInput')||{}).value||''`);
        rec('W1 拖拽附件：上传 artifact + 文本内联进 prompt', typeof val === 'string' && val.includes('[附件 artifact:up-') && val.includes('probe content'), String(val).slice(0, 90).replace(/\n/g, '\\n'));
        const btnOk = await ev(`(function(){var b=document.getElementById('agentAttachBtn');return !!(b&&b.getAttribute('aria-label')&&b.tabIndex>=0)})()`);
        rec('W1b 📎 按钮可聚焦且有可访问名（移动端兜底）', btnOk === true);
    } else {
        rec('W1 拖拽附件（agent 输入区存在）', false, String(zone));
    }

    // ── W2/W3：任务看板（任务地图）→ 卡片详情 → 工作区 Tab ──
    // 卡片看板视图已并入任务地图（_taskViewMode='map' 唯一），节点数据源 /api/cards/graph
    await ev(`(function(){var n=document.querySelector('.nav-item[data-route="tasks"]');if(n)n.click();return 1})()`);
    let opened = 'no-node';
    for (let i = 0; i < 12; i++) {
      await sleep(800);
      opened = await ev(`(function(){
        var links=document.querySelectorAll('#taskMapNodes [data-card-id]');
        for(var i=0;i<links.length;i++){
          if(links[i].getAttribute('data-card-id')==='${cardId}'){
            var b=links[i].closest('button');
            if(b){b.click();return 'ok'}
          }
        }
        return 'wait';
      })()`);
      if (opened === 'ok') break;
    }
    await sleep(2200);
    const modalOpen = await ev(`!!document.querySelector('#detailModal.show')`);
    rec('W2 卡片详情可打开（地图节点 · 种子卡）', opened === 'ok' && modalOpen === true, 'opened=' + opened + ' modal=' + modalOpen);
    const tabClick = await ev(`(function(){var t=document.querySelector('[data-ctab="workspace"]');if(!t)return 'no-tab';t.click();return 'ok'})()`);
    await sleep(2500);
    rec('W2b 「工作区」Tab 存在且可点', tabClick === 'ok', String(tabClick));
    const hasCreate = await ev(`!!document.getElementById('wbCreateBtn')`);
    rec('W2c 未关联时显示创建入口（共享优先 policy）', hasCreate === true);

    // 点创建 → askForm → 填名 → 提交（真实建 worktree 并关联本卡）
    await ev(`(function(){var b=document.getElementById('wbCreateBtn');if(b)b.click();return 1})()`);
    await sleep(700);
    const formUp = await ev(`!!document.querySelector('.ask-form-modal input[data-k="name"]')`);
    rec('W3 创建弹窗（askForm）打开', formUp === true);
    await ev(`(function(){var i=document.querySelector('.ask-form-modal input[data-k="name"]');if(i)i.value='wb-walk-2';var b=document.querySelector('.ask-form-modal [data-ok]');if(b)b.click();return 1})()`);
    await sleep(3500);
    const diffBox = await ev(`(function(){return document.getElementById('wbDiff')?'ok':'no-diff'})()`);
    rec('W3b 创建成功后渲染工作区 diff 容器', diffBox === 'ok', String(diffBox));
    const wtAfter = await (await api('GET', '/api/worktrees')).json();
    const linked = (wtAfter.items || []).find(x => x.name === 'wb-walk-2');
    rec('W3c worktree 关联到种子卡（cardId 回填）', !!linked && linked.cardId === cardId, JSON.stringify(linked || null));
    // 新建 worktree 是干净检出（diff 必空）→ 制造改动后点刷新，验证 diff 渲染与 ✎ 触发件
    fs.appendFileSync(path.join(REPO, '.worktrees', 'wb-walk-2', 'README.md'), '\n<!-- wb-walk-2 dirty -->\n');
    await ev(`(function(){var b=document.getElementById('wbRefreshBtn');if(b)b.click();return 1})()`);
    await sleep(2000);
    const diffReady = await ev(`(function(){var d=document.getElementById('wbDiff');if(!d)return 'no-diff';return String(d.querySelectorAll('.wb-line').length)})()`);
    rec('W4 刷新后 diff 渲染行', Number(diffReady) > 0, 'wb-line=' + diffReady);
    const hasMark = await ev(`(function(){var d=document.getElementById('wbDiff');return d?d.querySelectorAll('.wb-mark').length:0})()`);
    rec('W4b diff 行含 ✎ 批注触发件', Number(hasMark) > 0, 'wb-mark=' + hasMark);

    // ── W5：行级批注 ──
    await ev(`(function(){var m=document.querySelector('.wb-mark');if(m)m.click();return 1})()`);
    await sleep(500);
    const annForm = await ev(`!!document.querySelector('.wb-ann-form textarea')`);
    rec('W5 点 ✎ 弹出行级批注表单', annForm === true);
    await ev(`(function(){var t=document.querySelector('.wb-ann-form textarea');if(t)t.value='走查批注：这里改成异步';var b=document.querySelector('.wb-ann-form [data-wb-ok]');if(b)b.click();return 1})()`);
    await sleep(1500);
    const annBadge = await ev(`(function(){var d=document.getElementById('wbDiff');return d?d.querySelectorAll('.wb-ann').length:0})()`);
    rec('W5b 批注提交后行下出现徽标', Number(annBadge) > 0, '.wb-ann=' + annBadge);
    const annApi = await (await api('GET', `/api/cards/${cardId}/annotations`)).json();
    rec('W5c 批注 API 落库往返', (annApi.annotations || []).length === 1 && annApi.annotations[0].body === '走查批注：这里改成异步', JSON.stringify(annApi.annotations || []).slice(0, 120));

    // ── W6：回传批注给 Agent ──
    await ev(`(function(){var b=document.getElementById('wbSendBackBtn');if(b)b.click();return 1})()`);
    await sleep(1200);
    const cmts = await (await api('GET', `/api/cards/${cardId}/comments`)).json();
    const sentBack = (cmts.comments || []).some(c => c.body.includes('【diff 批注回传') && c.body.includes('走查批注：这里改成异步'));
    rec('W6 回传批注生成汇总评论（Agent 下轮可见）', sentBack, 'comments=' + (cmts.comments || []).length);

    // ── W7：清理 work区 ──
    await ev(`(function(){var b=document.getElementById('wbRemoveBtn');if(b)b.click();return 1})()`);
    await sleep(700);
    const askUp = await ev(`!!document.querySelector('.ask-form-modal [data-ok]')`);
    rec('W7 清理走 askForm 二次确认', askUp === true);
    // wb-walk-2 带脏改动（W4 种的）→ 必须勾强制，否则后端按契约 409
    await ev(`(function(){var i=document.querySelector('.ask-form-modal input[data-k="force"]');if(i)i.value='1';var b=document.querySelector('.ask-form-modal [data-ok]');if(b)b.click();return 1})()`);
    await sleep(3500);
    const wtFinal = await (await api('GET', '/api/worktrees')).json();
    const gone2 = !(wtFinal.items || []).some(x => x.name === 'wb-walk-2');
    rec('W7b 清理后 worktree 消失', gone2 === true, 'items=' + (wtFinal.items || []).map(x => x.name).join(','));
    const crow = db.prepare(`SELECT workspace, workspace_kind FROM cards WHERE id=?`).get(cardId);
    rec('W7c 清理后卡片关联归位（scratch）', crow.workspace === null && crow.workspace_kind === 'scratch', JSON.stringify(crow));
    // 种子 worktree 清理 —— 故意带 `content-type: application/json` 且无 body（旧 fastify 直接 400 FST_ERR_CTP_EMPTY_JSON，
    // 2026-10-03 已在 buildApp 加容错 parser；此处作为该修复的回归探针）
    const rSeedDel = await fetch('http://127.0.0.1:' + PORT + '/api/worktrees/wb-walk-1?force=1', { method: 'DELETE', headers: H });
    const seedTxt = await rSeedDel.text();
    rec('W8 空体 DELETE（带 json content-type）不再 400（dashboard 容错 parser）', rSeedDel.status === 200, 'HTTP ' + rSeedDel.status + ' ' + seedTxt.slice(0, 100));

    /* ══ P2 · W9~W13：准终端（dashboard-reg-term.js + termDrawer）══ */
    // W9：顶栏 ⌨ 打开抽屉 + cwd 下拉加载
    await ev(`(function(){var b=document.getElementById('termBtn');if(b)b.click();return 1})()`);
    await sleep(900);
    const termOpen = await ev(`!!document.querySelector('#termDrawer.show')`);
    rec('W9 顶栏 ⌨ 打开准终端抽屉', termOpen === true);
    const cwdOpts = await ev(`(function(){var s=document.querySelector('#termDrawer .term-pane[data-pane="1"] .term-cwd');return s?s.options.length:0})()`);
    rec('W9b cwd 下拉加载（主工作区 + worktree）', Number(cwdOpts) >= 1, 'options=' + cwdOpts);

    // W10：真执行 git --version（EventSource 流式 → 输出区出 [exit 0]）
    await ev(`(function(){var i=document.querySelector('#termDrawer .term-pane[data-pane="1"] .term-input');if(!i)return 0;i.value='git --version';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 1})()`);
    let termOut = '';
    for (let i = 0; i < 24; i++) {
        await sleep(500);
        termOut = await ev(`(function(){var o=document.querySelector('#termDrawer .term-pane[data-pane="1"] .term-out');return o?o.textContent:''})()`);
        if (termOut.includes('[exit')) break;
    }
    rec('W10 终端执行 git --version：SSE 流式输出 + [exit 0]', termOut.includes('$ git --version') && termOut.includes('git version') && termOut.includes('[exit 0'), termOut.replace(/\s+/g, ' ').slice(0, 160));

    // W11/W12：后端安全口径（直测 API，断言错误体）
    const rDeny = await fetch('http://127.0.0.1:' + PORT + '/api/exec/stream?argv=' + encodeURIComponent(JSON.stringify(['powershell', '-Command', 'x'])), { headers: H });
    const denyTxt = await rDeny.text();
    rec('W11 非白名单命令 → 400（execAllowlist）', rDeny.status === 400 && denyTxt.includes('允许清单'), 'HTTP ' + rDeny.status);
    const rEsc = await fetch('http://127.0.0.1:' + PORT + '/api/exec/stream?argv=' + encodeURIComponent(JSON.stringify(['git', 'status'])) + '&cwd=' + encodeURIComponent('../../..'), { headers: H });
    rec('W12 cwd 越界 → 400（resolveInside）', rEsc.status === 400, 'HTTP ' + rEsc.status);

    // W13：分屏切换 → Pane 2 显隐；随后关抽屉（停流）
    await ev(`(function(){var b=document.getElementById('termSplitBtn');if(b)b.click();return 1})()`);
    await sleep(500);
    const pane2 = await ev(`(function(){var p=document.querySelector('#termDrawer .term-pane[data-pane="2"]');return p?!p.hidden:false})()`);
    rec('W13 分屏切换显示 Pane 2', pane2 === true, 'pane2hidden=' + pane2);
    await ev(`(function(){var b=document.getElementById('termClose');if(b)b.click();return 1})()`);
    await sleep(400);
    const termClosed = await ev(`!document.querySelector('#termDrawer.show')`);
    rec('W13b 关闭抽屉', termClosed === true);

    /* ══ P2 · W14~W17：GitHub 区块（dashboard-reg-github.js + wbGh）══ */
    // W14：详情弹窗仍在工作区 Tab → GitHub 区块已随 renderWorkspace 追加
    const ghBox = await ev(`(function(){var g=document.getElementById('wbGh');return g?'ok':'no'})()`);
    rec('W14 工作区 Tab 渲染 GitHub 区块', ghBox === 'ok', String(ghBox));
    const ghFields = await ev(`(function(){return !!(document.getElementById('wbGhRepo')&&document.getElementById('wbGhSave'))})()`);
    rec('W14b 配置字段（owner/repo + 保存）存在', ghFields === true);

    // W15：保存 owner/repo → 徽标回显（写入隔离 temp config；轮询等网络型 rerender）
    await ev(`(function(){var i=document.getElementById('wbGhRepo');if(!i)return 0;i.value='stablyai/orca';document.getElementById('wbGhSave').click();return 1})()`);
    let ghTxt = '';
    for (let i = 0; i < 30; i++) {
        await sleep(500);
        ghTxt = await ev(`(function(){var g=document.getElementById('wbGh');return g?g.textContent:''})()`);
        if (ghTxt.includes('stablyai/orca')) break;
    }
    rec('W15 保存 repo 后状态徽标回显', ghTxt.includes('stablyai/orca') && ghTxt.includes('token'), ghTxt.replace(/\s+/g, ' ').slice(0, 160));

    // W16：issue 关联本卡 → ref + 状态徽标
    await ev(`(function(){var i=document.getElementById('wbGhLinkUrl');if(!i)return 'no-input';i.value='https://github.com/stablyai/orca/issues/1';document.getElementById('wbGhLink').click();return 'ok'})()`);
    let linkedTxt = '';
    for (let i = 0; i < 24; i++) {
        await sleep(500);
        linkedTxt = await ev(`(function(){var g=document.getElementById('wbGh');return g?g.textContent:''})()`);
        if (linkedTxt.includes('stablyai/orca#1')) break;
    }
    rec('W16 关联 issue 后回显 ref + 状态徽标', linkedTxt.includes('stablyai/orca#1') && linkedTxt.includes('本卡关联'), linkedTxt.replace(/\s+/g, ' ').slice(0, 160));
    const ghMeta = JSON.parse((db.prepare(`SELECT meta FROM cards WHERE id=?`).get(cardId).meta) || '{}');
    rec('W16b meta.github 落库', ghMeta.github?.number === 1 && ghMeta.github?.kind === 'issue', JSON.stringify(ghMeta.github || null));

    // W17：建 PR 写侧降级（本仓无 origin → 409 no-remote hint）
    await ev(`(function(){var h=document.getElementById('wbGhPrHead');if(!h)return 'no-head';h.value='main';document.getElementById('wbGhPrBtn').click();return 'ok'})()`);
    let prHint = '';
    for (let i = 0; i < 16; i++) {
        await sleep(500);
        prHint = await ev(`(function(){var el=document.getElementById('wbGhPrHint');return el?el.textContent:''})()`);
        if (prHint) break;
    }
    rec('W17 建 PR 无远端 → 409 降级引导（no-remote hint）', prHint.includes('远端') || prHint.includes('remote add origin'), prHint.replace(/\s+/g, ' ').slice(0, 180));

    // P2 隔离收尾：解除关联 + 清 repo/token（temp config 目录随 WS 一并删除）
    await api('POST', '/api/github/card', { cardId, url: '' });
    await api('POST', '/api/github/config', { repo: '', clearToken: true });

    rec('CDP 0 未捕获异常', cdpErrs.length === 0, cdpErrs.join(' | ').slice(0, 200));
}
catch (e) {
    rec('走查执行', false, String(e.message).slice(0, 200) + ' @ ' + String(e.stack || '').split('\n')[1]);
}
finally {
    try { ws?.close(); } catch { /* ignore */ }
    try { chrome?.kill(); } catch { /* ignore */ }
    try { await app?.close(); } catch { /* ignore */ }
    try { db?.close(); } catch { /* ignore */ }
    // 清理临时 worktree/分支（git 直清，确定性兜底；rmdir 非递归：只删空目录，绝不误删他人 worktree）
    try { const { execFileSync } = await import('node:child_process'); execFileSync('git', ['worktree', 'remove', '--force', path.join(REPO, '.worktrees', 'wb-walk-1')], { cwd: REPO, stdio: 'pipe' }); } catch { /* 无则跳过 */ }
    try { const { execFileSync } = await import('node:child_process'); execFileSync('git', ['worktree', 'remove', '--force', path.join(REPO, '.worktrees', 'wb-walk-2')], { cwd: REPO, stdio: 'pipe' }); } catch { /* 无则跳过 */ }
    try { const { execFileSync } = await import('node:child_process'); execFileSync('git', ['branch', '-D', 'wt/wb-walk-1'], { cwd: REPO, stdio: 'pipe' }); } catch { /* 无则跳过 */ }
    try { const { execFileSync } = await import('node:child_process'); execFileSync('git', ['branch', '-D', 'wt/wb-walk-2'], { cwd: REPO, stdio: 'pipe' }); } catch { /* 无则跳过 */ }
    try { fs.rmdirSync(path.join(REPO, '.worktrees')); } catch { /* 非空或不存在则保留 */ }
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    await sleep(300);
}

const bad = R.filter((r) => !r.ok).length;
console.log(bad ? `\n${bad}/${R.length} 项未通过` : `\n全部通过（${R.length} 项）`);
process.exit(bad ? 1 : 0);
