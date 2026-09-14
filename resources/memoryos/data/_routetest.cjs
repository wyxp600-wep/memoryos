const base = 'http://127.0.0.1:8787';
const T = process.argv[2];
(async () => {
const paths = ['/api/cards/20/status', '/api/cards/20/claim', '/api/cards/20/links', '/api/cards/20/push-to-task', '/api/cards/aux-attach'];
for (const p of paths) {
  const r = await fetch(base + p + '?token=' + T, { method: 'OPTIONS' }).catch(() => null);
  console.log('OPTIONS', p, r ? r.status : 'fail');
}
// POST empty to see which routes exist (404 = missing route; 400/401/405 = exists)
for (const p of ['/api/cards/20/status', '/api/cards/20/claim', '/api/cards/20/links', '/api/cards/20/push-to-task']) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'x-memory-token': T, 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
  if (!r) { console.log('POST', p, 'network fail'); continue; }
  const t = await r.text().catch(() => '');
  console.log('POST', p, r.status, t.slice(0, 90));
}
})();
