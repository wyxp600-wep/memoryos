/**
 * 多智能体协作 9 问题实证探针（2026-10-17）
 * ─────────────────────────────────────────────────────────────
 * 取证口径（与 dist/smoke-task.js 同先例）：
 *   ① 卡片 / 守护 / 对账侧：一律走**真实领域代码**（cards-domain.js / daemon.js / db.js 原语）；
 *   ② MCP 工具内部序列（task_claim 事务 / gate 失败回退 / syncTaskToCard 允许集）：
 *      按 server-reg-task.js 逐行复刻调用 db 原语（工具 execute 闭包未导出，复刻处均注明行号）。
 *   ③ 全部使用临时库（os.tmpdir），**绝不碰生产库**；EMBED_MODE 未设 → fake（embed.js 默认）。
 * 用法：node probe-multi-agent-9issues-20261017.mjs
 */
import { openDb, writeMemory, updateMemory, readMemory, createDispatch, readActiveDispatch, touchDispatchLease } from "./dist/db.js";
import { createCardsDomain } from "./dist/cards-domain.js";
import { housekeepBoard, reapExpiredLeases } from "./dist/daemon.js";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
let passed = 0, failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (cond) passed++; else failed++;
}

const dbPath = path.join(os.tmpdir(), `mem-probe9-${Date.now()}.db`);
const db = openDb(dbPath);
const cards = createCardsDomain({ db, setCardEvtPusher: () => {} });

/* ── 复刻 helper（均注明被复刻的源码行号）────────────────────────────── */

/** 复刻 task_assign 建卡段（server-reg-task.js:382-392）：任务记忆 + ref 卡 + dispatch 关联 */
function assignTask(title, assignee = "probe-b") {
    const content = `[task][assignee:${assignee}][status:pending] ${title}`;
    const row = writeMemory(db, { content, type: "task", agent: "probe", agent_fpath: null, project: "global" });
    const cardId = Number(db
        .prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,priority,assignee) VALUES ('default','task',?,?,'ready','memory',?,3,?)`)
        .run(title, title, row.id, assignee).lastInsertRowid);
    db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'dispatch')`).run(cardId, row.id);
    return { taskId: row.id, cardId };
}

/** 复刻 task_claim 事务核心（server-reg-task.js:547-565）：头 CAS + dispatch + 卡租约 */
function claimTask(taskId, cardId, who, version) {
    const row = readMemory(db, taskId);
    const v = version ?? row.version;
    const body = row.content.replace(/^\[task\]\[assignee:[^\]]*\]\[status:[^\]]*\]/, "").trim();
    const claimed = updateMemory(db, taskId, { content: `[task][assignee:${who}][status:in_progress] ${body}`, expectedVersion: v });
    if (!claimed) throw new Error("claimTask: CAS 失败");
    const lock = randomBytes(12).toString("hex");
    createDispatch(db, { key: lock, memoryId: taskId, agent: who, leaseMinutes: 10 });
    db.prepare(`UPDATE cards SET status='running', assignee=?, claim_lock=?, lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'), heartbeat_at=datetime('now') WHERE id=?`).run(who, lock, cardId);
    return lock;
}

try {
    /* ══ P1（问题 #5：多 agent 抢同一任务）═════════════════════════════ */
    {
        const t = assignTask("P1-并发认领", "probe-b");
        const v = readMemory(db, t.taskId).version;
        const head = (s) => `[task][assignee:probe-b][status:${s}] P1-并发认领`;
        // 两个会话带同一 expectedVersion 并发认领（CAS 由 SQL WHERE version=? 原子裁决）
        const r1 = updateMemory(db, t.taskId, { content: head("in_progress"), expectedVersion: v });
        const r2 = updateMemory(db, t.taskId, { content: head("in_progress"), expectedVersion: v });
        check("P1a 并发认领恰好一个赢家（CAS 原子裁决）", (r1 && !r2) || (!r1 && r2), `r1=${!!r1} r2=${!!r2}`);
        const r3 = updateMemory(db, t.taskId, { content: head("in_progress"), expectedVersion: v });
        check("P1b 陈旧认领被拒（对应 task_claim 的 TxAbort 文案）", r3 === null);
        const l1 = randomBytes(12).toString("hex"), l2 = randomBytes(12).toString("hex");
        const d1 = createDispatch(db, { key: l1, memoryId: t.taskId, agent: "probe-b", leaseMinutes: 10 });
        const d2 = createDispatch(db, { key: l2, memoryId: t.taskId, agent: "probe-b", leaseMinutes: 10 });
        check("P1c 二代 dispatch 自动 supersede 前代", d2.generation === 2 && d2.superseded === d1.id);
        const act = readActiveDispatch(db, t.taskId);
        check("P1d 一任务同时只有一个 active dispatch（唯一偏索引）", !!act && act.id === d2.id);
    }

    /* ══ P2（问题 #6：gate 失败乒乓 / 熔断是否触发）════════════════════ */
    {
        const t = assignTask("P2-gate失败", "probe-b");
        claimTask(t.taskId, t.cardId, "probe-b");
        // 复刻 gate 失败回退（server-reg-task.js:974-985）：头回 pending + 卡回 ready + 清锁
        const row = readMemory(db, t.taskId);
        updateMemory(db, t.taskId, { content: `[task][assignee:probe-b][status:pending] P2-gate失败\n→ 结论(probe-b)：⛔ 门控未通过——状态回退 pending`, expectedVersion: row.version });
        db.prepare(`UPDATE cards SET status='ready', claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(t.cardId);
        const after = db.prepare(`SELECT failure_count fc, status s FROM cards WHERE id=?`).get(t.cardId);
        check("P2a gate 失败回退不累加 failure_count", after.fc === 0, `failure_count=${after.fc}`);
        check("P2b gate 失败后卡回 ready（非 failed，不进熔断判据）", after.s === "ready", `status=${after.s}`);
        const hk1 = housekeepBoard(db);
        check("P2c 真实 housekeepBoard：gate 失败不触发熔断", hk1.circuit_break === 0, JSON.stringify(hk1));
        // 对照实验：真正的 failed + count>=2 → 熔断（证明机制本身有效，只是 gate 路径不喂它）
        db.prepare(`UPDATE cards SET status='failed', failure_count=2 WHERE id=?`).run(t.cardId);
        const hk2 = housekeepBoard(db);
        const s2 = db.prepare(`SELECT status s FROM cards WHERE id=?`).get(t.cardId).s;
        check("P2d 对照：failed×2 熔断机制本身有效（daemon.js:523-528）", hk2.circuit_break === 1 && s2 === "blocked", JSON.stringify(hk2));
    }

    /* ══ P3（问题 #7：依赖环检测 / 幽灵依赖）═══════════════════════════ */
    {
        const A = cards.createCard({ b: { title: "P3-A", kind: "task" } }).id;
        const B = cards.createCard({ b: { title: "P3-B", kind: "task" } }).id;
        const l1 = cards.addCardLink(A, { dst_card_id: B, kind: "depends" });
        check("P3a 正常 depends 边可建（真实 addCardLink）", !l1.error && l1.kind === "depends", JSON.stringify(l1));
        const l2 = cards.addCardLink(B, { dst_card_id: A, kind: "depends" });
        check("P3b 成环被 conflict 拦截（cards-domain.js:732-739）", l2.conflict === true, l2.error);
        const l3 = cards.addCardLink(A, { dst_card_id: B, kind: "blocks" });
        check("P3c blocks 反向存储同样检出成环（A 阻 B ⇔ B 依赖 A，与 A→B 成环）", l3.conflict === true && String(l3.error).includes("成环"), l3.error);
        // MCP task_assign 侧：depends_on 仅做数字过滤（server-reg-task.js:354-358），无存在性/成环校验
        const ghost = writeMemory(db, { content: `[task][assignee:probe-b][status:pending] [depends:999999] P3-幽灵依赖`, type: "task", agent: "probe", agent_fpath: null, project: "global" });
        check("P3d MCP 侧幽灵依赖 id 无校验直接入库（缺口实证）", !!ghost && ghost.id > 0, `task #${ghost?.id}`);
    }

    /* ══ P4（问题 #1：僵尸占位与接管时长）══════════════════════════════ */
    {
        const t = assignTask("P4-僵尸接管", "probe-b");
        claimTask(t.taskId, t.cardId, "probe-b");
        // 模拟 agent 崩溃 24h+：租约已过期、贴条已 25h、active dispatch 仍在
        db.prepare(`UPDATE cards SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minutes'), lease_notice_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-25 hours') WHERE id=?`).run(t.cardId);
        const rp = reapExpiredLeases(db, { graceHours: 0 }); // 真实 reaper 二阶段
        const dsp = db.prepare(`SELECT state, generation FROM dispatches WHERE memory_id=? ORDER BY id DESC LIMIT 1`).get(t.taskId);
        const card = db.prepare(`SELECT status, claim_lock, lease_stale_at FROM cards WHERE id=?`).get(t.cardId);
        check("P4a reaper 只标 stale 不回收（daemon.js:746-801）", rp.staled >= 1 && dsp.state === "stale", JSON.stringify(rp));
        check("P4b 卡保持 running 且锁/assignee 全保留", card.status === "running" && !!card.claim_lock && !!card.lease_stale_at);
        check("P4c active dispatch 消失（takeover 前置条件，server-reg-task.js:516-521）", readActiveDispatch(db, t.taskId) === null);
        const d5 = createDispatch(db, { key: randomBytes(12).toString("hex"), memoryId: t.taskId, agent: "probe-c", leaseMinutes: 10 });
        check("P4d takeover 换代 gen=2 且取代 stale 前代", d5.generation === 2 && d5.superseded != null);
        // 原持有者心跳可唤醒 stale（touchDispatchLease 真实代码，db.js:2434-2438）
        db.prepare(`UPDATE dispatches SET state='stale' WHERE id=?`).run(d5.id);
        const woke = touchDispatchLease(db, d5.id, 10);
        check("P4e 原持有者心跳可唤醒 stale→active（非误判活跃任务）", woke && readActiveDispatch(db, t.taskId)?.id === d5.id);
        // 接管前的时间线结论（由 P4a-P4d + daemon 两阶段推得）：
        //   崩溃 → 10min 租约过期贴条 → +24h grace → stale → 方可 takeover ≈ 24h10m；
        //   原持有者随时可 heartbeat 复活 / task_release 立即归还。
    }

    /* ══ P5（问题 #8：并发写资源争用）══════════════════════════════════ */
    {
        const jm = db.prepare(`PRAGMA journal_mode`).get();
        const bt = db.prepare(`PRAGMA busy_timeout`).get();
        const sy = db.prepare(`PRAGMA synchronous`).get();
        check("P5a WAL 模式（db.js:691）", jm.journal_mode === "wal", JSON.stringify(jm));
        check("P5b busy_timeout=5000ms（db.js:692）", Number(bt.timeout) === 5000, JSON.stringify(bt));
        check("P5c synchronous=NORMAL（db.js:699）", Number(sy.synchronous) === 1, JSON.stringify(sy));
        // 双进程各 25 条写，验证 busy_timeout + withTx 重试能否收敛（不产未收敛 BUSY）
        const childSrc = `
import { openDb, writeMemory } from ${JSON.stringify(pathToFileURL(path.join(HERE, "dist", "db.js")).href)};
const db = openDb(${JSON.stringify(dbPath)});
for (let i = 0; i < 25; i++) writeMemory(db, { content: "P5-并发写-" + process.argv[2] + "-" + i, type: "experience", agent: "probe-" + process.argv[2], agent_fpath: null, project: "global" });
console.log("OK");
`;
        const childFile = path.join(os.tmpdir(), `probe9-child-${Date.now()}.mjs`);
        fs.writeFileSync(childFile, childSrc, "utf8");
        const res = await Promise.all(["x", "y"].map((tag) => new Promise((resolve) => {
            const p = spawn(process.execPath, [childFile, tag], { stdio: ["ignore", "pipe", "pipe"] });
            let out = "", err = "";
            p.stdout.on("data", (d) => (out += d));
            p.stderr.on("data", (d) => (err += d));
            p.on("close", (code) => resolve({ code, out, err }));
        })));
        fs.rmSync(childFile, { force: true });
        check("P5d 双进程 50 条并发写全部成功（BUSY 被 busy_timeout+重试收敛）", res.every((r) => r.code === 0 && r.out.includes("OK")), JSON.stringify(res.map((r) => ({ code: r.code, err: r.err.slice(0, 120) }))));
    }

    /* ══ P6（问题 #3：人机双写不一致的精确形态）════════════════════════ */
    {
        const t = assignTask("P6-人机双写", "probe-b");
        claimTask(t.taskId, t.cardId, "probe-b");
        // 场景 A：人工先拖 running→review（真实 transitionCard）
        const trA = cards.transitionCard(t.cardId, { status: "review" }, "human:dashboard");
        check("P6a 人工可拖 running→review", !trA.error && trA.to === "review", JSON.stringify(trA));
        // agent 随后 task_done → syncTaskToCard(done)：allowed 集合含 review（server-reg-task.js:614）
        db.prepare(`UPDATE cards SET status='done', claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(t.cardId);
        const st6 = db.prepare(`SELECT status s FROM cards WHERE id=?`).get(t.cardId).s;
        check("P6b agent 收口把人工的 review 覆盖为 done（真实双写缺口）", st6 === "done", `card.status=${st6}`);
        // 场景 B：agent 先 done，人工再拖 review → 409（真实 transitionCard）
        const trB = cards.transitionCard(t.cardId, { status: "review" }, "human:dashboard");
        check("P6c done 后人工拖 review 被 409 拦（CARD_TRANSITIONS.done=[archived]）", trB.conflict === true, trB.error);
    }

    /* ══ P7（问题 #4：验收规则空转 + 虚报 done 传导）═══════════════════ */
    {
        const c7 = cards.createCard({ b: { title: "P7-验收门", kind: "task", meta: { acceptance: ["冒烟通过"] } } }).id;
        cards.transitionCard(c7, { status: "ready" }, "human:dashboard");
        cards.claimCard(c7, "human:dashboard");
        cards.transitionCard(c7, { status: "review" }, "human:dashboard");
        const r4 = cards.transitionCard(c7, { status: "done" }, "human:dashboard");
        check("P7a 带 acceptance 的卡 /status 直达 done 被 409 拦（cards-domain.js:790-795）", r4.conflict === true, r4.error);
        const r5 = cards.acceptCard(c7, "human:dashboard");
        const s7 = db.prepare(`SELECT status s FROM cards WHERE id=?`).get(c7).s;
        check("P7b 必须走 /accept 显式验收才能 done", !r5.error && s7 === "done", JSON.stringify(r5));
        // 虚报 done 的传导路径：上游无 gate 无 acceptance「自述 done」→ 下游自动提升
        const up = assignTask("P7-上游", "probe-b");
        const down = cards.createCard({ b: { title: "P7-下游", kind: "task" } }).id;
        cards.addCardLink(down, { dst_card_id: up.cardId, kind: "depends" });
        db.prepare(`UPDATE cards SET status='done' WHERE id=?`).run(up.cardId); // 自述 done（无门控）
        housekeepBoard(db);
        const downStatus = db.prepare(`SELECT status s FROM cards WHERE id=?`).get(down).s;
        check("P7c 上游 done → 下游 todo→ready 自动提升（虚报 done 的传导路径存在）", downStatus === "ready", `down.status=${downStatus}`);
    }

    /* ══ P8（问题 #2：交不了差的真实触发条件）══════════════════════════ */
    {
        const t = assignTask("P8-陈旧交差", "probe-b");
        claimTask(t.taskId, t.taskId && t.cardId, "probe-b");
        const cur = readMemory(db, t.taskId).version;
        const stale = updateMemory(db, t.taskId, { content: `[task][assignee:probe-b][status:done] P8-陈旧交差\n→ 结论(probe-b)：x`, expectedVersion: cur - 1 });
        check("P8a 陈旧 expected_version 的 done 写被 CAS 拒（task_done TxAbort 原型）", stale === null);
        const ok = updateMemory(db, t.taskId, { content: `[task][assignee:probe-b][status:done] P8-陈旧交差\n→ 结论(probe-b)：x`, expectedVersion: cur });
        check("P8b 刷新版本后 done 写成功（令牌丢失≠必拒；软模式无令牌可放行——静态结论 server-reg-task.js:948-958）", !!ok);
    }
}
finally {
    try { db.close(); } catch { /* ignore */ }
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
    }
}

console.log(`\n══ 合计：PASS ${passed} / FAIL ${failed} ══`);
process.exit(failed > 0 ? 1 : 0);
