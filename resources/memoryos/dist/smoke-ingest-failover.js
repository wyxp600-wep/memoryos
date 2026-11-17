/** #700059 采集失败治理验收：退避冷却 / downgrade 真跳过 / 失败块死信不阻塞水位。仅操作临时目录。
 *
 *  为什么用「死端点」而不是 mock：本卡要证明的是「真发请求失败后」的行为，
 *  LLM_BASE_URL 指向 127.0.0.1:9（连接被拒、秒失败），比注入假 fetch 更接近 429/离线现场。
 *  隔离三件套：USERPROFILE/HOME 指向临时目录（内置源一个都匹配不到）、MEMORYOS_DATA_DIR 指向
 *  临时目录（读不到真实 config.json 的 LLM 配置）、MEMORY_SOURCES 指向临时 sources.json。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryos-ingest-failover-'));
const srcDir = path.join(dir, 'sources');
fs.mkdirSync(srcDir, { recursive: true });

process.env.USERPROFILE = dir;
process.env.HOME = dir;
process.env.EMBED_MODE = 'fake';
process.env.MEMORYOS_DATA_DIR = dir;
process.env.MEMORY_DB = path.join(dir, 'memory.db');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1'; // 连接被拒 → 每次提炼立即失败
process.env.LLM_MODEL = 'failover-smoke';
process.env.LLM_API_KEY = 'smoke';
process.env.INGEST_MAX_CALLS = '80'; // 不靠预算券触发降级，走「连续失败≥3」这条判据

const bread = (tag, n) =>
    Array.from({ length: n }, (_, i) =>
        `第 ${i} 段（${tag}）：这一段只是把源撑成多个块，内容本身无意义，但必须足够长才会被分块器切开。`.repeat(4),
    ).join('\n\n');
const fileA = path.join(srcDir, 'a.md');
const fileB = path.join(srcDir, 'b.md');
fs.writeFileSync(fileA, bread('A', 30));
fs.writeFileSync(fileB, bread('B', 4));

const sourcesJson = path.join(dir, 'sources.json');
const writeSources = (list) => fs.writeFileSync(sourcesJson, JSON.stringify({ sources: list }, null, 2));
const specA = { id: 'smoke-fail-a', path: fileA, agent: 'smoke', name: '故障源A', kind: 'memory' };
const specB = { id: 'smoke-fail-b', path: fileB, agent: 'smoke', name: '故障源B', kind: 'memory' };
writeSources([specA]);
process.env.MEMORY_SOURCES = sourcesJson;

const { openDb } = await import('./db.js');
const { ingestAll } = await import('./ingest.js');

const db = openDb(process.env.MEMORY_DB);
let passed = 0;
// getSources() 会把自定义源路径统一成正斜杠，断言按同一口径查（否则查到的是另一条 path）
const norm = (p) => String(p).replace(/\\/g, '/');
const check = async (name, fn) => {
    await fn();
    passed++;
    console.log('通过 ' + name);
};
const stateOf = (p) => db.prepare('SELECT size, mtime_ms, fail_count, next_retry_at, last_error FROM ingest_state WHERE path = ?').get(norm(p));
const deadOf = (p) => db.prepare('SELECT block, chars, fp, error, content FROM ingest_dead_letters WHERE source = ? ORDER BY id').all(norm(p));

// ── 第一轮：全部块都提炼失败（死端点）──
const r1 = await ingestAll(db, 0, {});

await check('失败块记死信且不阻塞同源后续块', () => {
    assert.ok(r1.llmFail >= 3, `应至少 3 个块失败，实际 ${r1.llmFail}`);
    assert.equal(r1.deadLetters, r1.llmFail, '死信条数应等于失败块数');
    const dead = deadOf(fileA);
    assert.equal(dead.length, r1.llmFail, '死信应逐块落库');
    assert.ok(dead.every((d) => d.block >= 0 && d.chars > 0 && d.fp && d.content), '死信需带块号/指纹/正文（可脱离原文件重放）');
    assert.ok(new Set(dead.map((d) => d.block)).size >= 3, '首块失败后后续块仍被尝试（不阻塞）');
});

await check('熔断后水位不推进（未尝试的块不得静默丢弃）', () => {
    const st = stateOf(fileA);
    assert.ok(st, '失败源也应写状态行（记退避；否则整源每轮从同一处重跑）');
    // ★ 2026-11-08（卡外 item3）：同源连续 3 块失败熔断后，剩余块**未尝试**（未消耗 LLM、也未落死信），
    //   此时推进水位等于把这部分内容永久丢弃 → 水位必须停在原处，退避到期后重跑该源。
    //   （#700059 的「失败块不阻塞后续块」仍成立：熔断阈值前的块照旧逐块尝试并落死信。）
    assert.equal(st.size, 0, '熔断跳过剩余块 → 水位不得推进到文件尾');
    assert.equal(st.fail_count, 1, '本轮失败一次 → fail_count=1');
});

await check('失败源写 next_retry_at/last_error 且为未来时间', () => {
    const st = stateOf(fileA);
    assert.match(String(st.last_error), /LLM|ECONNREFUSED|fetch failed/i, `last_error 应含失败原因，实际 ${st.last_error}`);
    const next = Date.parse(String(st.next_retry_at));
    assert.ok(Number.isFinite(next), 'next_retry_at 应为可解析时间');
    assert.ok(next > Date.now(), 'next_retry_at 应落在未来（冷却中）');
});

// ── 第二轮：冷却期内 0 次 LLM 调用 ──
const r2 = await ingestAll(db, 0, {});
await check('冷却期内整源跳过（0 次 LLM 调用）', () => {
    assert.equal(r2.skippedBackoff, 1, '冷却源应被计入 skippedBackoff');
    assert.equal(r2.llmFail, 0, '冷却期内不得再调 LLM');
    assert.equal(r2.deadLetters, 0, '冷却期内不得新增死信');
    assert.equal(deadOf(fileA).length, r1.llmFail, '死信不应因空跑增长');
});

// ── 第三轮：解除冷却后连续失败≥3 → 后续 L2 源被真正跳过 ──
db.prepare('UPDATE ingest_state SET fail_count = 0, next_retry_at = NULL, last_error = NULL WHERE path = ?').run(norm(fileA));
writeSources([specA, specB]);
const r3 = await ingestAll(db, 0, {});
await check('downgrade 档真正跳过 L2 源且计数与实际一致', () => {
    assert.equal(r3.budgetLevel, 'downgrade', `第三轮应进入 downgrade 档，实际 ${r3.budgetLevel}`);
    assert.ok(r3.budgetTerminated >= 1, '至少应终止一个 L2 源');
    assert.equal(r3.budgetTerminated, r3.terminatedSources.length, 'budgetTerminated 必须与实际跳过数一致');
    assert.ok(r3.terminatedSources.includes('故障源B'), `被终止的源应含 B，实际 ${JSON.stringify(r3.terminatedSources)}`);
    assert.equal(stateOf(fileB), undefined, '被终止的源不得被读取，也不得写水位');
});

console.log(`\n== smoke-ingest-failover：${passed} 项通过 ==`);
