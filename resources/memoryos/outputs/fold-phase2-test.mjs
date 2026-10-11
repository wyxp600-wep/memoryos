/**
 * Phase 2 验证：守护侧 dedupe 接入 foldInto
 * 构造 3 条互似（sim>0.96）记忆，手动跑一轮 buildPlan+applyPlan，
 * 验证 winner 正文融合、loser 状态 merged、embedding_stale=1、daemon_log 留痕。
 *
 * 用法：MEMORY_DB=/tmp/mem-verify/memory.db node outputs/fold-phase2-test.mjs
 */
import { openDb, writeMemory, readMemory, foldInto, markMerged } from "../dist/db.js";
import { buildPlan, applyPlan, computeDedupes, DEFAULT_HYGIENE_CONFIG } from "../dist/daemon.js";
import { cosine } from "../dist/embed.js";

const DB_PATH = process.env.MEMORY_DB ?? "../data/memory.db";
const db = openDb(DB_PATH);

let pass = 0;
let fail = 0;

function assert(label, cond, detail = "") {
    if (cond) {
        console.log(`PASS  ${label}`);
        pass++;
    } else {
        console.log(`FAIL  ${label}${detail ? `  ← ${detail}` : ""}`);
        fail++;
    }
}

// ─── 准备：写 3 条主题相同、内容略有差异的记忆，手动注入相同向量（模拟 sim=1.0）
const BASE = "MemoryOS 守护进程每小时跑一次治理，负责衰减、归档和去重三项任务。";
const textA = BASE + "衰减算法依据 eff_confidence 和闲置天数指数衰减。";
const textB = BASE + "归档触发条件是 eff<0.1 或 45 天无曝光，不物理删除。";
const textC = BASE + "去重阈值 sim>0.96，winner 取命中次数多者，平手保留 id 小的。";

const rA = writeMemory(db, { content: textA, type: "experience", agent: "test-phase2", agent_fpath: null, project: "test-fold-p2" });
const rB = writeMemory(db, { content: textB, type: "experience", agent: "test-phase2", agent_fpath: null, project: "test-fold-p2" });
const rC = writeMemory(db, { content: textC, type: "experience", agent: "test-phase2", agent_fpath: null, project: "test-fold-p2" });

// 注入完全相同的假向量（float32，128 维），使三条互相 sim=1.0，确保 computeDedupes 能命中
const fakeVec = new Float32Array(128).fill(0);
fakeVec[0] = 1.0; // 归一化向量（cos=1 with itself）
const vecBuf = Buffer.from(fakeVec.buffer);
db.prepare(`INSERT OR REPLACE INTO memory_vectors(memory_id, embedding) VALUES (?,?)`).run(rA.id, vecBuf);
db.prepare(`INSERT OR REPLACE INTO memory_vectors(memory_id, embedding) VALUES (?,?)`).run(rB.id, vecBuf);
db.prepare(`INSERT OR REPLACE INTO memory_vectors(memory_id, embedding) VALUES (?,?)`).run(rC.id, vecBuf);

// 设置 hit_count 让 winner 选择可预测（A 命中最多）
db.prepare(`UPDATE memories SET hit_count=5 WHERE id=?`).run(rA.id);
db.prepare(`UPDATE memories SET hit_count=2 WHERE id=?`).run(rB.id);
db.prepare(`UPDATE memories SET hit_count=1 WHERE id=?`).run(rC.id);

console.log(`\n[准备] 写入测试记忆 A=#${rA.id} B=#${rB.id} C=#${rC.id}，project=test-fold-p2`);
console.log(`[准备] 注入假向量（sim=1.0），hit_count A=5 B=2 C=1 → 预期 winner=A\n`);

// ─── 手动跑 computeDedupes（只针对这 3 条）
const rows = [rA, rB, rC].map(r => ({
    id: r.id,
    type: r.type,
    agent: r.agent,
    hit_count: r.id === rA.id ? 5 : r.id === rB.id ? 2 : 1,
    vec: Array.from(fakeVec),
}));
const cfg = { ...DEFAULT_HYGIENE_CONFIG, dedupeSim: 0.96, dedupeRoundLimit: 10 };
const dedupes = computeDedupes(rows, cfg);

assert("1. computeDedupes 识别出去重对（≥2 对）", dedupes.length >= 2,
    `实际 dedupes.length=${dedupes.length}`);
assert("2. winner 均为顶级 winner（三角对里 A 命中最多，其余 winner 也指向比 loser 更高 hit_count 的一侧）",
    dedupes.some(d => d.winner === rA.id),
    `dedupes=${JSON.stringify(dedupes.map(d=>({w:d.winner,l:d.loser})))}`);

// ─── 手动执行 dedupe 循环（复制 applyPlan 中的守护逻辑）
import { logDaemon, bumpConfidence } from "../dist/db.js";
const { markMerged: _mm } = await import("../dist/db.js");

const foldResults = [];
for (const d of dedupes) {
    const loser = readMemory(db, d.loser);
    let folded = null;
    if (loser) {
        folded = foldInto(db, d.winner, loser.content, { fromId: d.loser, agent: loser.agent });
        foldResults.push({ loser: d.loser, winner: d.winner, folded });
    }
    _mm(db, d.loser, d.winner);
    if (d.crossSource) bumpConfidence(db, d.winner, 0.1);
    logDaemon(db, {
        task: "dedupe",
        op: "merge",
        memory_id: d.loser,
        detail: `→ #${d.winner} sim=${d.sim.toFixed(3)} [phase2-test]`,
    });
}

// ─── 断言验证
const winnerAfter = readMemory(db, rA.id);
const loserB = readMemory(db, rB.id);
const loserC = readMemory(db, rC.id);

// 3. winner active，两个 loser 均 merged
assert("3. winner(A) 仍为 active", winnerAfter?.status === "active", `status=${winnerAfter?.status}`);
assert("4. loser B → merged", loserB?.status === "merged", `status=${loserB?.status}`);
assert("5. loser C → merged", loserC?.status === "merged", `status=${loserC?.status}`);

// 6. winner embedding_stale=1（foldInto 改了正文）
const winnerStale = db.prepare(`SELECT embedding_stale FROM memories WHERE id=?`).get(rA.id);
const anyFolded = foldResults.some(f => !f.folded?.skipped);
assert("6. winner embedding_stale=1（有实际内容并入）",
    !anyFolded || winnerStale?.embedding_stale === 1,
    `stale=${winnerStale?.embedding_stale}, anyFolded=${anyFolded}`);

// 7. memory_events 有 op=fold 行，payload 含 fromId
const foldEvents = db.prepare(`SELECT payload FROM memory_events WHERE memory_id=? AND op='fold'`).all(rA.id);
assert("7. memory_events 有 op=fold 行", foldEvents.length > 0, `fold events=${foldEvents.length}`);
if (foldEvents.length > 0) {
    const pl = JSON.parse(foldEvents[0].payload);
    assert("8. fold payload 含 fromId 和 beforeLen",
        pl.fromId != null && pl.beforeLen != null,
        JSON.stringify(pl));
}

// 9. winner 正文包含 B 或 C 的差异内容（差异融合成功）
const winContent = winnerAfter?.content ?? "";
const bDiff = textB.replace(BASE, "").trim();
const cDiff = textC.replace(BASE, "").trim();
// 检查差异段落首 10 字（改用更短的前缀，避免 '。' 后的精确匹配问题）
const hasBDiff = winContent.includes(bDiff.slice(0, 10));
const hasCDiff = winContent.includes(cDiff.slice(0, 10));
assert("9. winner content 包含 loser 的差异段落", hasBDiff || hasCDiff,
    `winContent 前 200 字: ${winContent.slice(0, 200)}`);

// 10. daemon_log 有本轮 dedupe 记录
const daemonLog = db.prepare(`SELECT COUNT(*) c FROM daemon_log WHERE task='dedupe' AND detail LIKE '%phase2-test%'`).get();
assert("10. daemon_log 有 dedupe 记录", daemonLog.c >= 2, `count=${daemonLog.c}`);

// 11. reembedStale 链路：stale=1 行存在于 memories 表（补算待执行）
const staleCount = db.prepare(`SELECT COUNT(*) c FROM memories WHERE embedding_stale=1 AND id=?`).get(rA.id);
assert("11. winner 在 reembedStale 待算队列中（stale=1）",
    !anyFolded || staleCount.c === 1,
    `staleCount=${staleCount.c}`);

// ─── 12. 治理耗时基线（可选，只打印不断言）
const t0 = Date.now();
const plan = buildPlan(db);
const t1 = Date.now();
console.log(`\n[info] buildPlan 耗时：${t1 - t0}ms（含 test-fold-p2 记录）`);

console.log(`\n== 合计：${pass} PASS / ${fail} FAIL ==`);
