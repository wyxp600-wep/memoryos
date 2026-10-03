/**
 * a11y-ui-walk.mjs — 看板可访问性（a11y）DOM 级体检 + 基线（真实 Chrome headless，CDP，零新增依赖）
 *
 * 为什么存在（P2-⑤，2026-09-22）：看板前端（index.html 5300 行 + app.js 6300 行）从未建立 a11y 基线，
 *   且**没有任何 a11y 门禁** → 缺口长期存活。实证：静态 grep 会漏判 —— 首页统计卡是
 *   `<div class="stat-card" data-route>` 用 JS `.onclick =` 赋事件（app.js:304-305），纯正则统计不到。
 *   故本脚本以**真实 DOM + 可访问性树**为准，作为 ⑤ 的基线与回归门禁。
 *
 * 检查项（每条含计数与样例，便于定位）：
 *   P0-1 可点但键盘不可聚焦（有 onclick / 带 data-route 且 cursor:pointer，却无原生可聚焦或 tabindex）
 *   P0-2 可聚焦但无可访问名（CDP Accessibility.getFullAXTree，排除 generic / 静态文本）
 *   P1-1 缺 landmark（main / nav）与标题层级（h1-h6）
 *   P1-2 缺 aria-live 动态播报区
 *   P1-3 表单控件无标签（无 label[for] / aria-label / aria-labelledby / title / 外层 label）
 *   P1-4 导航当前项无 aria-current
 *   P2-1 折叠/切换触发件无 aria-expanded（命中即记，可能为 0，属提示项）
 *   P2-2 prefers-reduced-motion 未生效（模拟 reduce 后仍有非零 transition/animation）
 *
 * 用法：node outputs/a11y-ui-walk.mjs         （需 Chrome + dashboard 在跑）
 *       MEMORY_PORT=8792 node outputs/a11y-ui-walk.mjs
 * 产物：outputs/a11y-baseline-<YYYYMMDD>.json（每个路由一条）
 * 退出码：0 全部通过；1 有 P0/P1 命中或执行失败。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KERNEL = path.resolve(HERE, '..');
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9370 + (Date.now() % 50);
const DASH_PORT = Number(process.env.MEMORY_PORT || 8787);
const DIR = path.join(os.tmpdir(), `.chrome-a11ywalk-${Date.now()}`);

/** 令牌解析顺序同 agent-ui-walk：env → %APPDATA% 壳层真源 → 仓库内自举（两份令牌互不相同，别读错） */
function readToken() {
    if (process.env.MEMORY_TOKEN) return process.env.MEMORY_TOKEN.trim();
    const cands = [
        path.join(process.env.APPDATA || '', 'MemoryOS', 'data', 'token'),
        path.join(KERNEL, 'data', 'token'),
    ];
    for (const f of cands) {
        try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch { /* 试下一个 */ }
    }
    throw new Error('未找到访问令牌：设 MEMORY_TOKEN，或确保 ' + cands[0] + ' 存在');
}

let TOKEN = '';
try { TOKEN = readToken(); }
catch (e) { console.error('✗ ' + e.message); process.exit(1); }
if (!fs.existsSync(CHROME)) { console.error('✗ 未找到 Chrome：' + CHROME + '（可用 CHROME_BIN 指定）'); process.exit(1); }
const URL = 'http://127.0.0.1:' + DASH_PORT + '/?token=' + TOKEN;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面内审计表达式：一次 evaluate 拿回该页的完整 a11y 统计（内部不使用模板字面量，避免转义歧义） */
const AUDIT_EXPR = `(function(){
  var out = { clickableNotFocusable: [], unlabeledControls: [], navActiveNoCurrent: 0, navActiveTotal: 0, collapsibleNoExpanded: 0 };
  var FOCUSABLE = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  var isFocusable = function(el){
    try { return el.matches(FOCUSABLE) && !el.disabled && el.tabIndex >= 0; } catch (e) { return false; }
  };
  var vis = function(el){
    // 必须考虑祖先隐藏：只看自身 computed display 会把「display:none 的父页」里的子元素全算进来
    try { if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }); } catch (e) { /* 回退 */ }
    return el.getClientRects().length > 0;
  };
  // P0-1 可点但键盘不可聚焦
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (!vis(el)) continue;
    if (el.disabled === true) continue; // 被禁用的控件本就不该可聚焦（否则会把 disabled 分页按钮误报为缺口）
    var cs2 = getComputedStyle(el);
    var hasHandler = (typeof el.onclick === 'function') || el.hasAttribute('onclick');
    var looksClickable = hasHandler || (el.hasAttribute('data-route') && cs2.cursor === 'pointer');
    if (!looksClickable || isFocusable(el)) continue;
    var cls = (el.getAttribute && el.getAttribute('class')) || '';
    // 分类：数据行/列表项（整行点击，不该无脑进 Tab 序列）vs 主操作件（导航/标签/入口，必修）
    // 注：th[data-sort] 是可排序表头（操作件），不算数据行。
    var isDataRow = (/^(tr|td)$/i.test(el.tagName)
      || (/^th$/i.test(el.tagName) && !el.hasAttribute('data-sort'))
      || /(^|\s)(row-|rank-item|word-cloud-item|session-chip|notes-vchip|run-card)/.test(cls));
    out.clickableNotFocusable.push({
      kind: isDataRow ? 'dataRow' : 'primary',
      tag: el.tagName.toLowerCase(),
      cls: String(cls).slice(0, 70),
      route: el.getAttribute('data-route') || '',
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
    });
  }
  // P1-3 表单控件无标签
  var ctrls = document.querySelectorAll('input,select,textarea');
  for (var j = 0; j < ctrls.length; j++) {
    var c = ctrls[j];
    if (c.type === 'hidden' || !vis(c)) continue;
    if (c.getAttribute('aria-label') || c.getAttribute('aria-labelledby') || c.getAttribute('title')) continue;
    if (c.id) { try { if (document.querySelector('label[for="' + CSS.escape(c.id) + '"]')) continue; } catch (e) { } }
    if (c.closest('label')) continue;
    out.unlabeledControls.push({ tag: c.tagName.toLowerCase(), type: c.type || '', id: c.id || '', ph: c.getAttribute('placeholder') || '' });
  }
  // P1-4 导航当前项 aria-current
  var navs = document.querySelectorAll('.nav-item');
  for (var k = 0; k < navs.length; k++) {
    var n = navs[k];
    if (!n.classList.contains('active')) continue;
    out.navActiveTotal++;
    if (!n.getAttribute('aria-current')) out.navActiveNoCurrent++;
  }
  // P2-1 折叠开关（disclosure）：侧栏折叠由 Logo 承担，须可聚焦且有 aria-expanded。
  //   原实现按 class*=toggle 判定，会把 .theme-toggle 主题按钮误报为折叠件（已修正为定点检查）。
  var disc = document.querySelector('.sidebar-logo');
  out.disclosure = disc ? {
    present: vis(disc) ? 1 : 0,
    focusable: disc.matches('a[href],button,[tabindex]:not([tabindex="-1"])') ? 1 : 0,
    hasExpanded: disc.hasAttribute('aria-expanded') ? 1 : 0,
  } : { present: 0, focusable: 0, hasExpanded: 0 };
  // P0-1c 数据行键盘等价路径：可点行必须含行内主操作 .row-open（行本身不进 Tab 序列，故不能只看"行可聚焦"）
  var trs = document.querySelectorAll('#allTableBody tr[data-id], #ruleTableBody tr[data-id]');
  var withPrimary = 0;
  for (var r = 0; r < trs.length; r++) if (trs[r].querySelector('.row-open')) withPrimary++;
  out.rows = { total: trs.length, withPrimary: withPrimary };
  // P1-1 landmark / 标题层级
  out.landmarks = {
    main: document.querySelectorAll('main,[role="main"]').length,
    nav: document.querySelectorAll('nav,[role="navigation"]').length,
  };
  var hs = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
  out.headings = { total: hs.length, h1: document.querySelectorAll('h1').length };
  // P1-2 动态播报区
  out.ariaLive = document.querySelectorAll('[aria-live]:not([aria-live="off"]),[role="status"],[role="alert"],[role="log"]').length;
  // 当前可见页
  var act = document.querySelector('.page.active');
  out.visiblePage = act ? (act.id || String(act.className)) : '(none)';
  return JSON.stringify(out);
})()`;

const R = [];
const rec = (name, ok, extra = '') => { R.push({ name, ok, extra }); console.log((ok ? '✓ ' : '✗ ') + name + (extra ? ' — ' + extra : '')); };

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--window-size=1440,900', // 桌面视口：窄视口下侧栏是抽屉、会隐藏，导致侧栏类断言假阴性
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + DIR, 'about:blank'], { stdio: 'ignore' });

let ws;
const cdpErrs = [];
const perRoute = [];
try {
    let ver = null;
    for (let i = 0; i < 40; i++) {
        try { ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); break; }
        catch { await sleep(500); }
    }
    if (!ver) throw new Error('Chrome CDP 未就绪');
    console.log('Chrome: ' + ver['Browser']);

    let page = null;
    for (let i = 0; i < 20; i++) {
        const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
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
    const axNoName = async () => {
        const r = await send('Accessibility.getFullAXTree');
        const nodes = r.result?.nodes || [];
        const SKIP = new Set(['generic', 'none', 'StaticText', 'InlineTextBox', 'RootWebArea', 'LineBreak', 'paragraph', 'ListMarker']);
        return nodes
            .filter((n) => !n.ignored && n.role?.value && !SKIP.has(n.role.value))
            .filter((n) => {
                const props = Object.fromEntries((n.properties || []).map((p) => [p.name, p.value?.value]));
                return props.focusable === true && !String(n.name?.value || '').trim();
            })
            .map((n) => ({ role: n.role?.value, tag: n.name?.type || '' }));
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Accessibility.enable');
    await send('Page.navigate', { url: URL });
    await sleep(6000);

    // 收集全部导航路由
    const routes = await ev(`JSON.stringify(Array.from(document.querySelectorAll('.nav-item[data-route]')).map(function(n){return n.getAttribute('data-route')}))`);
    const routeList = JSON.parse(routes || '[]');
    console.log('导航路由 ' + routeList.length + ' 个：' + routeList.join(', ') + '\n');

    const routesToAudit = ['(initial)'].concat(routeList);
    for (const rt of routesToAudit) {
        if (rt !== '(initial)') {
            const clicked = await ev(`(function(){var n=document.querySelector('.nav-item[data-route=' + ${JSON.stringify(JSON.stringify(rt))} + ']');if(!n)return 'missing';n.click();return 'ok'})()`);
            if (clicked !== 'ok') { perRoute.push({ route: rt, error: 'nav 未找到' }); continue; }
            await sleep(2000);
        }
        const raw = await ev(AUDIT_EXPR);
        if (typeof raw !== 'string' || raw.startsWith('[ERR]')) { perRoute.push({ route: rt, error: String(raw).slice(0, 160) }); continue; }
        let a;
        try { a = JSON.parse(raw); } catch (e) { perRoute.push({ route: rt, error: 'JSON 解析失败' }); continue; }
        a.route = rt;
        a.focusableNoName = await axNoName();
        perRoute.push(a);
    }

    // —— 真实键盘交互（属性达标 ≠ 能用）：聚焦导航项 → CDP 派发 Enter → 必须真的切页 ——
    const KEY = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    // Enter 必须三连发（rawKeyDown → char → keyUp）：只发 rawKeyDown/keyUp 时 Chrome 不触发
    // 原生控件的默认激活（实测：原生 <button> 收不到 click，而自定义 keydown 处理器的元素能过 —— 会误判）
    const pressEnter = async () => {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...KEY });
        await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', unmodifiedText: '\r' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEY });
    };
    await ev(`(function(){var n=document.querySelector('.nav-item[data-route="tasks"]');if(n)n.focus();return document.activeElement && document.activeElement.getAttribute('data-route')})()`);
    const focused = await ev(`document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-route') : null`);
    await pressEnter();
    await sleep(1200);
    const tasksActive = await ev(`!!document.querySelector('#page-tasks.active')`);
    rec('键盘可达：Tab 聚焦导航项 + Enter 真实切页', focused === 'tasks' && tasksActive === true, 'focused=' + focused + ' page-tasks.active=' + tasksActive);

    // —— 真实键盘交互：数据行的行内主操作 → Enter 打开详情（行本身不进 Tab，故必须验这个按钮） ——
    // ★ 切页自适应（2026-10-04）：旧结构路由为独立导航项「all」；Slice-C2 页面合并后「all」降为
    //   记忆中心（memory）子视图、导航项不存在 → 先点旧导航项、缺失则回退 memory 导航 / hash 兜底，
    //   两种结构都能到达 #allTableBody 所在页（断言本体不变，只修「到达页面」这一步）。
    await ev(`(function(){
      var n=document.querySelector('.nav-item[data-route="all"]')||document.querySelector('.nav-item[data-route="memory"]');
      if(n){n.click();return 'nav:'+n.getAttribute('data-route')}
      location.hash='#memory';return 'hash:memory'
    })()`);
    await sleep(2200);
    const rowFocus = await ev(`(function(){var b=document.querySelector('#allTableBody tr[data-id] .row-open');if(!b)return 'missing';b.focus();return String(document.activeElement.className||'')})()`);
    await pressEnter();
    await sleep(1200);
    const modalOpen = await ev(`!!document.querySelector('#detailModal.show')`);
    rec('数据行键盘等价路径：聚焦行内主操作 + Enter 打开详情', /row-open/.test(String(rowFocus)) && modalOpen === true, 'focused=' + rowFocus + ' detailModal.show=' + modalOpen);
    const ESC = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...ESC });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...ESC });
    await sleep(400);

    // —— 诊断：交互件机器标记覆盖（定位"标记没生效"类问题）——
    const markCovRaw = await ev(`(function(){
      var sel = '.nav-item[data-route], .agent-sidebar-quick-item, .agent-session-item, .stat-card[data-route], #tabMap, th[data-sort], .more-panel-tab, .context-menu-item, .word-cloud-item, .rank-item, .notes-vchip, .session-chip, [data-a11y-click]';
      var els = document.querySelectorAll(sel), noT = 0, noRole = 0, notMarked = 0, sample = '';
      for (var i = 0; i < els.length; i++) {
        var e = els[i];
        if (e.tabIndex < 0) { noT++; if (!sample) sample = e.tagName + '.' + String(e.getAttribute('class') || '').slice(0, 40); }
        if (e.tagName !== 'TH' && !e.getAttribute('role')) noRole++;
        if (e.dataset.a11yKey !== '1') notMarked++;
      }
      return JSON.stringify({ total: els.length, noTabindex: noT, noRole: noRole, notMarked: notMarked, sample: sample });
    })()`);
    console.log('🔍 交互件标记覆盖：' + markCovRaw);
    const navProbe = await ev(`(function(){
      var F = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
      var n = document.querySelector('.nav-item');
      if (!n) return 'no nav-item';
      var m = null;
      try { m = n.matches(F); } catch (e) { m = 'THROW:' + e.message; }
      return JSON.stringify({ tabIndex: n.tabIndex, tabindexAttr: n.getAttribute('tabindex'), matches: m, disabled: String(n.disabled), onclick: typeof n.onclick, role: n.getAttribute('role'), a11yKey: n.dataset.a11yKey, cls: n.getAttribute('class') });
    })()`);
    console.log('🔍 nav-item 探针：' + navProbe);

    // —— 汇总（按描述符去重，避免同一元素在多页重复计数）——
    const uniq = (arr, keyOf) => {
        const m = new Map();
        for (const o of arr) { const k = keyOf(o); if (!m.has(k)) m.set(k, o); }
        return [...m.values()];
    };
    const badClickable = uniq(perRoute.flatMap((p) => p.clickableNotFocusable || []),
        (o) => o.tag + '|' + o.cls + '|' + o.route + '|' + o.text);
    const badPrimary = badClickable.filter((o) => o.kind !== 'dataRow');
    const badRows = badClickable.filter((o) => o.kind === 'dataRow');
    const badNoName = uniq(perRoute.flatMap((p) => p.focusableNoName || []), (o) => o.role + '|' + o.tag);
    const badLabel = uniq(perRoute.flatMap((p) => p.unlabeledControls || []), (o) => o.tag + '|' + o.type + '|' + o.id);
    const navNoCurrent = Math.max(0, ...perRoute.map((p) => p.navActiveNoCurrent || 0));
    const navTotal = Math.max(0, ...perRoute.map((p) => p.navActiveTotal || 0));
    const disc = perRoute.find((p) => p.disclosure && p.disclosure.present)?.disclosure || { present: 0, focusable: 0, hasExpanded: 0 };
    const landmarks = perRoute.find((p) => p.landmarks && p.landmarks.main > 0)?.landmarks
        || perRoute.find((p) => p.landmarks)?.landmarks || { main: 0, nav: 0 };
    const headings = perRoute.find((p) => p.headings)?.headings || { total: 0, h1: 0 };
    const live = Math.max(0, ...perRoute.map((p) => p.ariaLive || 0));
    const rowsAgg = perRoute.reduce((a, p) => ((p.rows && p.rows.total > (a.total || 0)) ? p.rows : a), { total: 0, withPrimary: 0 });

    // P2-2 prefers-reduced-motion：模拟 reduce 后仍存在非零 transition/animation
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(300);
    const motionRaw = await ev(`(function(){
      var els = document.querySelectorAll('*'), n = 0, sample = '';
      for (var i = 0; i < els.length; i++) {
        var cs = getComputedStyle(els[i]);
        if (cs.display === 'none') continue;
        var dur = parseFloat(cs.transitionDuration) || 0, adur = parseFloat(cs.animationDuration) || 0;
        // 阈值 50ms：reduced-motion 的标准做法是把时长压到 0.01ms（"等于没有"），
        // 若用「> 0」判定会把这类"已禁用"元素也算成仍有动效（实测曾把计数从 2348 反推成 12056）。
        // 注意：本行位于模板字面量内，注释里不能出现反引号，否则会提前截断字符串。
        if (dur > 0.05 || adur > 0.05) { n++; if (!sample) sample = els[i].tagName.toLowerCase() + '.' + String(els[i].className||'').slice(0,40) + ' t=' + cs.transitionDuration + ' a=' + cs.animationDuration; }
      }
      return JSON.stringify({ n: n, sample: sample });
    })()`);
    let motion = { n: 0, sample: '' };
    try { motion = JSON.parse(motionRaw || '{}'); } catch (e) { /* ignore */ }
    await send('Emulation.setEmulatedMedia', { features: [] });

    console.log('\n=== 汇总（' + perRoute.length + ' 个路由） ===');
    rec('P0-1 主操作件键盘可达（可点但不可聚焦）= 0', badPrimary.length === 0, badPrimary.length + ' 个；例：' + JSON.stringify(badPrimary.slice(0, 4)));
    console.log('ℹ P0-1b 数据行/列表项整行点击（信息项，不入门禁）：' + badRows.length + ' 个；例：' + JSON.stringify(badRows.slice(0, 3)));
    rec('P0-2 可聚焦但无可访问名 = 0', badNoName.length === 0, badNoName.length + ' 个；例：' + JSON.stringify(badNoName.slice(0, 4)));
    rec('P0-1c 数据行含行内主操作（键盘等价路径）', rowsAgg.total > 0 && rowsAgg.withPrimary === rowsAgg.total, `rows=${rowsAgg.total} withPrimary=${rowsAgg.withPrimary}`);
    rec('P1-1 有 landmark（main+nav）', landmarks.main > 0 && landmarks.nav > 0, `main=${landmarks.main} nav=${landmarks.nav}`);
    rec('P1-1 有标题层级（≥1 个 h1）', headings.h1 > 0, `heading 总数=${headings.total} h1=${headings.h1}`);
    rec('P1-2 有 aria-live 播报区', live > 0, 'aria-live/status/alert/log=' + live);
    rec('P1-3 表单控件均有标签', badLabel.length === 0, badLabel.length + ' 个；例：' + JSON.stringify(badLabel.slice(0, 4)));
    rec('P1-4 导航当前项有 aria-current', navNoCurrent === 0 && navTotal > 0, `active=${navTotal} 缺 aria-current=${navNoCurrent}`);
    // P2-1 作信息项：当前 UI 已无侧栏折叠组件（.sidebar-logo / .sidebar / #sidebarToggle 均不在 markup，
//   initSidebarCollapse() 在 `if (!sidebar || !main || !logo) return;` 处早退），故不设门禁、只如实报告。
    console.log('ℹ P2-1 折叠开关：' + (disc.present === 0
        ? 'N/A —— 当前 UI 无折叠组件（.sidebar-logo 不存在；侧栏折叠/窄屏抽屉代码为死代码）'
        : JSON.stringify(disc) + (disc.focusable === 1 && disc.hasExpanded === 1 ? ' ✓' : ' ✗ 缺键盘可达或 aria-expanded')));
    rec('P2-2 prefers-reduced-motion 生效', motion.n === 0, '模拟 reduce 后仍有动效元素=' + motion.n + ' 例：' + motion.sample);
    rec('CDP 0 未捕获异常', cdpErrs.length === 0, cdpErrs.join(' | ').slice(0, 200));
}
catch (e) {
    rec('体检执行', false, String(e.message).slice(0, 200) + ' @ ' + String(e.stack || '').split('\n')[1]);
}
finally {
    try { ws?.close(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    await sleep(300);
    fs.rmSync(DIR, { recursive: true, force: true });
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const outFile = path.join(HERE, 'a11y-baseline-' + stamp + '.json');
try {
    fs.writeFileSync(outFile, JSON.stringify({
        meta: { at: new Date().toISOString(), dashPort: DASH_PORT, node: process.version, chrome: process.env.CHROME_BIN || 'default' },
        checks: R.map((r) => ({ name: r.name, ok: r.ok, extra: r.extra })),
        perRoute,
    }, null, 2) + '\n', 'utf8');
    console.log('\n基线已写入：' + path.relative(KERNEL, outFile));
} catch (e) {
    console.error('基线写入失败：' + e.message);
}

const bad = R.filter((r) => !r.ok).length;
console.log(bad ? `\n${bad}/${R.length} 项未通过` : `\n全部通过（${R.length} 项）`);
process.exit(bad ? 1 : 0);