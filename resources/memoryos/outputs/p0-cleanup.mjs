/**
 * P0 · 清理仓内孤儿库的6 张测试卡 + 记录生产库零污染基线
 * 纪律：绝不对 8787 发 DELETE（生产库 id 20~282，不存在 1-6）；绝不触碰 APPDATA 库任何写操作。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const OUT = path.join('C:/Users/WYX/Desktop/MemoryOS/resources/memoryos/outputs/card-manual-test/20261006');
fs.mkdirSync(OUT, { recursive: true });
const PROD_DB = 'C:/Users/WYX/AppData/Roaming/MemoryOS/data/memory.db';
const WH_DB = 'C:/Users/WYX/Desktop/MemoryOS/resources/memoryos/data/memory.db';
const PREFIX = '[TEST-20261006]';
const j = v => JSON.stringify(v, null, 2);
const log = (...a) => console.log('[P0]', ...a);

/* ---------- 生产库零污染指纹 ---------- */
export function prodFingerprint() {
  const d = new DatabaseSync(PROD_DB, { readOnly: true });
  const f = {
    cards: d.prepare('SELECT COUNT(*) n FROM cards').get().n,
    links: d.prepare('SELECT COUNT(*) n FROM links').get().n,
    cardMem: d.prepare('SELECT COUNT(*) n FROM card_memory').get().n,
    events: d.prepare('SELECT COUNT(*) n FROM card_events').get().n,
    testCards: d.prepare("SELECT COUNT(*) n FROM cards WHERE title LIKE ?").get(j ? PREFIX + '%' : '%').n,
    idRange: d.prepare('SELECT MIN(id) mn, MAX(id) mx FROM cards').get(),
    digest: crypto.createHash('sha256')
      .update(JSON.stringify(d.prepare('SELECT id,kind,status,title,meta FROM cards ORDER BY id').all()))
      .digest('hex'),
  };
  d.close(); return f;
}

/* ---------- 关联表计数 ---------- */
const TABLES = ['cards', 'links', 'card_memory', 'card_edges', 'card_events'];
function whCounts(db) {
  const o = {};
  for (const t of TABLES) { try { o[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { o[t] = -1; } }
  return o;
}

const R = { steps: [], assertions: {}, degraded: null };

/* ---------- ① 生产库指纹 before ---------- */
const before = prodFingerprint();
R.steps.push({ step: 1, what: '生产库指纹 before', data: before });
log('生产库 before:', j(before));

/* ---------- ② 健康确认 ---------- */
const appTok = fs.readFileSync('C:/Users/WYX/AppData/Roaming/MemoryOS/data/token', 'utf8').trim();
const whTok = fs.readFileSync('C:/Users/WYX/Desktop/MemoryOS/resources/memoryos/data/token', 'utf8').trim();
const probe = async (tok) => {
  try {
    const r = await fetch('http://127.0.0.1:8787/api/summary', { headers: { 'x-memory-token': tok } });
    return r.status;
  } catch (e) { return 'ERR:' + e.message; }
};
const hApp = await probe(appTok), hWh = await probe(whTok);
let graphNodes = -1;
try {
  const g = await (await fetch('http://127.0.0.1:8787/api/cards/graph?auto=0', { headers: { 'x-memory-token': appTok } })).json();
  graphNodes = (g.nodes || []).length;
} catch { }
R.steps.push({ step: 2, what: '8787 身份确认', appdataToken: hApp, warehouseToken: hWh, graphNodes });
log(`8787: APPDATA token=${hApp} WAREHOUSE token=${hWh} graphNodes=${graphNodes}`);
R.assertions.prodInstanceOk = (hApp === 200);
R.assertions.warehouseNotHeld = (hWh === 401);
R.assertions.graphHasProdData = (graphNodes >= 193);

/* ---------- ③ 校验待删6 张 ---------- */
const rd = new DatabaseSync(WH_DB, { readOnly: true });
const pending = rd.prepare('SELECT id,kind,status,title FROM cards WHERE title LIKE ? ORDER BY id').all(PREFIX + '%');
const allCards = rd.prepare('SELECT COUNT(*) n FROM cards').get().n;
const baseCounts = whCounts(rd);
rd.close();
R.steps.push({ step: 3, what: '校验待删', pending, allCards, baseCounts });
log('待删:', pending.length, '条; 仓内库总数:', allCards, '; 关联表:', j(baseCounts));
const allMatch = pending.length === 6 &&
  pending.every(p => String(p.title).startsWith(PREFIX) && p.kind === 'task' && p.status === 'triage');
R.assertions.pendingIs6 = (pending.length === 6);
R.assertions.allMatchPrefix = allMatch;
if (!allMatch) {
  R.assertions.abort = '待删卡片校验不符 —— 中止清理，人工确认';
  log('★ 中止：' + R.assertions.abort);
  fs.writeFileSync(path.join(OUT, 'cleanup-report.json'), j(R), 'utf8');
  process.exit(2);
}

/* ---------- ④⑤ 备份 + 离线删 ---------- */
const BK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cardtest-clean-')), 'warehouse-backup.db');
{
  const s = new DatabaseSync(WH_DB, { readOnly: true });
  s.exec(`VACUUM INTO '${BK.replace(/'/g, "''")}'`);
  s.close();
}
R.steps.push({ step: 4, what: '已备份', backup: BK, size: fs.statSync(BK).size });
log('备份完成:', BK, fs.statSync(BK).size, 'B');

const del = {};
try {
  const d = new DatabaseSync(WH_DB);   // 可写打开（openDb 无进程持有，实测 r+ 成功）
  d.exec('BEGIN IMMEDIATE');
  const ids = pending.map(p => p.id);
  const inList = ids.join(',');
  del.card_events = d.prepare(`DELETE FROM card_events WHERE card_id IN (${inList})`).run().changes;
  del.card_memory = d.prepare(`DELETE FROM card_memory WHERE card_id IN (${inList})`).run().changes;
  del.card_edges = d.prepare(`DELETE FROM card_edges WHERE source_id IN (${inList}) OR target_id IN (${inList})`).run().changes;
  del.links = d.prepare(`DELETE FROM links WHERE (src_kind='card' AND src_id IN (${inList})) OR (dst_kind='card' AND dst_id IN (${inList}))`).run().changes;
  del.cards = d.prepare(`DELETE FROM cards WHERE id IN (${inList})`).run().changes;
  d.exec('COMMIT');
  d.close();
} catch (e) {
  R.degraded = { level: 'L1-failed', error: e.message };
  log('★ L1 离线SQL 失败:', e.message);
}
R.steps.push({ step: 5, what: '离线删除结果', deleted: del });
log('删除:', j(del));

/* ---------- ⑥ 校验 ---------- */
const vd = new DatabaseSync(WH_DB, { readOnly: true });
const after = whCounts(vd);
const leftTest = vd.prepare('SELECT COUNT(*) n FROM cards WHERE title LIKE ?').get(PREFIX + '%').n;
vd.close();
R.steps.push({ step: 6, what: '清理后校验', counts: after, leftTestCards: leftTest, baseCounts });
R.assertions.deleted6 = (del.cards === 6);
R.assertions.noTestCardsLeft = (leftTest === 0);
R.assertions.linksUnchanged = (after.links === baseCounts.links);
R.assertions.cardEdgesUnchanged = (after.card_edges === baseCounts.card_edges);
R.assertions.cardMemoryUnchanged = (after.card_memory === baseCounts.card_memory);
log('清理后:', j(after), '剩余TEST卡:', leftTest);

/* ---------- ⑦ 生产库指纹 after ---------- */
const afterFp = prodFingerprint();
R.steps.push({ step: 7, what: '生产库指纹 after', data: afterFp });
const same = JSON.stringify(before) === JSON.stringify(afterFp);
R.assertions.prodUnchanged = same;
R.allGreen = Object.entries(R.assertions).filter(([k]) => k !== 'abort').every(([, v]) => v === true);
log('生产库指纹 after:', j(afterFp));
log('生产库零污染:', same ? '✅ 完全一致' : '❌ 有变化');
log('全部断言:', j(R.assertions));

fs.writeFileSync(path.join(OUT, 'cleanup-baseline.json'), j({ baseCounts, pending, backup: BK }), 'utf8');
fs.writeFileSync(path.join(OUT, 'cleanup-report.json'), j(R), 'utf8');
fs.writeFileSync(path.join(OUT, 'prod-fingerprint-before.json'), j(before), 'utf8');
fs.writeFileSync(path.join(OUT, 'prod-fingerprint-after.json'), j(afterFp), 'utf8');
log('证据已落盘 →', OUT);
process.exit(R.allGreen ? 0 : 1);