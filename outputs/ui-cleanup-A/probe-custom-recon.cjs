const fs = require('node:fs');
const T = fs.readFileSync(process.env.APPDATA + '\\MemoryOS\\data\\token', 'utf8').trim();
const CN = '__probe_custom3';
const B = 'http://127.0.0.1:8787';
(async () => {
  const reg = await fetch(`${B}/api/scan-agents/custom?token=${T}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: CN, path: '', configDir: '' }),
  });
  console.log('POST custom 登记 →', reg.status, (await reg.text()).slice(0, 120));
  const scan = await (await fetch(`${B}/api/scan-agents?token=${T}`)).json();
  const merged = scan.agents.some(a => a.name === CN || a.id === CN);
  console.log(`双打判读：登记后 scan 清单含 ${CN} = ${merged}（true → P1 的 60s TTL 必须「登记成功清缓存戳」）`);
  console.log(`scan 基线：total=${scan.total} connected=${scan.connected}`);
  console.log('--- 六名字对账 ---');
  for (const n of ['trae', 'dsh', 'minimax', 'workbuddy', 'opencode', 'mimocode']) {
    const hit = scan.agents.filter(a => a.id === n || String(a.name).toLowerCase().includes(n));
    console.log(n.padEnd(12), '→', hit.length ? hit.map(a => `${a.id}(connected=${a.connected}) type=${a.type} path=${a.path ?? '-'}`).join(' | ') : '未命中（需 custom 登记）');
  }
  console.log('--- 全清单 ids（供人工速览）---');
  console.log(scan.agents.map(a => a.id).join(', '));
  const del = await fetch(`${B}/api/scan-agents/custom?token=${T}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: CN }),
  });
  console.log('清理 →', del.status, (await del.text()).slice(0, 80));
})().catch(e => { console.error('FAIL', e); process.exit(1); });
