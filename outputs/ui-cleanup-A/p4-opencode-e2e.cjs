// P4 载体点亮：opencode（OpenCode CLI）端到端 —— 登录态复用桌面版，预期全链路成功
const fs = require('node:fs');
const T = fs.readFileSync(process.env.APPDATA + '\\MemoryOS\\data\\token', 'utf8').trim();
const B = 'http://127.0.0.1:8787';
const j = (o) => JSON.stringify(o);
const OPEX = 'C:\\Users\\WYX\\AppData\\Local\\Programs\\@opencodedesktop\\resources\\opencode-cli.exe';
(async () => {
  let r = await fetch(`${B}/api/agent-profiles?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({
    name: 'opencode直控', agent_key: 'opencode', channel: 'cli',
    workspace: 'C:\\Users\\WYX\\Desktop\\MemoryOS',
    launch_overrides: { cmd: OPEX, args: ['run', '--auto'], useStdin: false, promptAsArg: true }, // ★ 对象（写入端 JSON.stringify；传字符串会双重编码致 fallback）
  }) });
  let a = await r.json().catch(() => ({}));
  console.log('agent 卡:', r.status, JSON.stringify(a).slice(0, 180));
  if (!a.ok) process.exit(1);
  const cardId = a.card_id;
  // 确保 launch_overrides 为正确对象（POST upsert 可能沿用旧值；PUT 整替换为权威）
  r = await fetch(`${B}/api/agent-profiles/${a.profile_id}?token=${T}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: j({ launch_overrides: { cmd: OPEX, args: ['run', '--auto'], useStdin: false, promptAsArg: true } }) });
  console.log('PUT 档案', a.profile_id, ':', r.status, JSON.stringify(await r.json().catch(() => ({}))).slice(0, 120));
  r = await fetch(`${B}/api/cards?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ title: '[P4验收opencode] 创建验收文件并收口', kind: 'task', status: 'ready', body: '在本工作区创建文件 outputs/p4-acceptance/opencode-smoke.md，内容一行：ok。完成后请按约定格式收口（结尾输出 <<<HANDOFF>>> 分节）。' }) });
  const c = await r.json().catch(() => ({}));
  console.log('任务卡:', r.status, JSON.stringify(c).slice(0, 100));
  if (!c.ok) process.exit(1);
  r = await fetch(`${B}/api/cards/${c.id}/dispatch-agent?token=${T}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ agent_card_id: cardId }) });
  const d = await r.json().catch(() => ({}));
  console.log('派发:', r.status, JSON.stringify(d).slice(0, 200));
  const deadline = Date.now() + 5 * 60000;
  let st = c.status, last = {};
  while (Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 10000));
    const sr = await fetch(`${B}/api/cards/${c.id}?token=${T}`).then((x) => x.json()).catch(() => ({}));
    st = sr.card?.status; last = sr;
    process.stdout.write('  [' + new Date().toTimeString().slice(0, 8) + '] 任务卡状态=' + st + '\n');
    if (st === 'review' || st === 'failed' || st === 'done') break;
  }
  console.log('终态:', st);
  const f = 'C:\\Users\\WYX\\Desktop\\MemoryOS\\outputs\\p4-acceptance\\opencode-smoke.md';
  console.log('验收文件:', fs.existsSync(f) ? '存在：' + JSON.stringify(fs.readFileSync(f, 'utf8').slice(0, 80)) : '不存在');
  const ex = await fetch(`${B}/api/agent-cards/${cardId}/exec?token=${T}`).then((x) => x.json()).catch(() => ({}));
  console.log('执行记录:', JSON.stringify(ex).slice(0, 300));
  console.log('卡片:', JSON.stringify({ status: st, conclusion: last.card?.conclusion, detail: last.card?.detail }).slice(0, 400));
})().catch((e) => { console.error('e2e 异常:', e.message); process.exit(2); });
