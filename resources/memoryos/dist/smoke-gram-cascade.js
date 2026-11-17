/** #700062 删除记忆级联清理 memories_gram 验收：视图删除 / 直删物理表 / 幂等 / 不碰 task_gram。仅操作临时目录。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.EMBED_MODE = 'fake';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryos-gram-cascade-'));
process.env.MEMORYOS_DATA_DIR = dir;
process.env.MEMORY_DB = path.join(dir, 'memory.db');

const { openDb, writeMemory } = await import('./db.js');

const db = openDb(path.join(dir, 'memory.db'));
const raw = db.storage.raw;
const n = (sql, ...p) => Number(raw.prepare(sql).get(...p)?.n ?? 0);
const gramOf = (id) => n('SELECT count(*) n FROM memories_gram WHERE memory_id=?', id);
const orphans = () => n('SELECT count(*) n FROM memories_gram WHERE memory_id NOT IN (SELECT id FROM knowledge_records)');
const taskGram = () => n('SELECT count(*) n FROM task_store.task_gram');
const rec = (id) => n('SELECT count(*) n FROM knowledge_records WHERE id=?', id);

const seed = (text) => writeMemory(db, { type: 'experience', content: text, agent: 'human:test', agent_fpath: null, project: 'test' }).id;

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('通过 ' + name); };

await check('触发器建在主库物理表 knowledge_records（不是视图）', () => {
    const t = raw.prepare("SELECT name,tbl_name FROM main.sqlite_master WHERE type='trigger' AND name='trg_memories_gram_ad'").get();
    assert.ok(t, '触发 trg_memories_gram_ad 应已创建');
    assert.equal(t.tbl_name, 'knowledge_records', '必须挂在物理表上，视图挂不了 AFTER DELETE');
});

await check('经视图 DELETE memories 时 gram 随之清空', () => {
    const id = seed('缓存一致性检查需要级联清理二元索引');
    assert.ok(gramOf(id) > 0, '写入后应有 gram 行（夹具必须有 CJK bigram）');
    db.prepare('DELETE FROM memories WHERE id=?').run(id);
    assert.equal(rec(id), 0, '知识记录应已删除');
    assert.equal(gramOf(id), 0, '级联后该 id 的 gram 必须为 0');
});

await check('直接 SQL 删 knowledge_records 也不留孤儿', () => {
    const id = seed('绕过兼容视图直接删除物理表也要级联');
    assert.ok(gramOf(id) > 0);
    raw.prepare('DELETE FROM main.knowledge_records WHERE id=?').run(id);
    assert.equal(gramOf(id), 0, '物理表删除路径同样要级联');
    assert.equal(orphans(), 0, '库内孤儿行数应为 0');
});

await check('重复删除幂等，孤儿仍为 0', () => {
    const id = seed('幂等重跑不能报错也不能留尾');
    raw.prepare('DELETE FROM main.knowledge_records WHERE id=?').run(id);
    raw.prepare('DELETE FROM main.knowledge_records WHERE id=?').run(id);
    assert.equal(orphans(), 0);
});

await check('删记忆不触碰 task_store.task_gram', () => {
    const before = taskGram();
    const id = seed('删除知识记忆不应影响任务库的 gram 索引');
    db.prepare('DELETE FROM memories WHERE id=?').run(id);
    assert.equal(taskGram(), before, 'task_gram 行数必须保持不变');
    assert.equal(orphans(), 0);
});

console.log(`\n== smoke-gram-cascade：${passed} 项通过 ==`);
