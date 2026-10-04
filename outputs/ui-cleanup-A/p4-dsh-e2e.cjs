// P4 载体点亮：dsh（DeepSeek Harness）CLI 直控端到端
// 预期：拉起 dsh --profile headless → 缺 DEEPSEEK_API_KEY → MISSING_CREDENTIAL exit=1 → 卡片 failed（管线实证）
const fs = require('node:fs');
const T = fs.readFileSync(process.env.APPDATA + '\\MemoryOS\\data\\token', 'utf8').trim();
const B = 'http://127.0.0.1:8787';
const j = (o) => JSON.stringify(o);
(async () => {
  let r = await fetch(`${B}/api/agent-profiles?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ name: 'dsh直控', agent_key: 'dsh', channel: 'cli', workspace: 'C:\\Users\\WYX\\Desktop\\MemoryOS' }) });
  let a = await r.json().catch(() => ({}));
  console.log('agent 卡:', r.status, JSON.stringify(a).slice(0, 160));
  if (!a.ok && !a.card_id) process.exit(1);
  const cardId = a.card_id;
  r = await fetch(`${B}/api/cards?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ title: '[P4验收dsh] 载体管线实证（缺key预期failed）', kind: 'task', status: 'ready', body: 'Print exactly this line: ok' }) });
  const c = await r.json().catch(() => ({}));
  console.log('任务卡:', r.status, JSON.stringify(c).slice(0, 100));
  if (!c.ok) process.exit(1);
  r = await fetch(`${B}/api/cards/${c.id}/dispatch-agent?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ agent_card_id: cardId }) });
  const d = await r.json().catch(() => ({}));
  console.log('派发:', r.status, JSON.stringify(d).slice(0, 220));
  const deadline = Date.now() + 3 * 60000;
  let st = c.status, last = {};
  while (Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 8000));
    const sr = await fetch(`${B}/api/cards/${c.id}?token=${T}`).then((x) => x.json()).catch(() => ({}));
    st = sr.card?.status; last = sr;
    process.stdout.write('  [' + new Date().toTimeString().slice(0, 8) + '] 任务卡状态=' + st + '\n');
    if (st === 'review' || st === 'failed' || st === 'done') break;
  }
  console.log('终态:', st);
  // 执行流证据行（找 MISSING_CREDENTIAL / 执行器行）
  const ex = await fetch(`${B}/api/agent-cards/${cardId}/exec/stream?token=${T}`).then((x) => x.text()).catch(() => '');
  const hits = ex.split('\n').filter((l) => /执行器|MISSING_CREDENTIAL|CREDENTIAL|进程退出|收口/.test(l));
  console.log('执行流关键行:\n' + hits.slice(-12).join('\n'));
  // cli-logs 落盘证据
  const logDir = process.env.APPDATA + '\\MemoryOS\\data\\cli-logs';
  const logs = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith('.log')).sort().slice(-3) : [];
  console.log('cli-logs 最近:', logs.join(', ') || '(无目录)');
  if (logs.length) {
    const lastLog = fs.readFileSync(logDir + '\\' + logs[logs.length - 1], 'utf8');
    console.log('末份日志尾部:\n' + lastLog.slice(-500));
  }
  console.log('卡片 conclusion/detail:', JSON.stringify({ conclusion: last.card?.conclusion, detail: last.card?.detail, status: st }).slice(0, 400));
})().catch((e) => { console.error('e2e 异常:', e.message); process.exit(2); });
