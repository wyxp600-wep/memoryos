/**
 * MemoryOS — memory_events 任务事件 180 天保质期冒烟
 *
 * 覆盖三条硬断言（用户 2026-11-07 指定）：
 *   E1 超期 + 非活任务的事件 → 被导出、入归档表、并从主表删除；
 *   E2 超期但任务仍 in_progress 的 task_claim → **不删**（活任务免死，核心断言）；
 *   E3 导出 jsonl 行数 === 删除行数 === 归档表新增行数。
 *
 * 另测：pending 任务的「最近一条任意事件」也免死（lastEvtOf 依赖）；分批边界（batch=2 跑 3 行）。
 * 用法：node dist/smoke-task-events-ttl.js
 */
import { openDb } from "./db.js";
import { archiveTaskEvents } from "./daemon.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const dbPath = path.join(os.tmpdir(), `memoryos-smoke-evttl-${Date.now()}.db`);
const jsonl = path.join(os.tmpdir(), `memoryos-smoke-evttl-${Date.now()}.jsonl`);
let failed = 0;
const check = (name, cond, detail = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
};

try {
    const db = openDb(dbPath);
    const card = (id, status, title) =>
        db.prepare(`INSERT INTO task_store.task_records(id, content, type, agent, project, status, created_at)
                    VALUES (?,?,?,?,?,?,?)`).run(id, `[task][assignee:smoke][status:${status}] ${title}`, "task", "smoke", "smoke", "active", "2025-01-01T00:00:00.000Z");
    const evt = (memoryId, op, at, extra = {}) =>
        db.prepare(`INSERT INTO main.memory_events(memory_id, op, payload, operator, created_at) VALUES (?,?,?,?,?)`)
            .run(memoryId, op, JSON.stringify(extra), "smoke", at);

    const old = (d) => new Date(Date.now() - d * 86400000).toISOString();
    // T1：已终态（done）——三条都超期，应被全部归档删除
    card(900001, "done", "旧已完成任务");
    evt(900001, "task_assign", old(200), { a: 1 });
    evt(900001, "task_done", old(199), { b: 2 });
    evt(900001, "task_archive", old(198), { c: 3 });
    // T2：进行中 —— 旧的 task_claim 与旧的最近事件都免死
    card(900002, "in_progress", "长期在做的任务");
    evt(900002, "task_claim", old(300), { session_id: "sess-live" });
    evt(900002, "task_note", old(200), { note: "最近一条" });
    // T3：待认领 —— 只有一条超期事件，属「最近一条任意事件」，免死
    card(900003, "pending", "待认领旧任务");
    evt(900003, "task_assign", old(250), { d: 4 });

    const res = archiveTaskEvents(db, { ttlDays: 180, batch: 2, jsonlPath: jsonl });
    const left = (id) => Number(db.prepare(`SELECT COUNT(*) n FROM main.memory_events WHERE memory_id=?`).get(id).n);
    const arch = (id) => Number(db.prepare(`SELECT COUNT(*) n FROM memory_events_archive WHERE memory_id=?`).get(id).n);
    const lines = fs.existsSync(jsonl) ? fs.readFileSync(jsonl, "utf8").trim().split("\n").filter(Boolean).length : 0;
    const totalArch = Number(db.prepare(`SELECT COUNT(*) n FROM memory_events_archive`).get().n);

    // E1
    check("E1a 终态任务的 3 条超期事件已从主表删除", left(900001) === 0, `剩余 ${left(900001)}`);
    check("E1b 终态任务的 3 条事件已进归档表", arch(900001) === 3, `归档 ${arch(900001)}`);
    // E2（核心）
    check("E2a 进行中任务的旧 task_claim 未被删", left(900002) === 2, `剩余 ${left(900002)} 条`);
    check("E2b 该 claim 仍是可读的原行", Number(db.prepare(`SELECT COUNT(*) n FROM main.memory_events WHERE memory_id=? AND op='task_claim'`).get(900002).n) === 1);
    check("E2c 进行中任务的「最近一条任意事件」同样免死", Number(db.prepare(`SELECT COUNT(*) n FROM main.memory_events WHERE memory_id=? AND op='task_note'`).get(900002).n) === 1);
    check("E2d 待认领任务的唯一超期事件免死", left(900003) === 1, `剩余 ${left(900003)}`);
    check("E2e 白名单计数可回报", res.protected_claims === 1 && res.protected_last === 2, JSON.stringify(res));
    // E3
    check("E3a jsonl 行数 === 删除行数", lines === res.archived, `jsonl ${lines} / deleted ${res.archived}`);
    check("E3b 归档表新增行数 === 删除行数", totalArch === res.archived, `archive ${totalArch} / deleted ${res.archived}`);
    check("E3c 分批生效（3 行 / 每批 2 行）", res.archived === 3, `archived ${res.archived}`);

    // 幂等：再跑一次不应再删任何行
    const again = archiveTaskEvents(db, { ttlDays: 180, batch: 2, jsonlPath: jsonl });
    check("E4 二次执行幂等（无可归档行）", again.archived === 0, `第二次 archived=${again.archived}`);
    db.close();
} catch (e) {
    console.log(`FAIL  异常：${e instanceof Error ? e.message : String(e)}`);
    failed++;
} finally {
    for (const p of [dbPath, dbPath.replace(/\.db$/, ".tasks.db"), dbPath.replace(/\.db$/, ".runtime.db"), jsonl])
        try { fs.existsSync(p) && fs.unlinkSync(p); } catch { /* 忽略 */ }
}
console.log(failed ? `\nFAILED ${failed}` : "\nALL PASS");
process.exit(failed ? 1 : 0);
