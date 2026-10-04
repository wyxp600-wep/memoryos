// P4 载体点亮：claude CLI 直控端到端（真实任务：写一行验收文件 + 收口）
const fs = require('node:fs');
const T = fs.readFileSync(process.env.APPDATA + '\\MemoryOS\\data\\token', 'utf8').trim();
const B = 'http://127.0.0.1:8787';
const j = (o) => JSON.stringify(o);
(async () => {
  // 1) agent 卡（claude · cli 直控 · 工作区=本仓）
  let r = await fetch(`${B}/api/agent-profiles?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ name: 'claude直控', agent_key: 'claude', channel: 'cli', workspace: 'C:\\Users\\WYX\\Desktop\\MemoryOS' }) });
  let a = await r.json().catch(() => ({}));
  console.log('agent 卡:', r.status, JSON.stringify(a).slice(0, 160));
  if (!a.ok) process.exit(1);
  // 2) 任务卡
  r = await fetch(`${B}/api/cards?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ title: '[P4验收] 创建验收文件并收口', kind: 'task', status: 'ready', body: '在本工作区创建文件 outputs/p4-acceptance/claude-smoke.md，内容一行：ok。完成后请按约定格式收口（结尾输出 <<<HANDOFF>>> 分节）。' }) });
  const c = await r.json().catch(() => ({}));
  console.log('任务卡:', r.status, JSON.stringify(c).slice(0, 120));
  if (!c.ok) process.exit(1);
  // 3) 派发（目标 agent 卡 → cliexec 按 channel=cli 直控 claude）
  r = await fetch(`${B}/api/cards/${c.id}/dispatch-agent?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ agent_card_id: a.card_id }) });
  const d = await r.json().catch(() => ({}));
  console.log('派发:', r.status, JSON.stringify(d).slice(0, 260));
  if (r.status === 409) { console.log('（409：任务卡不在 ready——需先流转状态；见任务卡状态', c.status, '）'); }
  if (!d.ok && d.runId === undefined) process.exit(2);
  console.log('DISPATCHED task=' + c.id + ' agent_card=' + a.card_id + '（CLI 直控 claude 跑真实任务，轮询至终态…）');
  const deadline = Date.now() + 4 * 60000;
  let st = c.status;
  while (Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 10000));
    const sr = await fetch(`${B}/api/cards/${c.id}?token=${T}`).then((x) => x.json()).catch(() => ({}));
    st = sr.card?.status;
    process.stdout.write('  [' + new Date().toTimeString().slice(0, 8) + '] 任务卡状态=' + st + '\n');
    if (st === 'review' || st === 'failed' || st === 'done' || st === 'archived') break;
  }
  console.log('终态:', st);
  const f = 'C:\\Users\\WYX\\Desktop\\MemoryOS\\outputs\\p4-acceptance\\claude-smoke.md';
  console.log('验收文件:', fs.existsSync(f) ? '存在：' + JSON.stringify(fs.readFileSync(f, 'utf8').slice(0, 120)) : '不存在');
  const g = await fetch(`${B}/api/cards/graph?token=${T}`).then((x) => x.json()).catch(() => ({}));
  const handoffs = (g.nodes || []).filter((n) => String(n.kind) === 'handoff' && n.meta && /claude-smoke|P4验收/.test(JSON.stringify(n.meta ?? {})));
  const edge = (g.edges || []).find((e) => e.target_id === String(a.card_id) && e.kind === 'dispatch');
  console.log('交接卡:', handoffs.length ? '已生成（' + handoffs.map((h) => '#' + h.id).join(',') + '）' : '未生成');
  console.log('派发边状态:', edge ? `${edge.kind}/${edge.status}` : '无');
  console.log('任务卡终 meta:', JSON.stringify(sr.card?.meta ?? {}).slice(0, 200));
  if (st === 'failed') console.log('（失败=诚实降级：看 CLI 日志与 4xx 原因；本载体暂标「未连通·缺X」进下一个）');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
