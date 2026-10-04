// P4 载体点亮：zcode（ZCode 桌面版自带 CLI）端到端 —— 预期：管线通、provider 429 限流则诚实 failed
const fs = require('node:fs');
const T = fs.readFileSync(process.env.APPDATA + '\\MemoryOS\\data\\token', 'utf8').trim();
const B = 'http://127.0.0.1:8787';
const j = (o) => JSON.stringify(o);
const ZCJS = 'C:\\Users\\WYX\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs';
// 预设 zcode 已声明 promptFlag="-p"（任务文本作 -p 的值）；档案只提供 cjs 路径
const OV = { cmd: 'node', args: [ZCJS], useStdin: false };
(async () => {
  let r = await fetch(`${B}/api/agent-profiles?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({
    name: 'zcode直控', agent_key: 'zcode', channel: 'cli',
    workspace: 'C:\\Users\\WYX\\Desktop\\MemoryOS',
    launch_overrides: OV,
  }) });
  let a = await r.json().catch(() => ({}));
  console.log('agent 卡:', r.status, JSON.stringify(a).slice(0, 140));
  if (!a.ok) process.exit(1);
  const profId = a.profile_id, cardId = a.card_id;
  r = await fetch(`${B}/api/agent-profiles/${profId}?token=${T}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: j({ launch_overrides: OV }) });
  console.log('PUT 档案', profId, ':', r.status, JSON.stringify(await r.json().catch(() => ({}))).slice(0, 80));
  r = await fetch(`${B}/api/cards?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ title: '[P4验收zcode] 创建验收文件并收口', kind: 'task', status: 'ready', body: '在本工作区只创建文件 outputs/p4-acceptance/zcode-cli-smoke.md（内容一行：ok），不要改动其他任何文件。完成后按约定格式收口（结尾输出 <<<HANDOFF>>> 分节）。' }) });
  const c = await r.json().catch(() => ({}));
  console.log('任务卡:', r.status, JSON.stringify(c).slice(0, 100));
  if (!c.ok) process.exit(1);
  r = await fetch(`${B}/api/cards/${c.id}/dispatch-agent?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ agent_card_id: cardId }) });
  const d = await r.json().catch(() => ({}));
  console.log('派发:', r.status, JSON.stringify(d).slice(0, 160));
  const deadline = Date.now() + 5 * 60000;
  let st = c.status, last = {};
  while (Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 10000));
    const sr = await fetch(`${B}/api/cards/${c.id}?token=${T}`).then((x) => x.json()).catch(() => ({}));
    st = sr.card?.status; last = sr;
    process.stdout.write('  [' + new Date().toTimeString().slice(0, 8) + '] 状态=' + st + '\n');
    if (st === 'review' || st === 'failed' || st === 'done') break;
  }
  console.log('终态:', st, 'detail:', JSON.stringify(last.card?.detail ?? '').slice(0, 200));
  const f = 'C:\\Users\\WYX\\Desktop\\MemoryOS\\outputs\\p4-acceptance\\zcode-cli-smoke.md';
  console.log('验收文件:', fs.existsSync(f) ? '存在：' + JSON.stringify(fs.readFileSync(f, 'utf8').slice(0, 60)) : '不存在');
  const ex = await fetch(`${B}/api/agent-cards/${cardId}/exec?token=${T}`).then((x) => x.json()).catch(() => ({}));
  console.log('执行记录:', JSON.stringify(ex).slice(0, 260));
})().catch((e) => { console.error('e2e 异常:', e.message); process.exit(2); });
