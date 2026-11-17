/**
 * #700061 冒烟：任务终态后兜底结算残留工作证（reconcile 第三段对账）
 *
 * 覆盖：
 *   A. 软模式完成（不传 dispatch_key）→ 工作证仍 active；reconcile 后置 settled、active 残留 0、daemon_log 留 1 条
 *   B. 同一任务重复对账 → 不重复写 settle 事件（幂等）
 *   C. 非终态任务（in_progress/blocked/pending）的过期工作证**不被**结算（防越界切断 heartbeat/takeover）
 *   D. task_next「待决策」段：对账前出现过期占位，对账后不再出现
 *   E. 回归：原有两条对账（状态对齐 / 无卡补建）行为不变
 *
 * 用法：node dist/smoke-dispatch-settle.js（smoke-all 自动发现）
 */
import { openDb } from "./db.js";
import { assignTaskDomain, claimTaskDomain, doneTaskDomain, readTaskState, taskBody, nextTasks, renderTaskNextText } from "./task-domain.js";
import { reconcileTasksAndCards } from "./reconcile.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const dbPath = path.join(os.tmpdir(), `mem-dispatch-settle-${stamp}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
const ctx = {
    db: null,
    agentName: () => "trae",
    agentFpath: () => null,
    envCredential: () => null,
    isCredentialValid: () => true,
    nowIso: () => new Date().toISOString(),
    requestAbortSignal: () => null,
    killTree: () => { },
    readTaskState,
    taskBody,
};
const idOf = (receipt) => Number(String(receipt).match(/#(\d+)/)?.[1]);
const dspOf = (db, id) => db.prepare(`SELECT id, state, outcome, evidence, settled_at FROM dispatches WHERE memory_id=? ORDER BY generation DESC, id DESC LIMIT 1`).get(id);
const settleLogs = (db, id) => db.prepare(`SELECT count(*) n FROM daemon_log WHERE task='reconcile' AND op='settle' AND memory_id=?`).get(id).n;
const expire = (db, id) => db.prepare(`UPDATE dispatches SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') WHERE memory_id=? AND state='active'`).run(id);

try {
    const db = openDb(dbPath);
    ctx.db = db;

    /* ── A. 软模式完成 → 残留 active → reconcile 结算 ── */
    const a = await assignTaskDomain(ctx, { content: "终态任务的工作证要自己收尾", assignee: "trae", project: "global" });
    const aId = idOf(a);
    const claimed = await claimTaskDomain(ctx, { memory_id: aId, project: "global" });
    const aDsp = dspOf(db, aId);
    check("A1. 认领后工作证 active", aDsp?.state === "active", JSON.stringify({ state: aDsp?.state, claimed: String(claimed).slice(0, 60) }));
    expire(db, aId);
    const doneA = await doneTaskDomain(ctx, { memory_id: aId, conclusion: "交付完成（软模式不传 dispatch_key）" });
    check("A2. 不传 dispatch_key 也能完成", readTaskState(db.prepare(`SELECT content FROM memories WHERE id=?`).get(aId).content)?.status === "done", String(doneA).split("\n")[0]);
    check("A3. 完成后工作证仍 active（复现根因）", dspOf(db, aId)?.state === "active");
    const beforeTxt = renderTaskNextText(nextTasks(ctx, { project: "global" }));
    check("A4. 对账前 task_next 待决策段出现该任务过期占位", beforeTxt.includes(`#${aId} `) && beforeTxt.includes("工作证过期"), beforeTxt.split("\n").find((l) => l.includes(`#${aId} `)) ?? "");
    const r1 = reconcileTasksAndCards(db);
    check("A5. reconcile 结算终态任务工作证（settled≥1）", r1.settled >= 1, JSON.stringify(r1));
    const aAfter = dspOf(db, aId);
    check("A6. 该任务工作证置 settled + outcome=succeeded + settled_at 非空", aAfter?.state === "settled" && aAfter?.outcome === "succeeded" && !!aAfter?.settled_at, JSON.stringify({ state: aAfter?.state, outcome: aAfter?.outcome, at: aAfter?.settled_at }));
    check("A7. 该任务 active 残留 = 0", db.prepare(`SELECT count(*) n FROM dispatches WHERE memory_id=? AND state='active'`).get(aId).n === 0);
    check("A8. daemon_log 记 1 条 reconcile/settle", settleLogs(db, aId) === 1, String(settleLogs(db, aId)));
    check("A9. evidence 记录原持有者与旧租约", String(aAfter?.evidence ?? "").includes("task_terminal") && String(aAfter?.evidence ?? "").includes("previous_lease_expires_at"), String(aAfter?.evidence ?? "").slice(0, 120));
    const afterTxt = renderTaskNextText(nextTasks(ctx, { project: "global" }));
    check("A10. 对账后 task_next 待决策段不再出现该终态任务", !afterTxt.split("\n").some((l) => l.includes(`#${aId} `)), afterTxt.split("\n").find((l) => l.includes(`#${aId} `)) ?? "(无)");

    /* ── B. 幂等：再对账两次不重复写 settle ── */
    const r2 = reconcileTasksAndCards(db);
    const r3 = reconcileTasksAndCards(db);
    check("B1. 重复对账 settled=0", r2.settled === 0 && r3.settled === 0, JSON.stringify({ r2, r3 }));
    check("B2. settle 事件仍只有 1 条", settleLogs(db, aId) === 1, String(settleLogs(db, aId)));

    /* ── C. 非终态任务不被结算 ── */
    const c = await assignTaskDomain(ctx, { content: "受阻任务的工作证要留给人裁决", assignee: "trae", project: "global" });
    const cId = idOf(c);
    await claimTaskDomain(ctx, { memory_id: cId, project: "global" });
    expire(db, cId);
    const r4 = reconcileTasksAndCards(db);
    check("C1. in_progress + 过期工作证 → 不被 reconcile 结算", dspOf(db, cId)?.state === "active", JSON.stringify({ state: dspOf(db, cId)?.state, settled: r4.settled }));
    check("C2. 也没有写它的 settle 事件", settleLogs(db, cId) === 0, String(settleLogs(db, cId)));
    const cTxt = renderTaskNextText(nextTasks(ctx, { project: "global" }));
    check("C3. 非终态任务的过期工作证仍在待决策段（可见不隐藏）", cTxt.split("\n").some((l) => l.includes(`#${cId}`) && l.includes("工作证过期")), cTxt.split("\n").find((l) => l.includes(`#${cId}`) && l.includes("工作证过期")) ?? "(未出现)");

    /* ── D. 存量归档/合并态也覆盖（列 status 判据） ── */
    const d = await assignTaskDomain(ctx, { content: "归档任务遗留工作证", assignee: "trae", project: "global" });
    const dId = idOf(d);
    await claimTaskDomain(ctx, { memory_id: dId, project: "global" });
    db.prepare(`UPDATE memories SET status='archived' WHERE id=?`).run(dId);
    reconcileTasksAndCards(db);
    check("D1. 记忆列 archived（头仍 in_progress）也结算", dspOf(db, dId)?.state === "settled", String(dspOf(db, dId)?.state));

    /* ── E. 回归：原有两条对账不变 ── */
    const e1 = await assignTaskDomain(ctx, { content: "回归：卡态与任务头失配要对齐", assignee: "trae", project: "global" });
    const e1Id = idOf(e1);
    db.prepare(`UPDATE cards SET status='running' WHERE ref_kind='memory' AND ref_id=?`).run(e1Id);
    const rAlign = reconcileTasksAndCards(db);
    const e1Card = db.prepare(`SELECT status FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(e1Id);
    check("E1. 状态对齐回归：pending 头 + running 卡 → 卡回到 ready", rAlign.aligned >= 1 && e1Card?.status === "ready", JSON.stringify({ aligned: rAlign.aligned, card: e1Card?.status }));
    const e2 = await assignTaskDomain(ctx, { content: "回归：无卡任务要补建卡", assignee: "trae", project: "global" });
    const e2Id = idOf(e2);
    db.prepare(`DELETE FROM card_memory WHERE memory_id=?`).run(e2Id);
    db.prepare(`DELETE FROM cards WHERE ref_kind='memory' AND ref_id=?`).run(e2Id);
    const rOrphan = reconcileTasksAndCards(db);
    const e2Card = db.prepare(`SELECT id FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(e2Id);
    check("E2. 补建卡回归：无卡 pending 任务重建投影", rOrphan.created >= 1 && !!e2Card, JSON.stringify({ created: rOrphan.created, card: e2Card?.id ?? null }));

    db.close();
} catch (e) {
    console.log(`FAIL  冒烟异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    failed++;
}
for (const f of [dbPath, dbPath.replace(/\.db$/, ".tasks.db"), dbPath.replace(/\.db$/, ".runtime.db"), dbPath + "-wal", dbPath + "-shm"]) {
    try { fs.rmSync(f, { force: true }); } catch { }
}
console.log(`\n== smoke-dispatch-settle：${failed === 0 ? "全部 PASS" : failed + " 项 FAIL"} ==`);
process.exit(failed === 0 ? 0 : 1);
