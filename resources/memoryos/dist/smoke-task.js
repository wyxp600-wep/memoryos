/**
 * 任务交接状态机单测（db 层，与 server.js 三工具同源逻辑）
 * 复刻工具内约定：content 头 `[task][assignee:X][status:open|claimed|done]`
 * 用例：T1 写好头 + FTS 可检索；T2 open→claimed；T3 claimed→done；T4 非法任务不匹配
 * 用法：node dist/smoke-task.js
 */
import { openDb, writeMemory, readMemory, createDispatch, readActiveDispatch, readDispatchByKey, settleDispatch } from "./db.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
const dbPath = path.join(os.tmpdir(), `mem-task-${Date.now()}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
// 与 server.js 同源（保持口径一致）
const TASK_HEAD_RE = /^\[task\]\[assignee:[^\]]*\]\[status:(open|claimed|done)\]/;
const TASK_DEP_RE = /\[depends:([0-9,\s]+)\]/;
const taskHead = (s, a) => `[task][assignee:${a}][status:${s}]`;
function readState(c) {
    const m = c.match(TASK_HEAD_RE);
    if (!m)
        return null;
    const am = c.match(/\[assignee:([^\]]*)\]/);
    const dm = c.match(TASK_DEP_RE);
    const deps = dm ? dm[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : [];
    return { assignee: am ? am[1] : "?", status: m[1], deps };
}
// 依赖满足判定（同 task_next 可做集判据）：依赖中所有 id 都在 done 集合里
function depsSatisfied(deps, done) {
    return deps.every((d) => done.has(d));
}
try {
    const db = openDb(dbPath);
    const r = writeMemory(db, {
        content: `${taskHead("open", "codex")} 排查 Ozon API scope 未开通导致 404`,
        type: "task", agent: "trae", agent_fpath: null, project: "global",
    });
    // T1: 状态头正确 + FTS 可检索（LIKE 兜底）
    const st1 = readState(r.content);
    check("T1.open 状态头正确", st1?.status === "open" && st1?.assignee === "codex", JSON.stringify(st1));
    const hit = db.prepare(`SELECT COUNT(*) c FROM memories_fts WHERE content LIKE '%Ozon%'`).get().c;
    check("T1.FTS 可检索", hit >= 1, `fts=${hit}`);
    // T2: open→claimed（updateMemory 同步 FTS）
    const claimed = `${taskHead("claimed", "codex")} ${r.content.replace(TASK_HEAD_RE, "").trim()}`;
    db.prepare(`UPDATE memories SET content=? WHERE id=?`).run(claimed, r.id);
    db.prepare(`UPDATE memories_fts SET content=? WHERE rowid=?`).run(claimed, r.id);
    const st2 = readState(readMemory(db, r.id).content);
    check("T2.claimed 状态头", st2?.status === "claimed", JSON.stringify(st2));
    // T3: claimed→done
    const done = `${taskHead("done", "codex")} ${claimed.replace(TASK_HEAD_RE, "").trim()}\n→ 结论：scope 未开通，需向平台申请权限`;
    db.prepare(`UPDATE memories SET content=? WHERE id=?`).run(done, r.id);
    db.prepare(`UPDATE memories_fts SET content=? WHERE rowid=?`).run(done, r.id);
    const doneRow = readMemory(db, r.id);
    const st3 = readState(doneRow.content);
    check("T3.done 状态头 + 结论追加", st3?.status === "done" && doneRow.content.includes("结论"), `status=${st3?.status}`);
    // T4: 非任务语法不匹配
    check("T4.普通记忆不误匹配任务头", readState("这是一条普通记忆") === null);
    // T4b: 状态非法不匹配
    check("T4b.非法状态不匹配", readState(`${taskHead("open", "x").replace("open", "bogus")} y`) === null);
    // T5: 依赖头解析（A 无依赖，B 依赖 A）
    const a = writeMemory(db, { content: `${taskHead("open", "codex")} 设计接口`, type: "task", agent: "trae", agent_fpath: null, project: "global" });
    const b = writeMemory(db, { content: `${taskHead("open", "claude")} [depends:${a.id}] 实现接口`, type: "task", agent: "trae", agent_fpath: null, project: "global" });
    const stA = readState(readMemory(db, a.id).content);
    const stB = readState(readMemory(db, b.id).content);
    check("T5.depends 头解析", stB?.deps.length === 1 && stB.deps[0] === a.id && stA?.deps.length === 0, `Adeps=${stA?.deps} Bdeps=${stB?.deps}`);
    // T6: 依赖拓扑可做集判据——B 依赖 A，A 未 done 则 B 不可做；A done 后 B 可做
    const doneIds = new Set();
    check("T6a.A 未完成 → B 依赖不满足", depsSatisfied(stB.deps, doneIds) === false);
    doneIds.add(a.id);
    check("T6b.A 完成后 → B 依赖满足(可做)", depsSatisfied(stB.deps, doneIds) === true);
    // T7: 依赖段在 claim/done 状态流转中保留（body replace 不丢 depends）
    const b2 = writeMemory(db, { content: `${taskHead("open", "claude")} [depends:${a.id}] 写测试`, type: "task", agent: "trae", agent_fpath: null, project: "global" });
    const claimedB2 = `${taskHead("claimed", "claude")} [depends:${a.id}] 写测试`;
    db.prepare(`UPDATE memories SET content=? WHERE id=?`).run(claimedB2, b2.id);
    db.prepare(`UPDATE memories_fts SET content=? WHERE rowid=?`).run(claimedB2, b2.id);
    const stB2 = readState(readMemory(db, b2.id).content);
    check("T7.状态流转保留 depends", stB2?.status === "claimed" && stB2.deps.includes(a.id), JSON.stringify(stB2));
    // ── ★ 2026-10-02 Dispatch 语义（对标 orca「one authoritative Task attempt」）──
    //   权威只来自 active dispatch；idx_dispatches_active 机器保证「一任务同时只有一个 active 尝试」。
    const dt = writeMemory(db, { content: `${taskHead("open", "codex")} dispatch 语义样例`, type: "task", agent: "trae", agent_fpath: null, project: "global" });
    const d1 = createDispatch(db, { key: "aaaa1111bbbb", memoryId: dt.id, agent: "codex", sessionId: "sess-1", credentialId: null, leaseMinutes: 10 });
    check("T8a.首次 dispatch 建 active（generation=1）", d1.generation === 1 && d1.superseded === null, JSON.stringify(d1));
    const ac1 = readActiveDispatch(db, dt.id);
    check("T8b.readActiveDispatch 命中且带会话身份", ac1?.dispatch_key === "aaaa1111bbbb" && ac1?.session_id === "sess-1" && ac1?.state === "active", JSON.stringify({ k: ac1?.dispatch_key, s: ac1?.session_id }));
    const d2 = createDispatch(db, { key: "cccc2222dddd", memoryId: dt.id, agent: "claude", leaseMinutes: 10 });
    check("T8c.二次认领=接管（generation=2 + 旧被取代）", d2.generation === 2 && d2.superseded === d1.id, JSON.stringify(d2));
    const old1 = readDispatchByKey(db, "aaaa1111bbbb");
    check("T8d.旧 dispatch 已 superseded 且指向新代", old1?.state === "superseded" && old1?.superseded_by === d2.id, JSON.stringify({ s: old1?.state, by: old1?.superseded_by }));
    const ac2 = readActiveDispatch(db, dt.id);
    check("T8e.同一任务同时只有一个 active", ac2?.dispatch_key === "cccc2222dddd", String(ac2?.dispatch_key));
    const staleSettle = settleDispatch(db, d1.id, "succeeded", "越权结算");
    check("T8f.对已 superseded 的 dispatch 结算被拒（权威只来自 active）", staleSettle === false);
    const okSettle = settleDispatch(db, d2.id, "succeeded", "task_done by claude");
    const settled = readDispatchByKey(db, "cccc2222dddd");
    check("T8g.active dispatch 结算成功（outcome 落库）", okSettle === true && settled?.state === "settled" && settled?.outcome === "succeeded", JSON.stringify({ s: settled?.state, o: settled?.outcome }));
    const d3 = createDispatch(db, { key: "eeee3333ffff", memoryId: dt.id, agent: "codex", leaseMinutes: 10 });
    check("T8h.结算后再认领 generation 单调递增（不复用旧世代）", d3.generation === 3 && d3.superseded === null, JSON.stringify(d3));
    settleDispatch(db, d3.id, "whatever", null);
    check("T8i.outcome 归一（非 failed 一律 succeeded）", readDispatchByKey(db, "eeee3333ffff")?.outcome === "succeeded");
    db.close();
}
finally {
    for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"])
        try {
            fs.rmSync(p, { force: true });
        }
        catch { }
}
console.log(failed === 0 ? "\n== ALL PASS ==" : `\n== ${failed} FAILED =="`);
process.exit(failed === 0 ? 0 : 1);
