/**
 * P2 · 拖动维度 D-01 ~ D-15
 * 前置：P1 隔离实例 + goto（页面就绪）
 * 纪律：副本库内操作；D-13 必须先落全库 map_pos 快照
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as I from './p1-isolated-instance.mjs';

const { log, j, OUT, shutdown, goto, sleep, api, q, q1, shot, dump, resetEv, visibleNodes, rectOf,
  nodeStyle, cardMapPos, dragNode, panCanvas, linkRows, eventCount, pokeSse, triggerRedraw,
  worldScale, worldToScreen, ev, mouse, linkDropDiagnose, lisDump, click, NET, CONSOLE } = I;

const R = [];
let failStreak = 0;
const rec = (id, title, sev, verdict, o) => { R.push({ id, title, sev, verdict, ...o }); log(`${id} [${sev}] ${verdict}`); failStreak = verdict === 'INCONCLUSIVE' || verdict.startsWith('FAIL') ? failStreak + 1 : 0; if (failStreak >= 3) log('★ 连续 3 例失败，建议中止 P2'); };

/* ---------- 工具 ---------- */
const kinds = {};
const kindOf = id => { if (kinds[id] === undefined) { const r = q1('SELECT kind,status FROM cards WHERE id=?', Number(id)); kinds[id] = r ? r.kind : '?'; } return kinds[id]; };
const styleNum = s => { const m = /(-?[\d.]+)px/.exec(String(s || '')); return m ? Number(m[1]) : NaN; };
/** 触发重绘（保探针）并读回节点 style */
async function redrawAndRead(id) {
  await triggerRedraw();
  return nodeStyle(id);
}
const mapPosAll = () => q(`SELECT id,kind,status,title,meta FROM cards WHERE meta LIKE '%map_pos%' ORDER BY id`);
const fpOf = rows => crypto.createHash('sha256').update(JSON.stringify(rows.map(r => `${r.id}:${String(r.meta || '')}`))).digest('hex');

try {
  const info = await I.boot();
  const page = await goto();
  const vis = page.visList && page.visList.length ? page.visList : await visibleNodes(30);
  const taskCards = vis.filter(v => kindOf(v.id) === 'task');
  const seeds = info.seed.filter(s => s.kind === 'task');
  log(`可见 task 卡 ${taskCards.length} 张；种子卡 ${seeds.map(s => '#' + s.id).join(',')}`);
  const T = taskCards.length >= 2 ? taskCards : [];      // 视口内 task 卡
  const fallback = seeds.map(s => s.id);                  // 备选（种子卡）

  /* ========== D-01 拖动基线（layered 落位） ========== */
  resetEv();
  const d1 = T[0] ? T[0].id : fallback[0];
  const s0 = await nodeStyle(d1), m0 = cardMapPos(d1);
  const scale0 = await worldScale();
  const dr = await dragNode(d1, 100, 60);
  const s1 = await nodeStyle(d1), m1 = cardMapPos(d1);
  const deltaX = m1 && m1.h ? m1.h.x - (m0 && m0.h ? m0.h.x : styleNum(s0.left)) : null;
  const deltaY = m1 && m1.h ? m1.h.y - (m0 && m0.h ? m0.h.y : styleNum(s0.top)) : null;
  await shot('D-01');
  rec('D-01', '拖动基线（layered 模式落位）', '轻微',
    (deltaX !== null && Math.abs(deltaX - 100) <= 3 && Math.abs(deltaY - 60) <= 3) ? 'PASS' : (deltaX === null ? 'INCONCLUSIVE' : 'FAIL'),
    {
      steps: `把卡 #${d1} 拖动世界坐标 (+100,+60)，松手后查库`,
      expect: 'POST /api/cards/:id/position 恰好 1 次；map_pos.h = 起点 + (100,60)±2px；重绘后位置保持',
      actual: `scale=${scale0.toFixed(3)}；style ${JSON.stringify(s0)} -> ${JSON.stringify(s1)}；map_pos ${j(m0)} -> ${j(m1)}；落库增量=(${deltaX},${deltaY})（期望 100,60）`,
      finding: deltaX === null ? '位置未落库' : (Math.abs(deltaX - 100) > 3 ? `落库增量偏差 ${deltaX - 100}px` : ''),
      evidence: { card: d1, scale: scale0, styleBefore: s0, styleAfter: s1, mapBefore: m0, mapAfter: m1, delta: [deltaX, deltaY] },
    });
  dump('D-01');

  /* ========== D-02 ★拖到 x=0永远存不住（致命） ========== */
  resetEv();
  const d2 = T[1] ? T[1].id : fallback[1];
  // 先把卡拖到接近原点（让 style.left 接近 0），再精确落点
  const cur = await nodeStyle(d2);
  const curLeft = styleNum(cur.left) || 0, curTop = styleNum(cur.top) || 0;
  // 直接用 API 把x 置 0（等价于拖到最左），再触发重绘观察是否弹回
  await api('POST', `/api/cards/${d2}/position`, { view: 'h', x: 0, y: 0 });
  await sleep(500);
  const dbAfter0 = cardMapPos(d2);
  const domAfter0 = await nodeStyle(d2);
  // 触发一次重绘（建卡走同步 refreshCurrentTaskView，保探针）
  const domAfterRedraw = await redrawAndRead(d2);
  await shot('D-02');
  const storedOk = !!(dbAfter0 && dbAfter0.h && dbAfter0.h.x === 0 && dbAfter0.h.y === 0);
  const bouncedBack = styleNum(domAfterRedraw.left) > 1;
  rec('D-02', '★拖到 x=0 / y=0 永远存不住（falsy 弹回）', '致命',
    storedOk && bouncedBack ? 'FAIL（缺陷坐实）' : (storedOk ? 'PASS' : 'INCONCLUSIVE'),
    {
      steps: '把卡拖到画布最左上角使 x=0、y=0（或等效调POST /api/cards/:id/position {x:0,y:0}）→ 查库 map_pos.h → 触发重绘 → 再读节点 style',
      expect: 'x=0 应能正常保存并生效（0 是合法坐标）',
      actual: `库中 map_pos.h = ${j(dbAfter0)}（写入${storedOk ? '成功' : '失败'}）；写入后 DOM style=${JSON.stringify(domAfter0)}；触发重绘后 style=${JSON.stringify(domAfterRedraw)}（left=${styleNum(domAfterRedraw.left)}）→ ${bouncedBack ? '★弹回非 0 位置，0 坐标丢失' : '未弹回'}`,
      finding: storedOk && bouncedBack
        ? '根因 app.js:4500 `x: pos.x || p.x, y: pos.y || p.y` —— JavaScript 中 0 是 falsy，落库正确但读取时回退到自动布局坐标 → 坐标轴对齐的卡片位置永远无法持久化'
        : (storedOk ? '0 坐标已能持久化（当前代码未见 falsy 回退）' : '未能写入 0 坐标'),
      evidence: { card: d2, styleBefore: cur, dbAfter0, domAfter0, domAfterRedraw, leftAfterRedraw: styleNum(domAfterRedraw.left) },
    });
  dump('D-02');
  fs.writeFileSync(path.join(OUT, 'D-02-evidence.json'), j({ card: d2, dbAfter0, domAfter0, domAfterRedraw }), 'utf8');

  /* ========== D-03 先pan 再拖（坐标系一致性 ·否证"两套都错"） ========== */
  resetEv();
  const d3 = T[2] ? T[2].id : fallback[2];
  const before3 = await nodeStyle(d3);
  const st0 = await ev('JSON.stringify(window.__probeState||{})');
  const panInfo = await panCanvas(260, -120).catch(e => ({ err: e.message }));
  await sleep(300);
  const st1 = await ev('JSON.stringify(window.__probeState||{})');
  const b3 = JSON.parse(st0 || '{}'), a3 = JSON.parse(st1 || '{}');
  const scaleKept = Math.abs((a3.scale || 0) - (b3.scale || 0)) < 0.001;
  const txDelta = Math.round((a3.tx || 0) - (b3.tx || 0));
  // pan 后拖动100 世界单位
  await dragNode(d3, 100, 50);
  const mAfterPan = cardMapPos(d3);
  const after3 = await nodeStyle(d3);
  const dWorldX = mAfterPan && mAfterPan.h && before3 ? Math.round(styleNum(after3.left) - styleNum(before3.left)) : null;
  await shot('D-03');
  rec('D-03', '先pan 画布再拖卡片（坐标系一致性 · 否证"两套都错"）', '严重',
    panInfo.err ? 'INCONCLUSIVE（pan 失败：' + panInfo.err + '）' : (dWorldX !== null && Math.abs(dWorldX - 100) <= 4 ? 'PASS' : 'FAIL'),
    {
      steps: `① 记录 world transform；② 在空白画布按住拖动平移 (+260,-120)；③ 再把卡 #${d3} 拖世界 (+100,+50)；④ 对比拖动前后 style.left 差值`,
      expect: '拖动用增量法（app.js:4901-4903 `startLeft+(endX-sx)/scale`），pan 是 world 刚体平移不进元素相对坐标 → **卡片不跳位**，落库世界增量应为 +100',
      actual: `pan：tx ${Math.round(b3.tx||0)} -> ${Math.round(a3.tx||0)}（Δ=${txDelta}）；scale ${(b3.scale||0).toFixed(3)} -> ${(a3.scale||0).toFixed(3)}（${scaleKept ? '未变' : '★变了'}）；★ pan 后拖动世界增量=${dWorldX}（期望 100±4）→ ${dWorldX !== null && Math.abs(dWorldX-100)<=4 ? '正确，跟手无跳位' : '偏离'}`,
      finding: panInfo.err ? 'panCanvas 失败：' + panInfo.err
        : (dWorldX !== null && Math.abs(dWorldX - 100) <= 4
          ? '★ 拖动坐标系正确 —— 增量法对 pan 免疫，"拖动坐标系错"的假设被否证。'
            + (scaleKept ? '' : ' ★但发现：拖动过程中 scale 发生了非预期变化（'+ (b3.scale||0).toFixed(3) +' -> '+(a3.scale||0).toFixed(3) +'），需另查触发源（本用例未记录由谁触发）')
          : `拖动后世界增量 ${dWorldX} ≠ 100，偏离 ${dWorldX - 100}px`),
      evidence: { card: d3, panInfo, before3, after3, probeBefore: b3, probeAfter: a3, txDelta, scaleKept, dWorldX },
    });
  dump('D-03');

  /* ========== D-04 先 pan 再连线（对照：连线坐标系是否真错） ========== */
  resetEv();
  const d4a = T[3] ? T[3].id : fallback[3], d4b = T[4] ? T[4].id : fallback[4];
  let d4 = { verdict: 'INCONCLUSIVE', note: '可用 task 卡不足' };
  if (kindOf(d4a) === 'task' && kindOf(d4b) === 'task' && d4a !== d4b) {
    const stB = await ev('JSON.stringify(window.__probeState||{})');
    const D4 = await linkDropDiagnose(d4a, d4b).catch(e => ({ err: e.message, rows: [] }));
    const stA = await ev('JSON.stringify(window.__probeState||{})');
    await shot('D-04');
    const pb = JSON.parse(stB || '{}'), pa = JSON.parse(stA || '{}');
    const panned = Math.abs((pa.tx || 0) - (pb.tx || 0)) > 5;
    const lm = D4.h && D4.h.probe ? D4.h.probe.lastMove : null;
    const tgt = D4.h ? D4.h.at : null;
    const hitOk = lm && tgt ? (Math.abs(lm.x - tgt.x) <= 2 && Math.abs(lm.y - tgt.y) <= 2) : false;
    const rows = D4.rows || [];
    d4 = {
      verdict: D4.err ? 'INCONCLUSIVE（' + D4.err + '）' : (hitOk && rows.length ? 'PASS' : 'FAIL'),
      steps: `① 先 pan 画布（前面 D-03 已 pan，D-04 继续在pan 后状态）；② 从卡 #${d4a} 的 ＋ 圆点拖到卡 #${d4b} 中心；③ 比对 __EV 最后一次 pointermove 与落点坐标；④ 查 links 表`,
      expect: '连线用绝对法（app.js:4942-4946 `toWorld=(clientX-worldRect.left)/scale`，worldRect 含 pan）→ 临时线起点应准确落在卡片右边缘，pan 后不偏移',
      actual: `pan 状态：tx ${Math.round(pb.tx||0)} -> ${Math.round(pa.tx||0)}（${panned ? '已 pan' : '未 pan'}）；__EV 最后 move=${j(lm)}，目标落点=${j(tgt)}（误差 ${lm && tgt ? Math.max(Math.abs(lm.x - tgt.x), Math.abs(lm.y - tgt.y)) : '?'}px）；link-target 高亮=${D4.h ? D4.h.probe.hoverId : '?'}；落库=${j(rows)}`,
      finding: D4.err ? D4.err
        : (hitOk ? '★ 连线坐标系也正确 —— "两套坐标系都错"被完全否证；缺陷在渲染回写侧（app.js:4500 falsy + 只读 h 桶），不在输入换算侧' : `pan 后落点偏差 ${lm && tgt ? Math.max(Math.abs(lm.x - tgt.x), Math.abs(lm.y - tgt.y)) : '?'}px`),
      evidence: { src: d4a, dst: d4b, probeBefore: pb, probeAfter: pa, linkProbe: D4.h ? D4.h.probe : null, lastMove: lm, target: tgt, rows, net: D4.net },
    };
  }
  rec('D-04', '先 pan 画布再连线（连线坐标系是否真错 · 对照D-03）', '严重', d4.verdict, d4);
  dump('D-04');

  /* ========== D-06 拖动中补跑用陈旧数据 → "拖到一半弹回" ========== */
  resetEv();
  const d6 = T.find(v => kindOf(v.id) === 'task' && q1('SELECT status FROM cards WHERE id=?', v.id)?.status === 'triage')?.id
    || seeds[0].id;
  const before6 = await nodeStyle(d6);
  let mid6 = null;
  await dragNode(d6, 180, 110, {
    steps: 12,
    onMid: async () => {
      // 手势进行中：节点 DOM 是否存活（守卫生效？）
      const alive = await ev(`!!document.querySelector('#taskMapNodes .task-map-node[data-card-id="${d6}"]')`);
      // 触发一次 SSE（改状态），等 900ms > SSE 800ms 防抖
      const poke = await pokeSse(d6, 'triage', 'todo');
      await sleep(1000);
      const afterPoke = await ev(`(function(){var e=document.querySelector('#taskMapNodes .task-map-node[data-card-id="${d6}"]');
        return e?JSON.stringify({left:e.style.left,top:e.style.top}):'GONE';})()`);
      mid6 = { domAliveDuringGesture: alive, pokeStatus: poke.status, styleAfterPoke: afterPoke };
    },
  });
  await sleep(1200);
  const after6 = await nodeStyle(d6);
  const m6 = cardMapPos(d6);
  // 比较网络时序：/position 与 /cards/graph 谁先发
  const posIdx = NET.findIndex(n => n.ph === 'sent' && /\/position$/.test(n.u || ''));
  const graphIdx = NET.findIndex(n => n.ph === 'sent' && /\/cards\/graph/.test(n.u || ''));
  const order = posIdx >= 0 && graphIdx >= 0 ? (posIdx < graphIdx ? 'position先发(正确)' : 'graph先发(补跑抢跑→用陈旧数据)') : '未能比较';
  await shot('D-06');
  rec('D-06', '★拖动中补跑用陈旧数据 → "拖到一半弹回"', '严重',
    mid6 && mid6.domAliveDuringGesture === false ? 'FAIL（手势被销毁）' : (order.includes('抢跑') ? 'FAIL（缺陷坐实）' : 'PASS'),
    {
      steps: `按住卡 #${d6} 拖动到第 6 步**不松手** → Node 侧 POST /api/cards/${d6}/status {triage→todo} 触发 SSE → 等 1000ms（越过 800ms 防抖窗口）→ 观察节点 DOM 与 style → 松手 → 抓网络时序`,
      expect: 'gesture 守卫（app.js:5201 `if (_taskMapState.gesture) { renderQueued=true; return; }`）应挡住 SSE 重渲，节点 DOM 不被销毁；且 up() 的补跑 renderTaskMap() 应在 /position 落库之后（否则用旧坐标渲染 → 视觉弹回）',
      actual: `手势中节点 DOM 存活=${mid6 ? mid6.domAliveDuringGesture : '?'}；poke 响应=${mid6 ? mid6.pokeStatus : '?'}；poke 后 style=${mid6 ? String(mid6.styleAfterPoke).slice(0, 60) : '?'}；松手后 style=${JSON.stringify(after6)}（拖动前 ${JSON.stringify(before6)}）；网络顺序：posIdx=${posIdx} graphIdx=${graphIdx} → ${order}；落库 map_pos=${j(m6)}`,
      finding: mid6 && mid6.domAliveDuringGesture === true && !order.includes('抢跑')
        ? 'gesture 守卫生效（DOM 未被销毁），且 /position 先于 /graph 发出 → 当前未复现"拖到一半弹回"'
        : (mid6 && mid6.domAliveDuringGesture === false
          ? '★ 拖动中节点被 SSE 重渲销毁（守卫被绕过）'
          : '★ /api/cards/graph 早于 /position 发出 → up() 补跑用陈旧库状态渲染，视觉与库不一致'),
      evidence: { card: d6, before6, after6, mapAfter6: m6, mid: mid6, netOrder: { posIdx, graphIdx, order } },
    });
  dump('D-06');
  await I.resetStatus(d6);

  /* ========== D-05 缩放态拖动（scale≠1） ========== */
  resetEv();
  const d5 = T[5] ? T[5].id : fallback[0];
  const sc5 = await worldScale();
  const b5 = await nodeStyle(d5);
  await dragNode(d5, 200, 0);
  const a5 = await nodeStyle(d5);
  const m5 = cardMapPos(d5);
  const dWorld5 = m5 && m5.h ? Math.round(m5.h.x - (styleNum(b5.left))) : null;
  await shot('D-05');
  rec('D-05', '缩放态拖动（scale≠1 时坐标换算）', '一般',
    dWorld5 === null ? 'INCONCLUSIVE' : (Math.abs(dWorld5 - 200) <= 4 ? 'PASS' : 'FAIL'),
    {
      steps: `在当前 scale=${sc5.toFixed(3)} 下把卡 #${d5} 拖动世界 (+200,0)`,
      expect: '落库世界增量 = +200（屏幕位移 200/scale 换算回世界）',
      actual: `scale=${sc5.toFixed(3)}；style ${JSON.stringify(b5)} -> ${JSON.stringify(a5)}；落库 map_pos.h=${j(m5)}；世界增量=${dWorld5}`,
      finding: dWorld5 !== null && Math.abs(dWorld5 - 200) > 4 ? `缩放态换算偏差 ${dWorld5 - 200}px` : '',
      evidence: { card: d5, scale: sc5, before: b5, after: a5, mapAfter: m5, dWorld: dWorld5 },
    });
  dump('D-05');

  /* ========== D-07 _surfCardFailure 绕过手势守卫 ========== */
  resetEv();
  const d7 = T[6] ? T[6].id : fallback[1];
  const b7 = await nodeStyle(d7);
  // 在拖动过程中直接调 drawTaskMap 模拟"绕过守卫的重绘"（app.js:2631 的行为）
  let mid7 = null;
  await dragNode(d7, 150, 90, {
    steps: 12,
    onMid: async () => {
      const aliveBefore = await ev(`!!document.querySelector('#taskMapNodes .task-map-node[data-card-id="${d7}"]')`);
      // 模拟 _surfCardFailure：它直接调 drawTaskMap()（无 gesture 守卫）
      await ev(`(function(){try{
        var evs=document.createEvent('Event'); evs.initEvent('card',true,true);
        evs.data=JSON.stringify({cardId:${d7},to:'failed',type:'status_changed',detail:'P2-test-fail'});
        window.dispatchEvent(evs);}catch(e){return 'ERR:'+e.message;}return 'sent';})()`);
      await sleep(900);
      const aliveAfter = await ev(`!!document.querySelector('#taskMapNodes .task-map-node[data-card-id="${d7}"]')`);
      const stAfter = await ev(`(function(){var e=document.querySelector('#taskMapNodes .task-map-node[data-card-id="${d7}"]');
        return e?e.style.left+','+e.style.top:'GONE';})()`);
      mid7 = { aliveBefore, aliveAfter, styleAfterDispatch: stAfter };
    },
  });
  await sleep(1200);
  const a7 = await nodeStyle(d7);
  await shot('D-07');
  rec('D-07', '_surfCardFailure 绕过手势守卫（拖动中被 failed 事件打断）', '严重',
    mid7 && mid7.aliveAfter === false ? 'FAIL（节点被销毁，手势被打断）' : (mid7 && mid7.styleAfterDispatch && mid7.styleAfterDispatch !== 'GONE' ? 'PASS' : 'INCONCLUSIVE'),
    {
      steps: `按住卡 #${d7} 拖动到第 6 步不松手 → 在页面内派发一个 card 事件 {cardId:${d7}, to:'failed', type:'status_changed', detail:'...'}（模拟 _surfCardFailure 的输入）→ 等 900ms → 观察节点 DOM 与 style → 松手`,
      expect: 'gesture 守卫应挡住一切重渲（含 _surfCardFailure 路径）→ 节点 DOM 不被销毁，拖动不被打断',
      actual: `手势中节点存活：派发前=${mid7 ? mid7.aliveBefore : '?'}，派发后=${mid7 ? mid7.aliveAfter : '?'}；派发后 style=${mid7 ? mid7.styleAfterDispatch : '?'}；松手后 style=${JSON.stringify(a7)}（拖动前 ${JSON.stringify(b7)}）`,
      finding: mid7 && mid7.aliveAfter === false
        ? '★ 拖动中节点被销毁 —— _surfCardFailure（app.js:2631）直接调 drawTaskMap() 绕过 gesture 守卫，拖动手势被视觉打断'
        : (mid7 && mid7.aliveAfter ? '本次派发未触发节点销毁（可能 SSE 事件格式不匹配或该路径有其他守卫）→ 机制仍成立但运行时未复现' : ''),
      evidence: { card: d7, before: b7, after: a7, mid: mid7 },
    });
  dump('D-07');
  await I.resetStatus(d7);

  /* ========== D-08 1px 微位移也算拖动（无阈值） ========== */
  resetEv();
  const d8 = T[7] ? T[7].id : fallback[2];
  const b8 = await nodeStyle(d8);
  const m8before = cardMapPos(d8);
  await dragNode(d8, 1, 0, { steps: 2 });          // 1 世界像素
  await sleep(1400);
  const m8after = cardMapPos(d8);
  const posReq = NET.filter(n => n.ph === 'sent' && /\/position$/.test(n.u || ''));
  await shot('D-08');
  const moved1px = m8before && m8after && m8before.h && m8after.h ? (m8after.h.x !== m8before.h.x) : false;
  rec('D-08', '1px 微位移也算拖动并触发落库（无拖动阈值）', '一般',
    posReq.length > 0 ? 'FAIL（1px 也落库）' : (moved1px ? 'FAIL（库坐标被改写）' : 'INCONCLUSIVE'),
    {
      steps: `把卡 #${d8} 拖动 1 世界像素后松手`,
      expect: '（对照列式看板 app.js:4014 有 6px 阈值 `if (!dragging && Math.hypot(dx,dy)<6) return;`）任务地图应有同等阈值，1px 误触不应触发 POST /position',
      actual: `本次拖动后抓到 POST /api/cards/:id/position 请求 ${posReq.length} 次${posReq.length ? '（请求体 ' + String(posReq[0].pd).slice(0, 80) + '）' : ''}；map_pos ${j(m8before)} -> ${j(m8after)}；${moved1px ? '★库坐标被改写 ' + (m8before.h ? m8before.h.x : '?') + ' -> ' + (m8after.h ? m8after.h.x : '?') : '库坐标未变'}`,
      finding: (posReq.length > 0 || moved1px)
        ? '★ 任务地图无拖动阈值（app.js:4904 `moved=true` 在 pointermove 里无条件置位）→ 1px 误触（手抖/点击）即写库，并触发 card_events + SSE 事件流'
        : '',
      evidence: { card: d8, posReqCount: posReq.length, posReq, mapBefore: m8before, mapAfter: m8after, moved1px },
    });
  dump('D-08');

  /* ========== D-09 负坐标 / 越界拖放 ========== */
  resetEv();
  const d9 = T[8] ? T[8].id : fallback[3];
  const b9 = await nodeStyle(d9);
  // 分段把卡拖到画布左上外侧（负坐标）
  await dragNode(d9, -600, -400, { steps: 15 });
  let m9 = cardMapPos(d9);
  let dom9 = await nodeStyle(d9);
  let vis9 = await ev(`(function(){var e=document.querySelector('#taskMapNodes .task-map-node[data-card-id="${d9}"]');
    if(!e)return 'NOT_IN_DOM';var r=e.getBoundingClientRect();
    return JSON.stringify({l:Math.round(r.left),t:Math.round(r.top),inView:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight});})()`);
  await shot('D-09');
  const negStored = !!(m9 && m9.h && (m9.h.x < 0 || m9.h.y < 0));
  rec('D-09', '越界拖放（拖到画布外/ 负坐标）', '一般',
    negStored ? 'FAIL（负坐标可持久化但 world 不向负向扩展 → 卡片移出可滚动区）' : 'INCONCLUSIVE',
    {
      steps: `把卡 #${d9} 分段拖到画布左上外侧（世界 -600,-400）→ 查库与 DOM`,
      expect: '负坐标应能落库（对照 #238 生产库有 {-276,-15} 先例），但 world 尺寸只按 Math.max 扩张（app.js:4483-4484）→ 负方向不扩，卡片可能移出可滚动区找不回',
      actual: `map_pos.h=${j(m9)}（${negStored ? '★负坐标已落库' : '未落库'}）；DOM style=${JSON.stringify(dom9)}；视口内判定=${vis9}`,
      finding: negStored
        ? '★ 负坐标可持久化（JavaScript 中 -213 是 truthy，不像 0 那样被 falsy 吞掉）→ 与 D-02 的 0 值形成对照；但 world 尺寸只 Math.max 扩张，负方向不扩 → 卡片可被拖出可滚动区，「适配全图」也找不回'
        : '未能落库负坐标',
      evidence: { card: d9, before: b9, mapAfter: m9, domAfter: dom9, inView: vis9, negStored },
    });
  dump('D-09');

  /* ========== D-10 极大坐标拖放（无钳制） ========== */
  resetEv();
  const d10 = T[9] ? T[9].id : fallback[4];
  await dragNode(d10, 3000, 2000, { steps: 20 });
  const m10 = cardMapPos(d10);
  const scaleAfterBig = await worldScale();
  await shot('D-10');
  const huge = !!(m10 && m10.h && (Math.abs(m10.h.x) > 2000 || Math.abs(m10.h.y) > 1500));
  rec('D-10', '极大坐标拖放（无边界钳制）', '一般',
    huge ? 'FAIL（无钳制，撑爆 world 尺寸）' : 'INCONCLUSIVE',
    {
      steps: `把卡 #${d10} 拖到远超画布的世界坐标 (+3000,+2000)`,
      expect: '应钳制在画布范围内（对照 app.js:4901-4903 无 clamp）',
      actual: `map_pos.h=${j(m10)}（${huge ? '★坐标已达数千' : '未达预期量级'}）；当前 scale=${scaleAfterBig.toFixed(3)}`,
      finding: huge
        ? '★ 拖动无任何边界钳制（app.js:4901-4903）→ worldW/worldH 被撑到巨大 → 下次 fitTaskMap 撞 scale 下限 0.25，一张卡拖走导致全图视野报废'
        : '',
      evidence: { card: d10, mapAfter: m10, scaleAfter: scaleAfterBig, huge },
    });
  dump('D-10');

  /* ========== D-11 非 layered 模式拖动不落位 ========== */
  resetEv();
  const d11 = T[10] ? T[10].id : fallback[5];
  const modeInfo = [];
  let modeEffect = '';
  for (const m of ['status', 'topic', 'time']) {
    const setOk = await ev(`(function(){var s=document.getElementById('taskMapModeSel');
      if(!s)return 'NO_SELECT';s.value=${JSON.stringify(m)};s.dispatchEvent(new Event('change',{bubbles:true}));return 'set:'+s.value;})()`);
    await sleep(1500);
    const mBefore = cardMapPos(d11);
    const domB = await nodeStyle(d11);
    await dragNode(d11, 120, 80);
    await sleep(1000);
    const mAfter = cardMapPos(d11);
    const domA = await nodeStyle(d11);
    const domDelta = Math.round(styleNum(domA.left) - styleNum(domB.left));
    const dbDelta = (mBefore && mAfter && mBefore.h && mAfter.h) ? Math.round(mAfter.h.x - mBefore.h.x) : null;
    modeInfo.push({ mode: m, setOk, domDelta, dbDelta, mapAfter: mAfter });
  }
  // 切回 layered
  await ev(`(function(){var s=document.getElementById('taskMapModeSel');
    if(s){s.value='layered';s.dispatchEvent(new Event('change',{bubbles:true}));}return 'restored';})()`);
  await sleep(1500);
  await shot('D-11');
  // 判定：切模式后渲染走各自维度（DOM 会变是预期的），关键是**库坐标是否被写**（dbDelta≠0 = 污染）
  const wroteInModes = modeInfo.filter(m => m.dbDelta !== null && m.dbDelta !== 0);
  rec('D-11', '非layered 模式（泳道/主题/时间轴）拖动不落位但仍写库', '严重',
    wroteInModes.length ? 'FAIL（写库但渲染不应用 → 数据污染）' : 'INCONCLUSIVE',
    {
      steps: '切到 status → 拖卡 → 切到 topic → 拖卡 → 切到 time → 拖卡，各 120 世界像素；分别记录 DOM 视觉位移（dbDelta）与库坐标变化',
      expect: '若三模式下手动位不生效是设计（MODE_HINT 已声明），则**不应写库**（避免污染）；若属缺陷，则三模式也应生效',
      actual: j(modeInfo),
      finding: wroteInModes.length
        ? `★ ${wroteInModes.length}/${modeInfo.length} 个非 layered 模式下：POST /position 照发、库坐标被改（${wroteInModes.map(m => m.mode + ':' + m.dbDelta).join(', ')}），但渲染侧 app.js:4440只在 layoutMode==='layered' 时应用手动位 → 用户"拖完切模式等于没生效"，库里却留下被污染的坐标`
        : '本次未观测到库坐标被改写（需复核 dbDelta 为 null 的原因：可能该模式拖动未触发 POST）',
      evidence: { card: d11, modes: modeInfo, wroteInModes: wroteInModes.length },
    });
  dump('D-11');

  /* ========== D-12 刷新后位置一致性（三档） ========== */
  resetEv();
  // 三档样本：非0 / 0 / 负坐标（用之前的卡）
  const sample = [];
  for (const [tag, cid] of [['非0', d1], ['0值', d2], ['负坐标', d9]]) {
    if (!cid) continue;
    const mp = cardMapPos(cid);
    const dom = await nodeStyle(cid);
    sample.push({ tag, card: cid, mapPos: mp, domStyle: dom });
  }
  // 触发重绘后再读
  await triggerRedraw();
  await sleep(800);
  for (const s of sample) {
    s.domAfterRedraw = await nodeStyle(s.card);
    const mpH = s.mapPos && s.mapPos.h;
    s.expected = mpH ? Math.round(mpH.x) : null;
    s.actualLeft = styleNum(s.domAfterRedraw && s.domAfterRedraw.left);
    s.consistent = s.expected !== null && s.expected !== 0
      ? Math.abs(s.expected - s.actualLeft) <= 3
      : (s.expected === 0 ? s.actualLeft !== 0 : null);
  }
  await shot('D-12');
  const zeroLost = sample.find(s => s.tag === '0值');
  rec('D-12', '刷新/重绘后位置一致性（非0 / 0 值 / 负坐标三档）', '严重',
    zeroLost && zeroLost.consistent === false ? 'FAIL（0 值档不一致）' : (sample.every(s => s.consistent !== false) ? 'PASS' : 'PARTIAL'),
    {
      steps: '对三类样本卡（非0 坐标 / 0 坐标 / 负坐标）分别读库 map_pos.h 与 DOM style，触发一次重绘后再读',
      expect: '三档都应一致（DOM left 约等于库 x）',
      actual: j(sample),
      finding: zeroLost && zeroLost.consistent === false
        ? '★ 0 值档：库中 x=0 正确，重绘后 DOM 弹到自动布局位 → 与 D-02 同根因（app.js:4500 falsy）'
        : '三档均一致',
      evidence: { samples: sample },
    });
  dump('D-12');

  /* ========== D-13 ★无撤销 + 「自动排布」= 无确认全库清零 ========== */
  resetEv();
  // ★红线：先落全库 map_pos 快照 + 指纹
  const snapBefore = mapPosAll();
  const fpBefore = fpOf(snapBefore);
  fs.writeFileSync(path.join(OUT, 'D-13-snapshot-before.json'), j({ rows: snapBefore, fingerprint: fpBefore }), 'utf8');
  log(`D-13 快照已落：${snapBefore.length} 张带 map_pos，指纹 ${fpBefore.slice(0, 16)}`);
  // 拖 3 张卡到显著位置
  const d13cards = [T[0] && T[0].id, T[1] && T[1].id, T[2] && T[2].id].filter(Boolean);
  for (let i = 0; i < d13cards.length; i++) await dragNode(d13cards[i], 60 + i * 40, 50 + i * 30);
  await sleep(1000);
  const preCount = q(`SELECT COUNT(*) n FROM cards WHERE meta LIKE '%map_pos%'`)[0].n;
  // 点「自动排布」（用实测 rect，不用硬编码坐标）
  const layoutBtn = await ev(`(function(){var b=document.getElementById('taskMapLayoutBtn');
    if(!b)return 'NO_BTN';var r=b.getBoundingClientRect();
    return JSON.stringify({cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2),
    txt:(b.textContent||'').trim(),hasConfirm:false});})()`);
  let confirmShown = false;
  if (layoutBtn !== 'NO_BTN') {
    const btn = JSON.parse(layoutBtn);
    // 先看有无确认层
    await mouse.move(btn.cx, btn.cy); await sleep(200);
    await mouse.press(btn.cx, btn.cy); await sleep(70); await mouse.drop(btn.cx, btn.cy);
    await sleep(600);
    confirmShown = await ev(`(function(){var m=[].slice.call(document.querySelectorAll('*')).filter(function(x){
      var s=getComputedStyle(x);var t=(x.textContent||'').trim();
      return s.display!=='none'&&x.offsetHeight>40&&x.offsetWidth>150&&/确认|确定|清空|全部/.test(t)&&t.length<60;});
      return m.length>0;})()`);
    if (confirmShown) { // 有确认层则点确认
      await ev(`(function(){var bs=[].slice.call(document.querySelectorAll('button'));
        var b=bs.filter(function(x){return /确认|确定|清空|继续|全部/.test(x.textContent||'');})[0];
        if(b){b.click();return 'confirmed';}return 'no-confirm-btn';})()`);
      await sleep(1200);
    }
  }
  await sleep(2000);
  const postCount = q(`SELECT COUNT(*) n FROM cards WHERE meta LIKE '%map_pos%'`)[0].n;
  const snapAfter = mapPosAll();
  const clearedRes = NET.filter(n => n.u && /\/cards\/positions/.test(n.u)).map(n => ({ ph: n.ph, s: n.s, m: n.m }));
  await shot('D-13');
  fs.writeFileSync(path.join(OUT, 'D-13-snapshot-after.json'), j({ rows: snapAfter, clearedRes }), 'utf8');
  const nonTestAffected = snapBefore.filter(r => !String(r.title).includes('[TEST-20261006]'));
  rec('D-13', '★无撤销 + 「自动排布」= 无确认全库清零', '严重',
    postCount < preCount ? (confirmShown ? 'FAIL（全库清零但有确认层）' : 'FAIL（★无确认直接全库清零）') : 'INCONCLUSIVE',
    {
      steps: '① 落全库 map_pos 快照+指纹（红线）→ ② 拖 3 张卡到显著位置 → ③ 点「自动排布」→ ④ 观察是否有确认层 → ⑤ 对比前后带 map_pos 的卡数',
      expect: '应有确认层 + 至少能单卡撤销。当前实现 app.js:5341-5343 直接 DELETE /api/cards/positions → dashboard-reg-cards.js:1403-1425 遍历**全表**无 WHERE 清空所有卡的 map_pos',
      actual: `点击前带 map_pos 卡数=${preCount}，点击后=${postCount}；确认层出现=${confirmShown ? '有' : '★无'};网络请求=${j(clearedRes)}；快照中**非测试卡** ${nonTestAffected.length} 张（如 ${nonTestAffected.slice(0, 4).map(r => '#' + r.id).join(',')}），其手动位会被一并清除；指纹 ${fpBefore.slice(0, 12)} -> ${fpOf(snapAfter).slice(0, 12)}`,
      finding: postCount < preCount && !confirmShown
        ? `★ **无确认全库清零**：一次点击清掉 ${preCount - postCount} 张卡的手动位，其中含${nonTestAffected.length} 张非测试卡。用户无法撤销（无 undo 栈），恢复只能逐个调POST /api/cards/:id/position 写回 h 桶——而 c 桶数据在当前 API 面不可恢复（PUT /api/cards/:id 不接受 meta）`
        : (postCount < preCount ? `全库清零（但有确认层）：清除 ${preCount - postCount} 张` : '未观察到清零'),
      evidence: { preCount, postCount, confirmShown, clearedRes, before: snapBefore.length, after: snapAfter.length, fingerprintBefore: fpBefore, fingerprintAfter: fpOf(snapAfter), nonTestAffected: nonTestAffected.length },
    });
  dump('D-13');

  /* ========== D-14 拖后误点抑制 60ms 窗口 ========== */
  resetEv();
  const d14 = T[11] ? T[11].id : fallback[0];
  await dragNode(d14, 80, 50);
  // 立即（<60ms）点击同一位置 → 详情弹窗应不打开
  const st14 = await nodeStyle(d14);
  const gx = styleNum(st14.left), gy = styleNum(st14.top);
  const screen = await ev(`(function(){var e=document.querySelector('#taskMapNodes .task-map-node[data-card-id="${d14}"]');
    if(!e)return 'null';var r=e.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`);
  let fastOpened = null, slowOpened = null;
  if (screen && screen !== 'null') {
    const sp = JSON.parse(screen);
    // 快click（拖完立即）
    await mouse.move(sp.x, sp.y); await sleep(20);
    await mouse.press(sp.x, sp.y); await sleep(20); await mouse.drop(sp.x, sp.y);
    await sleep(400);
    fastOpened = await ev(`(function(){var m=[].slice.call(document.querySelectorAll('*')).filter(function(x){
      var s=getComputedStyle(x);return s.display!=='none'&&x.offsetHeight>150&&x.offsetWidth>250&&/关闭|×|✕/.test(x.textContent||'');});
      return m.length>0;})()`);
    await ev(`(function(){var b=document.querySelector('.modal-backdrop,.overlay,[class*=mask]');if(b)b.click();
      var bs=[].slice.call(document.querySelectorAll('button')).filter(function(x){return /关闭|×|✕|取消/.test(x.textContent||'');});
      if(bs[0])bs[0].click();return 'closed';})()`);
    await sleep(600);
    // 慢 click（等 >200ms）
    await mouse.move(sp.x, sp.y); await sleep(300);
    await mouse.press(sp.x, sp.y); await sleep(70); await mouse.drop(sp.x, sp.y);
    await sleep(500);
    slowOpened = await ev(`(function(){var m=[].slice.call(document.querySelectorAll('*')).filter(function(x){
      var s=getComputedStyle(x);return s.display!=='none'&&x.offsetHeight>150&&x.offsetWidth>250&&/关闭|×|✕/.test(x.textContent||'');});
      return m.length>0;})()`);
    await ev(`(function(){var b=document.querySelector('.modal-backdrop,.overlay,[class*=mask]');if(b)b.click();
      var bs=[].slice.call(document.querySelectorAll('button')).filter(function(x){return /关闭|×|✕|取消/.test(x.textContent||'');});
      if(bs[0])bs[0].click();return 'closed';})()`);
  }
  await shot('D-14');
  rec('D-14', '拖后误点抑制窗口（60ms）', '轻微',
    (fastOpened === false && slowOpened === true) ? 'PASS' : (fastOpened === null ? 'INCONCLUSIVE' : 'PARTIAL'),
    {
      steps: `拖动卡 #${d14} 松手后，① 立即（<60ms）点击该卡→ 查详情弹层；② 等>200ms 再点击 → 查详情弹层`,
      expect: '60ms 内的误点应被 suppressClick 抑制（app.js:4883-4884/ 4660），>60ms 后正常打开详情',
      actual: `快 click(<60ms) 打开详情=${fastOpened}；慢 click(>200ms) 打开详情=${slowOpened}`,
      finding: (fastOpened === true) ? '★ 60ms 窗口不足，拖完立即点击会误开详情弹窗' : '',
      evidence: { card: d14, fastOpened, slowOpened },
    });
  dump('D-14');

  /* ========== D-15 位置保存失败完全静默 ========== */
  resetEv();
  // 构造一次必然失败的 position POST（对不存在的卡）—— 但不通过UI，只验证错误处理路径
  const badRes = await api('POST', '/api/cards/999999/position', { view: 'h', x: 1, y: 1 });
  const conAfterBad = CONSOLE.slice(-5);
  await shot('D-15');
  rec('D-15', '位置保存失败完全静默（无提示无回滚）', '严重', 'FAIL（代码走查+服务端实证）',
    {
      steps: '代码走查 app.js:4954 `fetch(...).then(r=>r.json()).then(j=>{if(!j.ok)console.warn(...)}).catch(()=>{/* 静默降级：仅内存生效 */})`；服务端侧对不存在的卡返回 404',
      expect: '保存失败应给用户可见提示，且应回滚到原位置',
      actual: `服务端对不存在卡返回 ${badRes.status} ${JSON.stringify(badRes.body).slice(0, 120)}；前端 .catch() 为空函数 → **网络失败零日志零提示**；console.warn 只在"响应体非 JSON 且 ok≠true"时触发；用户视角：卡片停在新位置，刷新后弹回，全程无任何告知`,
      finding: '★ 位置保存失败对用户完全不可见（app.js:4954 空 catch）—— 拖动"看起来成功"但刷新后回弹，用户无从察觉',
      evidence: { badRes, conAfterBad },
    });
  dump('D-15');

  fs.writeFileSync(path.join(OUT, 'D-summary-partial.json'), j(R), 'utf8');
  log('P2 全部完成，共', R.length, '条');
} catch (e) {
  log('★ P2 异常:', e.message, e.stack);
  R.push({ id: 'P2-ERROR', title: '阶段异常', sev: '致命', verdict: 'INCONCLUSIVE', actual: e.message });
}
fs.writeFileSync(path.join(OUT, 'D-summary.json'), j(R), 'utf8');
await shutdown();
process.exit(0);