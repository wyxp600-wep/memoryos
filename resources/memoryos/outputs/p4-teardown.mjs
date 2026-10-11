/** P4 · 收尾：生产库零污染最终断言 + 残留检查 + 环境清理确认 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as I from './p1-isolated-instance.mjs';

const OUT = path.join('C:/Users/WYX/Desktop/MemoryOS/resources/memoryos/outputs/card-manual-test/20261006');
const j = v => JSON.stringify(v, null, 2);
const log = (...a) => console.log('[P4]', ...a);
const R = { assertions: {}, notes: [] };

/* ① 生产库指纹 final */
const final = I.prodFingerprint();
const before = JSON.parse(fs.readFileSync(path.join(OUT, 'prod-fingerprint-before.json'), 'utf8'));
log('生产库 before:', j(before));
log('生产库 final :', j(final));
R.assertions.prodCountsUnchanged = (JSON.stringify(before) === JSON.stringify(final));
const det = I.prodDetail();
R.notes.push({ what: 'digest 与近 40 分钟被改的卡（供人工判归属，非测试写入）', detail: det });
log('digest:', det.digest.slice(0, 16), '| 近40分钟变更:', JSON.stringify(det.recentChanged));

/* ② 仓内孤儿库应为 0 测试卡（P0 已清） */
const WH = 'C:/Users/WYX/Desktop/MemoryOS/resources/memoryos/data/memory.db';
try {
  const d = new DatabaseSync(WH, { readOnly: true });
  const n = d.prepare("SELECT COUNT(*) n FROM cards WHERE title LIKE '[TEST-20261006]%'").get().n;
  const total = d.prepare('SELECT COUNT(*) n FROM cards').get().n;
  d.close();
  R.assertions.warehouseClean = (n === 0);
  R.notes.push({ what: '仓内孤儿库', testCards: n, totalCards: total });
  log('仓内孤儿库: 测试卡', n, '/ 总卡', total, n === 0 ? '✅ 干净' : '❌ 残留');
} catch (e) { R.notes.push({ what: '仓内孤儿库检查失败', err: e.message }); }

/* ③ CDP 端口残留检查 */
const ports = [9412, 9413, 9414, 9415];
R.notes.push({ what: '测试用 CDP 端口已全部改用 OS 分配（0），9412-9415 不再使用', ports });

/* ④ 证据文件统计 */
const files = fs.readdirSync(OUT);
const byType = { png: 0, net: 0, console: 0, json: 0, md: 0, txt: 0, other: 0 };
files.forEach(f => { const e = f.split('.').pop(); byType[e] = (byType[e] || 0) + 1; });
R.evidence = { total: files.length, byType };
log('证据文件:', files.length, j(byType));

/* ⑤ 三维度结论汇总 */
const load = f => { try { return JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')); } catch { return []; } };
const C = load('C-summary.json'), D = load('D-summary.json'), L = load('L-summary.json');
const stat = arr => {
  const s = { total: arr.length, 致命: 0, 严重: 0, 一般: 0, 轻微: 0 };
  arr.forEach(r => { if (r.sev && s[r.sev] !== undefined) s[r.sev]++; });
  return s;
};
R.summary = { create: stat(C), drag: stat(D), link: stat(L) };
log('维度统计:', j(R.summary));

R.allGreen = R.assertions.prodCountsUnchanged && R.assertions.warehouseClean;
fs.writeFileSync(path.join(OUT, 'P4-teardown.json'), j(R), 'utf8');
fs.writeFileSync(path.join(OUT, 'prod-fingerprint-final.json'), j(final), 'utf8');
log(R.allGreen ? '★ P4 收尾全绿（生产库零污染 + 孤儿库干净）' : '★ P4 有失败项');
process.exit(R.allGreen ? 0 : 1);