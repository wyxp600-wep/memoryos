// P4 载体点亮：mimocode（mimo）CLI 直控端到端
const fs = require('node:fs');
const T = fs.readFileSync(process.env.APPDATA + '\\MemoryOS\\data\\token', 'utf8').trim();
const B = 'http://127.0.0.1:8787';
const j = (o) => JSON.stringify(o);
(async () => {
  let r = await fetch(`${B}/api/agent-profiles?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ name: 'mimocode直控', agent_key: 'mimocode', channel: 'cli', workspace: 'C:\\Users\\WYX\\Desktop\\MemoryOS' }) });
  let a = await r.json().catch(() => ({}));
  console.log('agent 卡:', r.status, JSON.stringify(a).slice(0, 140));
  if (!a.ok) process.exit(1);
  r = await fetch(`${B}/api/cards?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ title: '[P4验收mimo] 创建验收文件并收口', kind: 'task', status: 'ready', body: '在本工作区创建文件 outputs/p4-acceptance/mimo-smoke.md，内容一行：ok。完成后请按约定格式收口（结尾输出 <<<HANDOFF>>> 分节）。' }) });
  const c = await r.json().catch(() => ({}));
  console.log('任务卡:', r.status, JSON.stringify(c).slice(0, 100));
  if (!c.ok) process.exit(1);
  r = await fetch(`${B}/api/cards/${c.id}/dispatch-agent?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ agent_card_id: a.card_id }) });
  const d = await r.json().catch(() => ({}));
  console.log('派发:', r.status, JSON.stringify(d).slice(0, 220));
  console.log('轮询至终态（最多 4 分钟）…');
  const deadline = Date.now() + 4 * 60000;
  let st = c.status, last = {};
  while (Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 10000));
    const sr = await fetch(`${B}/api/cards/${c.id}?token=${T}`).then((x) => x.json()).catch(() => ({}));
    st = sr.card?.status; last = sr;
    process.stdout.write('  [' + new Date().toTimeString().slice(0, 8) + '] 任务卡状态=' + st + '\n');
    if (st === 'review' || st === 'failed' || st === 'done') break;
  }
  console.log('终态:', st);
  const f = 'C:\\Users\\WYX\\Desktop\\MemoryOS\\outputs\\p4-acceptance\\mimo-smoke.md';
  console.log('验收文件:', fs.existsSync(f) ? '存在：' + JSON.stringify(fs.readFileSync(f, 'utf8').slice(0, 100)) : '不存在');
  const g = await fetch(`${B}/api/cards/graph?token=${T}`).then((x) => x.json()).catch(() => ({}));
  const handoffs = (g.nodes || []).filter((n) => String(n.kind) === 'handoff' && /mimo-smoke|P4验收mimo/.test(String(n.title || '')));
  const edge = (g.edges || []).find((e) => e.target_id === String(a.card_id) && e.kind === 'dispatch');
  console.log('交接卡:', handoffs.length ? '已生成（' + handoffs.map((h) => '#' + h.id).join(',') + '）' : '未生成');
  console.log('派发边:', edge ? `${edge.kind}/${edge.status}` : '无');
  if (st === 'failed') {
    console.log('失败诊断（读 exec 流尾部）:');
    const es = await fetch(`${B}/api/agent-cards/${a.card_id}/exec/stream?token=${T}`).then((x) => x.text()).catch(() => '');
    console.log(String(es).split('\n').filter((l) => l.startsWith('data:')).slice(-6).join('\n'));
  }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
