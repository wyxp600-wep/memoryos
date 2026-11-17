/** #700060 整组备份保留策略验收：保 7 移旧 / 不碰非 storage-* / 移走可校验可还原。仅操作临时目录。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.EMBED_MODE = 'fake';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryos-retention-'));
process.env.MEMORYOS_DATA_DIR = dir;
process.env.MEMORY_DB = path.join(dir, 'memory.db');

const { openDb, writeMemory } = await import('./db.js');
const { backupStorage, pruneBackups, validateBundle, restoreBundle } = await import('./storage.js');

const dbFile = path.join(dir, 'memory.db');
const db = openDb(dbFile);
writeMemory(db, { type: 'experience', content: '保留策略冒烟夹具', agent: 'human:test', agent_fpath: null, project: 'test' });
const root = path.join(dir, 'backup');

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('通过 ' + name); };
const utc = (d) => new Date(Date.UTC(2026, 0, d));

// 造 9 份「合法整组备份」（keep=99 → 生成期不触发保留），加两份非 storage-* 目录，再加一份损坏包
for (let d = 1; d <= 9; d++) backupStorage(db, dbFile, { now: utc(d), keep: 99 });
fs.mkdirSync(path.join(root, 'hotupdate-2026-01-01'), { recursive: true });
fs.writeFileSync(path.join(root, 'hotupdate-2026-01-01', 'app.asar'), 'fake');
fs.mkdirSync(path.join(root, '手工备份-别动我'), { recursive: true });
fs.mkdirSync(path.join(root, 'storage-2025-12-30'), { recursive: true });
fs.writeFileSync(path.join(root, 'storage-2025-12-30', 'manifest.json'), JSON.stringify({ version: 1, identity: 'x', members: [] }));

const r1 = pruneBackups(root, { keep: 7, now: utc(20) });

await check('9 份合法包按日期保留最近 7 份', () => {
    assert.equal(r1.kept.length, 7);
    assert.deepEqual(r1.kept, ['storage-2026-01-09', 'storage-2026-01-08', 'storage-2026-01-07', 'storage-2026-01-06',
        'storage-2026-01-05', 'storage-2026-01-04', 'storage-2026-01-03'], '应保留最新 7 份且倒序');
});

await check('最旧 2 份被移走而非删除', () => {
    assert.deepEqual(r1.removed.sort(), ['storage-2026-01-01', 'storage-2026-01-02']);
    for (const n of r1.removed) assert.equal(fs.existsSync(path.join(root, n)), false, '原目录应已不在 backup/');
    assert.ok(fs.existsSync(path.join(r1.pendingRoot, 'storage-2026-01-01', 'manifest.json')), '应落在待删区');
    assert.equal(path.dirname(r1.pendingRoot), dir, '待删区必须与 backup 同盘同级');
});

await check('移走的包仍可通过 validateBundle 校验', () => {
    for (const n of r1.removed) assert.equal(validateBundle(path.join(r1.pendingRoot, n)).version, 1);
});

await check('移走的包可原路还原成可用整组', () => {
    const target = path.join(dir, 'restored-01-01');
    const mainFile = restoreBundle(path.join(r1.pendingRoot, 'storage-2026-01-01'), target);
    assert.ok(fs.existsSync(mainFile));
    assert.equal(fs.readdirSync(target).filter((f) => f.endsWith('.db')).length, 3, '应还原出三库');
});

await check('hotupdate-*、手工目录、损坏包一律不动', () => {
    assert.ok(fs.existsSync(path.join(root, 'hotupdate-2026-01-01', 'app.asar')), 'hotupdate 不得被保留策略误伤');
    assert.ok(fs.existsSync(path.join(root, '手工备份-别动我')), '手工目录不得被误伤');
    assert.ok(fs.existsSync(path.join(root, 'storage-2025-12-30')), '校验不通过的包应原样保留');
    const bad = r1.skipped.find((s) => s.name === 'storage-2025-12-30');
    assert.ok(bad && /校验未通过/.test(bad.reason), '跳过原因应写明校验未通过');
});

const r2 = backupStorage(db, dbFile, { now: utc(10), keep: 7 });
await check('backupStorage 自动执行保留且 removed 不再恒为空', () => {
    assert.ok(r2.created && fs.existsSync(r2.created), '第 10 份应生成');
    assert.deepEqual(r2.removed, ['storage-2026-01-03'], '超出 7 份的最旧一份应被移走');
    assert.equal(fs.readdirSync(root).filter((f) => /^storage-\d{4}-\d{2}-\d{2}$/.test(f)).length, 8, 'backup/ 只剩 7 份 + 损坏包 1 份');
});

console.log(`\n== smoke-backup-retention：${passed} 项通过 ==`);
