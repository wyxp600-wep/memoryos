/** P1 · 隔离实例冒烟：起实例 → 身份门 → 页面就绪 → 落盘 */
import fs from 'node:fs';
import path from 'node:path';
import * as I from './p1-isolated-instance.mjs';

const { log, j, OUT, shutdown, goto, shot, visibleNodes, q, q1, prodFingerprint, api, sleep } = I;

let ok = true;
const R = { steps: [], assertions: {} };
try {
  /* ① 生产库指纹（隔离前） */
  const before = prodFingerprint();
  R.steps.push({ step: 1, what: '生产库指纹 before-实例', data: before });
  log('生产库 before:', j(before));

  /* ② 起隔离实例 */
  const info = await I.boot();
  R.steps.push({ step: 2, what: '实例已启', info });

  /* ③ 页面就绪（三前置） */
  const page = await goto();
  R.steps.push({ step: 3, what: '页面就绪', page });
  log('页面:', j(page));

  /* ④ hover 探针（连线维度前提）—— 用【视口内可见 且 kind=task】的卡
   *★ 必须按库里的 kind 过滤，不能按标题文字猜：doc/agent/handoff 卡作depends 前置会被后端 400
   *   （dashboard-reg-cards.js:1044-1052 白名单只含 task/handoff） */
  const seeds = info.seed.filter(s => s.kind === 'task');
  const vis0 = page.visList && page.visList.length ? page.visList : await visibleNodes(30);
  // 按 id 查库拿真实 kind
  const kindOf = {};
  for (const v of vis0) { const row = q1('SELECT kind FROM cards WHERE id=?', v.id); kindOf[v.id] = row ? row.kind : '?'; }
  const visTask = vis0.filter(v => kindOf[v.id] === 'task');
  log('可见卡:', vis0.length, '其中kind=task:', visTask.length,
    JSON.stringify(visTask.slice(0, 5).map(v => `#${v.id}(${kindOf[v.id]})`)));
  if (visTask.length < 2) throw new Error('视口内可见 task 卡不足 2 张（kind 分布: ' + j(kindOf) + '）');
  const probeCard = visTask[0].id;
  await I.mouse.move(5, 5); await sleep(150);
  const rc = await I.anchorCard(probeCard);
  const hp = await I.ev(`(function(){var n=document.querySelector('#taskMapNodes .task-map-node[data-card-id="${probeCard}"]');
    var l=n&&n.querySelector('.task-map-node-link');if(!l)return 'NO_LINK';
    var s=getComputedStyle(l);return JSON.stringify({vis:s.visibility,pe:s.pointerEvents,op:s.opacity});})()`);
  R.steps.push({ step: 4, what: 'hover 探针', card: probeCard, title: visTask[0].title, rect: rc, probe: JSON.parse(String(hp)) });
  log('hover 探针 #'+probeCard+':', hp);
  R.assertions.hoverWorks = String(hp).includes('"pe":"auto"');

  /* ⑤ 可见节点 */
  const vis = vis0;
  R.steps.push({ step: 5, what: '可见节点', count: vis.length, list: vis, kindOf });
  log('可见节点:', vis.length);
  R.assertions.hasVisibleNodes = vis.length > 0;

  /* ⑥ 拖动原语冒烟（用可见 task 卡） */
  const dragTarget = visTask[1].id;
  const st0 = await I.nodeStyle(dragTarget);
  const mp0 = I.cardMapPos(dragTarget);
  await I.dragNode(dragTarget, 100, 60);
  const st1 = await I.nodeStyle(dragTarget);
  const mp1 = I.cardMapPos(dragTarget);
  R.steps.push({ step: 6, what: '拖动原语冒烟', card: dragTarget, before: { st0, mp0 }, after: { st1, mp1 } });
  log(`拖动 #${dragTarget}: style ${JSON.stringify(st0)} -> ${JSON.stringify(st1)}; map_pos ${j(mp0)} -> ${j(mp1)}`);
  R.assertions.dragChangesStyle = JSON.stringify(st0) !== JSON.stringify(st1);
  R.assertions.dragPersists = !!(mp1 && mp1.h);

  /* ⑦ 连线原语冒烟（两张可见 kind=task 卡） */
  const s1 = visTask[0].id, s2 = visTask[2] ? visTask[2].id : visTask[1].id;
  const D = await I.linkDropDiagnose(s1, s2);
  const h = D.h;
  R.steps.push({ step: 7, what: '连线手势', dot: h.dot, probe: h.probe, before: D.before, after: D.after, net: D.net });
  log('连线探针:', j(h.probe));
  log('drop前:', j(D.before), 'drop后:', j(D.after));
  R.assertions.linkDotAppears = !!(h.dot && h.dot.w >= 1);
  R.assertions.linkTargetHighlighted = h.probe.hoverId === s2;
  R.assertions.draftLineExists = !!h.probe.draftD;
  R.assertions.gestureCleanedUp = (D.before.linking === true && D.after.linking === false);
  R.assertions.linkPersists = D.rows.length === 1 && D.rows[0].dst_id === s2 && D.rows[0].kind === 'depends';
  log('连线落库:', j(D.rows), '网络:', j(D.net));
  if (!R.assertions.linkPersists) {
    const raw = await I.api('POST', `/api/cards/${s1}/links`, { dst_card_id: s2, kind: 'depends' });
    R.steps.push({ step: 7.1, what: '直打API复核', status: raw.status, body: raw.body });
    log('★ 连线未落库，直打 API 复核:', raw.status, JSON.stringify(raw.body).slice(0, 260));
  }

  /* ⑧ LIS 探针：连线 vs 拖动 的 pointercancel 对照（L-10 预证） */
  const lis = await I.lisDump();
  const cancels = lis.filter(x => x.t === 'pointerCANCEL');
  const withFn = cancels.map(x => ({ op: x.op, fn: (x.fn || '').slice(0, 60), st: (x.st || '').slice(0, 200) }));
  R.steps.push({ step: 9, what: 'LIS pointercancel 对照', total: lis.length, cancels: withFn });
  log('LIS 总数:', lis.length, 'pointerCANCEL 条数:', cancels.length);
  log(JSON.stringify(withFn, null, 1));
  fs.writeFileSync(path.join(OUT, 'L-10-lis-precheck.json'), j(lis), 'utf8');

  /* ⑨ 截图 */
  const s = await shot('P1-smoke');
  log('截图:', s);

  /* ⑩ 生产库指纹（隔离后）应完全一致 */
  const after = prodFingerprint();
  const det = I.prodDetail();
  R.steps.push({ step: 10, what: '生产库指纹 after-实例', data: after, detail: det });
  // ★ 主断言：计数项 + testCards（只有测试写入才会变）
  R.assertions.prodCountsUnchanged = (JSON.stringify(before) === JSON.stringify(after));
  // digest 变化单独记录（内核自身/用户会话也会改生产库，靠 updated_at 佐证归属）
  R.assertions.prodDetail = det;
  log('生产库计数项:', R.assertions.prodCountsUnchanged ? '✅ 一致' : '❌ 有变化');
  log('digest:', det.digest.slice(0, 16), '| 近40分钟被改的卡:', JSON.stringify(det.recentChanged));

} catch (e) {
  R.error = e.message + '\n' + (e.stack || '');
  log('★ 失败:', e.message);
  ok = false;
}

R.allGreen = ok && Object.entries(R.assertions).filter(([k])=>k!=='prodDetail').every(([,v])=>v===true);
fs.writeFileSync(path.join(OUT, 'P1-smoke.json'), j(R), 'utf8');
log('全部断言:', j(R.assertions));
log(R.allGreen ? '★ P1 冒烟全绿' : '★ P1 冒烟有失败项');
await shutdown();
process.exit(R.allGreen ? 0 : 1);