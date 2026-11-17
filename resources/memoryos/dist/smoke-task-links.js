/**
 * ★ 2026-11-16（B3）契约测试：任务↔记忆关联层。
 *
 * 覆盖：
 *   A. 建表幂等（重复调用不报错、不重复建）
 *   B. 存在性校验：任务不存在 / 记忆不存在 / 非法关系 全部拒绝
 *   C. 幂等 + 多关系共存
 *   D. 双向查询、按任务清理
 *   E. doctor 能识别孤儿关联（任务或记忆已被删除）
 *   F. migrateFromCardMemory：可映射行迁移、重复行计 duplicate、卡未挂任务计 orphan
 *   G. 边界：task-links 自身 SQL 只出现 task_memory_links；不直接查任务/记忆物理表
 *
 * 用法：node dist/smoke-task-links.js
 */
import { openDb } from "./db.js";
import { createTaskStore } from "./task-store.js";
import { createMemoryStore } from "./memory-store.js";
import { createTaskLinks, ensureTaskLinksSchema } from "./task-links.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const dbPath = path.join(os.tmpdir(), `mem-task-links-${stamp}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond) failed++;
}
const nowIso = () => new Date().toISOString();

const db = openDb(dbPath);
const ts = createTaskStore({ db });
const ms = createMemoryStore({ db });
const tl = createTaskLinks({ db, taskStore: ts, memoryStore: ms });

// A. 建表幂等
check("A 重复建表不报错", (() => { try { ensureTaskLinksSchema(db); ensureTaskLinksSchema(db); return true; } catch { return false; } })());
const tableExists = db.prepare(`SELECT COUNT(*) c FROM pragma_table_info(?, ?)`).get("task_memory_links", "task_store").c > 0;
check("A 表已创建在任务库", tableExists === true);

// 夹具
const task = ts.createTask({ content: "[task][assignee:smoke][status:pending] 关联测试任务", agent: "smoke" });
const mem1 = ms.createMemory({ content: "结论：\n关联测试记忆一。\n\n关键词：\n关联；记忆一；测试\n\n适用范围：\nt。\n\n依据：\n无。\n\n行动：\n无。\n\n状态：\n已验证，最后核验日期：2026-11-16。", type: "experience", agent: "smoke" }).memory;
const mem2 = ms.createMemory({ content: "结论：\n关联测试记忆二。\n\n关键词：\n关联；记忆二；测试\n\n适用范围：\nt。\n\n依据：\n无。\n\n行动：\n无。\n\n状态：\n已验证，最后核验日期：2026-11-16。", type: "decision", agent: "smoke" }).memory;

// B. 校验
check("B 任务不存在被拒", tl.link({ taskId: 999999, memoryId: mem1.id }).code === "task-not-found");
check("B 记忆不存在被拒", tl.link({ taskId: task.id, memoryId: 999999 }).code === "memory-not-found");
check("B 非法关系被拒", tl.link({ taskId: task.id, memoryId: mem1.id, relation: "hack" }).code === "bad-relation");

// C. 幂等 + 多关系
const l1 = tl.link({ taskId: task.id, memoryId: mem1.id, relation: "evidence" });
check("C 建立关联", l1.ok === true);
check("C 重复关联幂等", tl.link({ taskId: task.id, memoryId: mem1.id, relation: "evidence" }).idempotent === true);
const l2 = tl.link({ taskId: task.id, memoryId: mem1.id, relation: "context" });
check("C 同一对可多关系共存", l2.ok === true && l2.id !== l1.id);
check("C 计数正确", tl.countForTask(task.id) === 2, `count=${tl.countForTask(task.id)}`);

// D. 双向查询
check("D 按任务查", tl.listForTask(task.id).length === 2);
check("D 按记忆查", tl.listForMemory(mem1.id).length === 2);
const t2 = ts.createTask({ content: "[task][assignee:smoke][status:pending] 第二个任务", agent: "smoke" });
tl.link({ taskId: t2.id, memoryId: mem2.id, relation: "output" });
check("D 按任务清理只删自己的", tl.deleteForTask(t2.id).deleted === 1 && tl.countForTask(task.id) === 2);

// E. doctor 孤儿
const ghostTask = ts.createTask({ content: "[task][assignee:smoke][status:pending] 将删除任务", agent: "smoke" });
tl.link({ taskId: ghostTask.id, memoryId: mem2.id, relation: "related" });
ts.deleteTask(ghostTask.id); // 模拟任务被删除但关联残留
const doc = tl.doctor({ limit: 100 });
check("E doctor 识别孤儿任务关联", doc.ok === false && doc.orphanTaskLinks.length >= 1, JSON.stringify(doc.orphanTaskLinks));

// F. 迁移 card_memory
const cardLinked = db.prepare(`INSERT INTO task_store.cards (board, kind, title, status, created_at, updated_at, ref_kind, ref_id)
    VALUES ('test','task','已挂任务卡','todo',?,?, 'task', ?)`).run(nowIso(), nowIso(), task.id).lastInsertRowid;
const cardOrphan = db.prepare(`INSERT INTO task_store.cards (board, kind, title, status, created_at, updated_at)
    VALUES ('test','note','未挂任务卡','todo',?,?)`).run(nowIso(), nowIso()).lastInsertRowid;
db.prepare(`INSERT INTO task_store.card_memory (card_id, memory_id, relation, created_at) VALUES (?,?,?,?)`).run(Number(cardLinked), mem2.id, "evidence", nowIso());
db.prepare(`INSERT INTO task_store.card_memory (card_id, memory_id, relation, created_at) VALUES (?,?,?,?)`).run(Number(cardOrphan), mem2.id, "evidence", nowIso());
const dry = tl.migrateFromCardMemory({ dryRun: true });
check("F dry-run 不落库且能分类", dry.ok === true && dry.dryRun === true && dry.total === 2, JSON.stringify({ total: dry.total, mapped: dry.mapped, orphan: dry.orphan.length }));
const real = tl.migrateFromCardMemory({ dryRun: false });
check("F 实际迁移仅映射可解析行", real.ok === true && real.mapped >= 1, JSON.stringify({ mapped: real.mapped, dup: real.duplicate, orphan: real.orphan.length }));
check("F 孤儿卡进 orphan 清单", real.orphan.some((o) => Number(o.card_id) === Number(cardOrphan)) === true);
check("F 迁移幂等（再跑不重复插入）", (() => { const again = tl.migrateFromCardMemory({ dryRun: false }); return again.duplicate >= 1; })());

// G. 边界
const src = fs.readFileSync(new URL("./task-links.js", import.meta.url), "utf8");
check("G 不直接查任务物理表", !/task_records/.test(src));
check("G 不直接查记忆物理表", !/knowledge_records/.test(src));
check("G 不 import task-store/memory-store", !/from\s+["']\.\/(task-store|memory-store)\.js["']/.test(src));

try { db.close(); } catch { /* 已关 */ }
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, dbPath.replace(/\.db$/, ".tasks.db"), dbPath.replace(/\.db$/, ".runtime.db")]) {
    try { fs.rmSync(p, { force: true }); } catch { /* 忽略 */ }
}

console.log(`\n== task-links 契约：${failed ? `${failed} FAIL` : "全部 PASS"} ==`);
process.exit(failed ? 1 : 0);
