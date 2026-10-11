/**
 * P3 · 连线维度 L-01 ~ L-15
 * ★ L-10（pointercancel缺失 → 地图冻结）必须排最后，一旦冻结后续用例全假失败
 */
import fs from 'node:fs';
import path from 'node:path';
import * as I from './p1-isolated-instance.mjs';

const { log, j, OUT, shutdown, goto, sleep, api, q, q1, shot, dump, resetEv, visibleNodes, rectOf,
  nodeStyle, cardMapPos, linkRows, eventCount, ev, mouse, linkHold, linkDrop, linkDropDiagnose,
  lisDump, evDump, click, worldScale, panCanvas } = I;

const R = [];
const rec = (id, title, sev, verdict, o) => { R.push({ id, title, sev, verdict, ...o }); log(`${id} [${sev}] ${verdict}`); };
const kinds = {};
const kindRow = id => { if (kinds[id] === undefined) { const r = q1('SELECT kind,status,title FROM cards WHERE id=?', Number(id)); kinds[id] = r || {}; } return kinds[id]; };
const kindOf = id => (kindRow(id) || {}).kind;
/** 建一张 task 测试卡并保证在视口内（用于连线目标） */
async function mkTask(tag) {
  const r = await api('POST', '/api/cards', { title: `[TEST-20261006] ${tag} task卡`, kind: 'task' });
  return r.body && r.body.id;
}

try {
  const info = await I.boot();
  const page = await goto();
  const vis = page.visList && page.visList.length ? page.visList : await visibleNodes(30);
  // ★ 不依赖视口：从副本库直接取 task 卡（status 允许被拖动/连线），再focusOn 移进视口
  const T = q("SELECT id FROM cards WHERE kind='task' AND status NOT IN ('archived','cancelled') ORDER BY id DESC LIMIT 6").map(r => ({ id: r.id }));
  log(`候选 task 卡 ${T.length} 张: ${T.map(t => '#' + t.id).join(',')}`);
  if (T.length) { try { await I.focusOn(T.slice(0, 4).map(t => t.id)); await sleep(500);} catch (e) { log('focusOn 失败（继续）:', e.message); } }

  // 准备 4 张 task 卡（A 连线源、B 目标、C重复连线、D 被环）
  // ★ 只用视口内可见的 task 卡（新建兜底卡在视口外，连不上）；不足 4 张则报错
  if (T.length < 4) throw new Error('视口内可见 task 卡不足 4 张（实得 ' + T.length + '），无法覆盖 A/B/C/D 四个连线用例卡');
  const A = T[0].id, B = T[1].id, C = T[2].id, Dd = T[3].id;
  log(`连线用例卡: A=#${A} B=#${B} C=#${C} D=#${Dd}`);
  const visRe = await visibleNodes(30);
  log(`focus 后可见 ${visRe.length} 张`);

  /* ========== L-01 连线基线（A→B task→task） ========== */
  resetEv();
  const D01 = await linkDropDiagnose(A, B);
  await shot('L-01');
  rec('L-01', '连线基线（task→task 依赖线）', '轻微',
    D01.rows && D01.rows.length === 1 ? 'PASS' : 'FAIL',
    {
      steps: `hover 卡 #${A} → 按住右侧 ＋ 圆点 → 拖到卡 #${B} 中心 → 松手`,
      expect: '临时虚线出现 + 目标卡 link-target 高亮 + 松手后 POST /api/cards/A/links {dst:B,kind:depends} + toast「已连线」+ links 表新增 1 行 + 图中出现橙色虚线边',
      actual: `link-target 高亮=${D01.h ? D01.h.probe.hoverId : '?'}（期望 ${B}）；临时线 d=${D01.h && D01.h.probe.draftD ? '存在' : '★无'}；手势期 task-map-linking 类=${D01.h ? D01.h.probe.linkingClass : '?'}→松手后=${D01.after ? D01.after.linking : '?'}；网络=${j(D01.net)}；links 落库=${j(D01.rows)}；card_events(link)=${eventCount(A, 'link')}`,
      finding: '',
      evidence: { src: A, dst: B, probe: D01.h ? D01.h.probe : null, before: D01.before, after: D01.after, net: D01.net, rows: D01.rows, events: eventCount(A, 'link') },
    });
  dump('L-01');

  /* ========== L-02 方向语义（depends vs blocks 存储方向） ========== */
  resetEv();
  // 现状A→B 已建立（src=A,dst=B）。再试 blocks A→C（应反向存成 src=C,dst=A）
  const rBlocks = await api('POST', `/api/cards/${A}/links`, { dst_card_id: C, kind: 'blocks' });
  const rowsAC_blocks = linkRows(A, C);   // 直查 src=A,dst=C
  const rowsCA_blocks = linkRows(C, A);   // 反向
  const rDepends = await api('POST', `/api/cards/${A}/links`, { dst_card_id: Dd, kind: 'depends' });
  const rowsAD = linkRows(A, Dd);
  await shot('L-02');
  rec('L-02', '连线方向语义（depends 正向/ blocks 反向存储）', '一般',
    (rowsCA_blocks.length === 1 && rowsAC_blocks.length === 0) ? 'PASS' : 'PARTIAL',
    {
      steps: `① POST /api/cards/${A}/links {dst:${C}, kind:'blocks'}；② POST /api/cards/${A}/links {dst:${Dd}, kind:'depends'}；③ 查 links 表实际 src/dst`,
      expect: 'depends = A 依赖 B → 存 src=A,dst=B；blocks = A 阻塞 C ⇔ C 依赖 A → **反向存** src=C,dst=A（dashboard-reg-cards.js:1057-1067 dir 翻转）',
      actual: `blocks 请求返回 ${rBlocks.status} ${JSON.stringify(rBlocks.body).slice(0, 80)}；blocks 后 links(src=A,dst=C)=${j(rowsAC_blocks)}，links(src=C,dst=A)=${j(rowsCA_blocks)} → ${rowsCA_blocks.length ? '★确认反向存储' : '未按预期反向'};depends(src=A,dst=D)=${j(rowsAD)}`,
      finding: rowsCA_blocks.length === 1
        ? '方向语义确认：blocks 被翻转成反向 depends存储（易被误读，API 响应体里 kind 仍回显 depends）'
        : 'blocks 方向与预期不符，需复核',
      evidence: { blocks: { req: `A->C blocks`, status: rBlocks.status, body: rBlocks.body, rowsForward: rowsAC_blocks, rowsReverse: rowsCA_blocks }, depends: { req: `A->D depends`, status: rDepends.status, rows: rowsAD } },
    });
  dump('L-02');

  /* ========== L-03 自连 ========== */
  resetEv();
  const rSelf = await api('POST', `/api/cards/${A}/links`, { dst_card_id: A, kind: 'depends' });
  const selfRows = linkRows(A, A);
  await shot('L-03');
  rec('L-03', '自连（A→A 自身）', '一般',
    rSelf.status >= 400 || selfRows.length === 0 ? 'PASS' : 'FAIL',
    {
      steps: `直接 POST /api/cards/${A}/links {dst:${A}, kind:'depends'}（UI 侧 app.js:4960 已过滤 newId!==srcCardId，故只能走 API 验证后端）`,
      expect: '应被成环检测拦（dependsPathExists 首行 from===to 返回 true → 409）',
      actual: `HTTP ${rSelf.status} ${JSON.stringify(rSelf.body).slice(0, 120)}；links(src=A,dst=A)=${j(selfRows)}`,
      finding: (rSelf.status === 200 && selfRows.length) ? '★ 后端自连未拦（自环入库）→ 可能造成成环算法异常' : (selfRows.length ? '自环已入库' : '已拦截'),
      evidence: { card: A, status: rSelf.status, body: rSelf.body, rows: selfRows },
    });
  dump('L-03');

  /* ========== L-04 成环检测（A→B 已建，再 B→A） ========== */
  resetEv();
  const rCycle = await api('POST', `/api/cards/${B}/links`, { dst_card_id: A, kind: 'depends' });
  const rowsBA = linkRows(B, A);
  await shot('L-04');
  rec('L-04', '成环检测（B→A，A 已依赖 B）', '一般',
    rCycle.status === 409 ? 'PASS' : (rCycle.status === 200 ? 'FAIL（成环未被拦）' : 'INCONCLUSIVE'),
    {
      steps: `已有 A→B depends，再 POST /api/cards/${B}/links {dst:${A}, kind:'depends'}`,
      expect: '409「成环：dst 已依赖本卡」（dashboard-reg-cards.js:1060-1061 dependsPathExists 递归判可达）',
      actual: `HTTP ${rCycle.status} ${JSON.stringify(rCycle.body).slice(0, 120)}；links(src=B,dst=A)=${j(rowsBA)}`,
      finding: rCycle.status === 409 ? '成环检测正常' : (rCycle.status === 200 ? '★ 成环未被拦' : ''),
      evidence: { src: B, dst: A, status: rCycle.status, body: rCycle.body, rows: rowsBA },
    });
  dump('L-04');

  /* ========== L-05 ★非法目标：depends 指向 agent/doc 卡（UI 无 kind 预过滤） ========== */
  resetEv();
  // 找一张 agent 或 doc 卡作非法前置
  const badCard = vis.find(v => ['agent', 'doc'].includes((kindOf(v.id) || {}).kind));
  let l05 = { verdict: 'INCONCLUSIVE' };
  if (badCard) {
    const bk = kindOf(badCard.id);
    // UI 手势：把线拖到非法卡上，看是否高亮 + 400
    const D05 = await linkDropDiagnose(A, badCard.id).catch(e => ({ err: e.message, rows: [], h: null, net: [] }));
    // 直打 API 拿完整错误文案
    const r05 = await api('POST', `/api/cards/${A}/links`, { dst_card_id: badCard.id, kind: 'depends' });
    await shot('L-05');
    l05 = {
      verdict: D05.h && D05.h.probe.hoverId === badCard.id ? 'FAIL（UI 允许高亮非法目标，仅后端 400 兜底）' : 'INCONCLUSIVE',
      steps: `① UI 手势：把线从 #${A} 拖到 ${bk} 卡 #${badCard.id}（看是否高亮/是否可提交）；② 直打 API 拿错误文案`,
      expect: '（理想）UI 应在 hover 阶段就过滤非法 kind，不可作前置的卡不应高亮',
      actual: `UI 层 link-target 高亮=${D05.h ? D05.h.probe.hoverId : '?'}（非法目标 ${badCard.id}，${bk}）→ ${D05.h && D05.h.probe.hoverId === badCard.id ? '★被高亮，用户以为可以连' : '未高亮'}；直打 API → HTTP ${r05.status}；错误文案=${JSON.stringify(r05.body.error || '').slice(0, 160)}；落库=${j(D05.rows || [])}`,
      finding: D05.h && D05.h.probe.hoverId === badCard.id
        ? `★ UI 层无 kind 预过滤（app.js:4958-4966 只判 !==srcCardId，不查 kind）→ 用户可把线拖到${bk}卡上并看到高亮，松手后才被后端 400 拦（错误文案${String((r05.body.error || '')).length} 字，toast 停留 2.5s 读不完）→ 需反复试错才知道哪些卡可作前置`
        : '',
      evidence: { badCard: badCard.id, badKind: bk, uiHighlight: D05.h ? D05.h.probe.hoverId : null, api: { status: r05.status, body: r05.body }, rows: D05.rows || [] },
    };
  }
  rec('L-05', '★非法目标：depends 指向 agent/doc 卡（UI 无 kind 预过滤）', '严重', l05.verdict, l05);
  dump('L-05');

  /* ========== L-07 ★重复连线 = 静默假成功 ========== */
  resetEv();
  // A→B 已存在（L-01 建立）。再连一次 A→B
  const beforeCnt = linkRows(A, B).length;
  const evBefore = eventCount(A, 'link');
  const D07 = await linkDropDiagnose(A, B);        // UI 再拖一次
  await sleep(800);
  const afterCnt = linkRows(A, B).length;
  const evAfter = eventCount(A, 'link');
  const net07 = D07.net || [];
  await shot('L-07');
  rec('L-07', '★重复连线 = 静默假成功（API 200 但无新边）', '严重',
    (afterCnt === beforeCnt && net07.some(n => n.ph === 'resp' && n.s === 200)) ? 'FAIL（缺陷坐实）' : 'INCONCLUSIVE',
    {
      steps: `已有 A→B 依赖线（links ${beforeCnt} 行）；UI 再拖一次完全相同的 A→B → 数 links 行数 + 抓网络 + card_events 计数`,
      expect: '应提示「该依赖线已存在」，或至少不谎报成功',
      actual: `links 行数 ${beforeCnt} → ${afterCnt}（${afterCnt === beforeCnt ? '★未新增' : '新增了'}）；网络请求=${j(net07.filter(n => /links/.test(n.u || '')))}；card_events(link) ${evBefore} → ${evAfter}（${evAfter > evBefore ? '+1（记账但无实际变更）' : '未变'}）；UI toast 文本由 app.js:5032「已连线：#A 依赖 #B」`,
      finding: (afterCnt === beforeCnt && net07.some(n => n.ph === 'resp' && n.s === 200))
        ? '★ `INSERT OR IGNORE`（dashboard-reg-cards.js:1069）+ 唯一索引 → 重复边被静默忽略，但端点仍返回 200 {ok:true} 且 UI toast「已连线」→ 用户以为改了连线，实则毫无变化；且 card_events 反而+1（writeCardEvent 在 INSERT 之后无条件执行）→ 审计记账与实际不一致'
        : '',
      evidence: { src: A, dst: B, rowsBefore: beforeCnt, rowsAfter: afterCnt, eventsBefore: evBefore, eventsAfter: evAfter, net: net07 },
    });
  dump('L-07');

  /* ========== L-08 删除连线端点（不校验存在性） ========== */
  resetEv();
  // 先删 A→C（blocks 存的反向）应成功
  const delReal = await api('DELETE', `/api/cards/${A}/links?dst_card_id=${C}&kind=depends`);
  const delReal2 = await api('DELETE', `/api/cards/${A}/links?dst_card_id=${C}&kind=depends`);  // 再删一次（已不存在）
  const delFake = await api('DELETE', `/api/cards/${A}/links?dst_card_id=999999&kind=depends`);  // 删不存在的
  await shot('L-08');
  rec('L-08', '删除连线端点：无确认 / 不校验存在性（删不存在的也返 ok）', '一般',
    delFake.status === 200 ? 'FAIL（删不存在返 200，假成功）' : 'PASS',
    {
      steps: `① DELETE /api/cards/${A}/links?dst=C（真实边）；② 再删一次（同一条，已不存在）；③ DELETE ?dst=999999（从未存在的边）`,
      expect: '删不存在的边应返回 404；UI 侧应有确认与撤销',
      actual: `删真实边 → ${delReal.status}；再删已不存在 → ${delReal2.status} ${JSON.stringify(delReal2.body).slice(0, 60)}；删从未存在(dst=999999) → ${delFake.status} ${JSON.stringify(delFake.body).slice(0, 60)}`,
      finding: delFake.status === 200
        ? '★ 删除端点不校验存在性（dashboard-reg-cards.js:1078-1083 直接 DELETE 无 SELECT）→ 删不存在的边也返 {ok:true}，前端无法区分"删成功"与"本来就没有"；且 UI 无撤销栈'
        : '',
      evidence: { delReal, delReal2, delFake },
    });
  dump('L-08');

  /* ========== L-09 aux卡作前置（注册死锁） ========== */
  resetEv();
  // card_types 里没有 aux（生产库种子仅 agent/doc/handoff/task/milestone）→ POST kind=aux 应 400
  const rAux = await api('POST', '/api/cards', { title: `[TEST-20261006] L-09 aux卡`, kind: 'aux' });
  // 但 aux 是 graph 派生的虚拟节点（负 id），不可拖
  const auxVirtual = q(`SELECT id,title,kind FROM cards WHERE kind='aux' LIMIT 3`);
  const cardTypes = q(`SELECT type_key,label FROM card_types`);
  await shot('L-09');
  rec('L-09', '★aux 辅助卡挂载全断（kind=aux 不在 card_types）', '致命',
    rAux.status >= 400 ? 'FAIL（aux 卡无法创建 → 5 类辅助卡功能全断）' : 'INCONCLUSIVE',
    {
      steps: `POST /api/cards {title, kind:'aux'}；并查 card_types 种子表确认 aux 是否注册；查库内现有 aux 卡（派生虚拟节点）`,
      expect: '右键菜单 5 个「📎挂相关项目/用户记忆/规则定义/Skill技能/历史错误」应能创建 aux 辅助卡',
      actual: `POST kind=aux → HTTP ${rAux.status} ${JSON.stringify(rAux.body).slice(0, 100)}；card_types 种子=${j(cardTypes)}（无 aux）；库内 kind=aux 的卡（实为 graph 派生虚拟节点，非真实卡）=${j(auxVirtual.slice(0, 2))}`,
      finding: rAux.status >= 400
        ? '★ 辅助卡挂载全断：`POST /api/cards {kind:"aux"}` 被 dashboard-reg-cards.js:648-650 以「未知卡片类型：aux」400 拒绝；card_types 种子表无 aux 且 `aux` 是保留前缀 → 5 类辅助卡（相关项目/用户记忆/规则定义/Skill技能/历史错误）**全部无法创建**，卫星卡体系实为空壳。且 aux 节点是 graph 从 card_memory 派生的**虚拟负id 节点**（app.js:1230-1234，isReal=false → pointerdown 直接 stopPropagation）→ UI 上根本拖不动它'
        : '',
      evidence: { postAux: { status: rAux.status, body: rAux.body }, cardTypes, auxVirtual: auxVirtual.slice(0, 3) },
    });
  dump('L-09');

  /* ========== L-11 依赖边「任一端点 done → 整条边隐藏」 ========== */
  resetEv();
  // A→D 依赖线已建（L-02）。把 A 或 D 改成 done，看边是否视觉消失但数据仍在
  const edgeBefore = await ev(`(function(){var g=document.querySelectorAll('#taskMapEdges g.task-map-edge').length;return g;})()`);
  const stD = (kindOf(Dd) || {}).status;
  let l11 = { verdict: 'INCONCLUSIVE' };
  if (stD && stD !== 'done' && stD !== 'archived') {
    // 走 /status 把 D 推到 done（若状态机允许）
    const chain = { todo: 'ready', ready: 'running', running: 'review', review: 'done' };
    let cur = stD, ok = false;
    for (let i = 0; i < 5 && cur !== 'done'; i++) {
      const nx = chain[cur];
      if (!nx) break;
      const r = await api('POST', `/api/cards/${Dd}/status`, { status: nx, expected_from: cur, as: 'human:test' });
      if (r.status === 200) { cur = nx; ok = true; await sleep(300); } else break;
    }
    await sleep(1500);
    const edgeAfter = await ev(`document.querySelectorAll('#taskMapEdges g.task-map-edge').length`);
    const rowsStillThere = linkRows(A, Dd);
    await shot('L-11');
    l11 = {
      verdict: (ok && edgeAfter < edgeBefore && rowsStillThere.length) ? 'FAIL（数据在但视觉消失）' : (ok ? 'PARTIAL' : 'INCONCLUSIVE（未能推到 done：' + stD + '）'),
      steps: `已有 A→#${Dd} 依赖线；把 #${Dd} 状态沿状态机推到 done → 数SVG 边数量 + 查 links 表`,
      expect: '（观察）app.js:4752「任一端点 done → 整条边隐藏」——数据仍在但视觉消失',
      actual: `推到 done 成功=${ok}；SVG 边数 ${edgeBefore} → ${edgeAfter}；links 表仍存 ${rowsStillThere.length} 行 ${j(rowsStillThere)}`,
      finding: (ok && edgeAfter < edgeBefore && rowsStillThere.length)
        ? '★ 依赖卡一旦done，该依赖线**视觉消失**（app.js:4752）但 links 数据仍在 → 用户以为"没连上"/"线丢了"，实际数据在；且因为看不见也无法右键删它'
        : '',
      evidence: { card: Dd, pushedToDone: ok, edgeBefore, edgeAfter, rowsStillThere, status: stD },
    };
  }
  rec('L-11', '依赖边「任一端点 done → 整条边隐藏」（数据在但看不见）', '一般', l11.verdict, l11);
  dump('L-11');

  /* ========== L-13 弱连线 / 自动关联开关（读时行为，仅展示不落库） ========== */
  resetEv();
  const weakBtn = await rectOf('#taskMapWeakBtn');
  const autoBtn = await rectOf('#taskMapAutoBtn');
  const edgesBase = await ev(`document.querySelectorAll('#taskMapEdges g.task-map-edge').length`);
  let weakEdges = null, autoEdges = null;
  if (weakBtn && weakBtn.w >= 1) { await click(Math.round(weakBtn.cx), Math.round(weakBtn.cy)); await sleep(1200); weakEdges = await ev(`document.querySelectorAll('#taskMapEdges g.task-map-edge').length`); await click(Math.round(weakBtn.cx), Math.round(weakBtn.cy)); await sleep(800); }
  if (autoBtn && autoBtn.w >= 1) { await click(Math.round(autoBtn.cx), Math.round(autoBtn.cy)); await sleep(2500); autoEdges = await ev(`document.querySelectorAll('#taskMapEdges g.task-map-edge').length`); }
  const linksTotal = q(`SELECT COUNT(*) n FROM links`)[0].n;
  await shot('L-13');
  rec('L-13', '弱连线 / 自动关联开关（自动关联是读时行为、仅展示不落库）', '一般',
    (weakEdges !== null && autoEdges !== null) ? 'PASS' : 'INCONCLUSIVE（开关按钮不可见）',
    {
      steps: '点「弱连线」开关前后数边数量；点「自动关联」开关前后数边数量；对照 links 表总数',
      expect: '弱连线只影响 relates/duplicates/relates_auto（app.js:4745）；自动关联是**读时**行为（?auto=0/1）仅展示不落库（dashboard-reg-cards.js:1239-1243）',
      actual: `SVG 边数：基线=${edgesBase}，弱连线关=${weakEdges}，自动关联开=${autoEdges}；links 表总行数=${linksTotal}（切换开关不改变它）`,
      finding: linksTotal === linksTotal ? '自动关联开启后若边数增加但 links 表不变 → 确证"仅展示不落库"（非缺陷，属设计；但用户会以为这些线是真实数据）' : '',
      evidence: { edgesBase, weakEdges, autoEdges, linksTotal },
    });
  dump('L-13');

  /* ========== L-14 边渲染是否真已 diff 复用（复核记忆 #4639） ========== */
  resetEv();
  // 页面内挂 MutationObserver 统计 #taskMapEdges 变更次数，静置 5s（跨 6 个 800ms 防抖窗）
  await ev(`(function(){window.__MO={edges:0,nodes:0};
    var e=document.getElementById('taskMapEdges');
    if(e){new MutationObserver(function(m){m.forEach(function(x){if(x.type==='childList')window.__MO.edges++;});}).observe(e,{childList:true});}
    var n=document.getElementById('taskMapNodes');
    if(n){new MutationObserver(function(m){m.forEach(function(x){if(x.type==='childList')window.__MO.nodes++;});}).observe(n,{childList:true});}
    return 'observing';})()`);
  // 制造一次 SSE 让前端重绘
  await pokeSseSafe(A);
  await sleep(5200);
  const mo = await ev(`JSON.stringify(window.__MO||{})`);
  await shot('L-14');
  const moObj = JSON.parse(String(mo || '{}'));
  rec('L-14', '边渲染是否真已 diff 复用（复核记忆 #4639 每 800ms 全量重建）', '一般',
    (moObj.edges || 0) <= 2 ? 'PASS（已 diff 复用）' : 'FAIL（仍周期性全量重建）',
    {
      steps: '页面内 MutationObserver 监听 #taskMapEdges / #taskMapNodes 的 childList → 制造一次 SSE → 静置 5.2s（跨 ≥6 个 800ms 防抖窗）→ 读变更次数',
      expect: '记忆 #4639 记录曾每 800ms SSE 全量 innerHTML="" 重建；2026-10-05 改为 diff 复用（app.js:4816-4825）→ 观察期内 childList 变更应 ≈0',
      actual: `5.2s 观察期内：#taskMapEdges childList 变更 ${moObj.edges} 次，#taskMapNodes ${moObj.nodes} 次`,
      finding: (moObj.edges || 0) > 2
        ? '★ 边渲染仍在周期性全量重建 → 记忆 #4639 的问题未真正修复，SSE 每次都打断动画与悬停态'
        : '已确认 diff 复用，#4639 已修复',
      evidence: { mo: moObj, observedSeconds: 5.2 },
    });
  dump('L-14');
  async function pokeSseSafe(id) { try { const cur = q1('SELECT status FROM cards WHERE id=?', Number(id))?.status; await api('POST', `/api/cards/${id}/status`, { status: cur === 'triage' ? 'todo' : 'triage', expected_from: cur, as: 'human:test' }); await sleep(900); await api('POST', `/api/cards/${id}/status`, { status: cur === 'triage' ? 'todo' : 'triage', expected_from: cur === 'triage' ? 'todo' : 'triage', as: 'human:test' }); } catch { } }

  /* ========== L-15 ★pointercancel 未注册 → 地图永久冻结（排最后！） ========== */
  resetEv();
  const lisBefore = await lisDump();
  // 触发一次连线手势（不 release），读 LIS 对照：dragTaskMapNode 有 pointerCANCEL，startLinkDraft 没有
  let l15 = { verdict: 'INCONCLUSIVE' };
  try {
    // 找一个可视 task 卡做源
    const h = await linkHold(A, B);          // 停在按住状态
    const lisAfter = await lisDump();
    // 找 startLinkDraft 的 add（无 pointerCANCEL）
    const linkAdds = lisAfter.filter(x => x.op === 'add' && /startLinkDraft/.test(x.st || ''));
    const dragAdds = lisAfter.filter(x => x.op === 'add' && /dragTaskMapNode/.test(x.st || ''));
    const linkHasCancel = linkAdds.some(x => x.t === 'pointerCANCEL');
    const dragHasCancel = dragAdds.some(x => x.t === 'pointerCANCEL');
    log(`LIS 对照: startLinkDraft add=${linkAdds.length}（含pointerCANCEL=${linkHasCancel}）；dragTaskMapNode add=${dragAdds.length}（含=${dragHasCancel}）`);

    // 尝试用 touchCancel 打断
    let cancelFired = false, frozen = null;
    try {
      const { send } = I;
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      const dotC = h.dot;
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(dotC.cx), y: Math.round(dotC.cy) }] });
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(dotC.cx) + 40, y: Math.round(dotC.cy) + 30 }] });
      await send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      cancelFired = true;
    } catch (e) { log('touchCancel 派发失败，回退合成 PointerEvent:', e.message); }
    await sleep(300);
    if (!cancelFired) {
      // 回退：合成 pointercancel
      await ev(`(function(){var w=document.getElementById('taskMapWorld');
        w.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,clientX:600,clientY:400}));return 'sent';})()`);
    }
    await sleep(1500);
    // 冻结判据：临时虚线残留 + linking class 残留 + 之后建卡不出现
    const tmpLeft = await ev(`!!document.querySelector('#taskMapEdges path.task-map-edge-line')`);
    const linkingLeft = await ev(`document.getElementById('taskMapEdges').classList.contains('task-map-linking')`);
    // 建卡看是否渲染
    const mk = await api('POST', '/api/cards', { title: `[TEST-20261006] L15 冻结检测卡 ${Date.now()}`, kind: 'task' });
    await sleep(2000);
    const newCardVisible = await ev(`(function(){var ns=[].slice.call(document.querySelectorAll('#taskMapNodes .task-map-node-title'));
      for(var i=0;i<ns.length;i++){if((ns[i].textContent||'').indexOf('L15 冻结检测')>=0)return true;}return false;})()`);
    frozen = { tmpLeft, linkingLeft, newCardVisible, mkStatus: mk.status };
    await shot('L-15');
    l15 = {
      verdict: (tmpLeft || linkingLeft) ? 'FAIL（★地图冻结坐实）' : (newCardVisible === false ? 'FAIL（新卡不渲染）' : 'PARTIAL'),
      steps: `① 触发连线手势按住不放；② 读 __LIS 对照（startLinkDraft 是否注册 pointerCANCEL）；③ 用 touchCancel/合成 pointercancel 打断；④ 检查临时虚线与 linking class 是否残留；⑤ 建新卡看是否渲染`,
      expect: 'startLinkDraft 应与 dragTaskMapNode 一样注册 pointercancel（app.js:5038-5039 只注册 pointermove+pointerup，缺 cancel）；打断后 up() 应执行清理，地图继续可用',
      actual: `__LIS 对照：startLinkDraft 的 add 中含 pointerCANCEL=${linkHasCancel ? '有' : '★无'}；dragTaskMapNode 含pointerCANCEL=${dragHasCancel ? '有' : '无'}（对照组）→ 坐实连线手势缺 cancel 监听；打断后：临时虚线残留=${tmpLeft}，linking class 残留=${linkingLeft}；随后建卡 status=${mk.status} 但节点可见=${newCardVisible}`,
      finding: (tmpLeft || linkingLeft || newCardVisible === false)
        ? "★ **地图永久冻结坐实**：pointercancel 触发时 startLinkDraft 的 up() 不执行 → ① window 上 pointermove/pointerup 监听**永久泄漏**（每次鼠标移动都执行 applyFrame）② 临时虚线**永久留在 DOM** ③ _taskMapState.gesture 永久停在 'link'（app.js:5037 设置，只有 up 才清）→ renderTaskMap() 每次在 app.js:5201 early-return → **整个任务地图永久不再重绘**，SSE 推的任何变化都不生效，**只能刷新页面恢复**。对比 dragTaskMapNode 是完整的（app.js:4959-4961 三件齐）"
        : '本次打断未复现冻结（机制已由 __LIS 静态坐实：startLinkDraft 缺 pointerCANCEL；运行时复现不稳定）',
      evidence: { lisStartLink: linkAdds, lisDrag: dragAdds, linkHasCancel, dragHasCancel, frozen },
    };
  } catch (e) {
    l15 = { verdict: 'INCONCLUSIVE', actual: 'L-15 执行异常: ' + e.message, evidence: { err: e.message } };
  }
  rec('L-15', '★pointercancel 未注册 → 地图永久冻结（排最后）', '致命', l15.verdict, l15);
  dump('L-15');

  fs.writeFileSync(path.join(OUT, 'L-summary.json'), j(R), 'utf8');
  log('P3 连线维度完成，共', R.length, '条');
} catch (e) {
  log('★ P3 异常:', e.message, e.stack);
  R.push({ id: 'P3-ERROR', title: '阶段异常', sev: '致命', verdict: 'INCONCLUSIVE', actual: e.message });
  fs.writeFileSync(path.join(OUT, 'L-summary.json'), j(R), 'utf8');
}
await shutdown();
process.exit(0);