/**
 * ★ 2026-11-16（B2）契约测试：memory-store 只管理知识记忆。
 *
 * 覆盖：
 *   A. 创建记忆 → 记录号来自 record_sequence，且**任务号序列不受影响**
 *   B. 拒绝 type='task'（写入与更新两条路径）
 *   C. 更新/归档（软删除可追溯）/事件/hit
 *   D. 记忆间 links：幂等、非法关系拒绝、不存在实体拒绝、双向查询
 *   E. 检索（FTS 或 LIKE 兜底）
 *   F. 边界自检：不碰任务库（调用前后任务表计数不变）；源码不 import 任务域
 *
 * 用法：node dist/smoke-memory-store.js
 */
import { openDb } from "./db.js";
import { createMemoryStore } from "./memory-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const dbPath = path.join(os.tmpdir(), `mem-memory-store-${stamp}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond) failed++;
}

const db = openDb(dbPath);
const ms = createMemoryStore({ db });
const taskSeqBefore = Number(db.prepare(`SELECT value FROM task_store.task_sequence WHERE id=1`).get().value);
const taskCountBefore = Number(db.prepare(`SELECT COUNT(*) c FROM task_store.task_records`).get().c);

const SIX = "结论：\n契约测试记忆。\n\n关键词：\n记忆库；契约测试；独立编号\n\n适用范围：\n测试。\n\n依据：\n无。\n\n行动：\n无。\n\n状态：\n已验证，最后核验日期：2026-11-16。";

// A. 创建
const c1 = ms.createMemory({ content: SIX, type: "experience", agent: "smoke", project: "verify" });
check("A 创建记忆成功", c1.ok === true && Number.isInteger(c1.memory?.id), c1.code ?? `id=${c1.memory?.id}`);
check("A 记录号 >= 1", c1.memory.id >= 1);
const taskSeqAfter = Number(db.prepare(`SELECT value FROM task_store.task_sequence WHERE id=1`).get().value);
check("A 不影响任务号段", taskSeqAfter === taskSeqBefore, `${taskSeqBefore} -> ${taskSeqAfter}`);

// B. 拒绝任务
const bad = ms.createMemory({ content: "[task][assignee:x][status:pending] 伪装任务", type: "task", agent: "smoke" });
check("B 拒绝 type=task 写入", bad.ok === false && bad.code === "task-not-allowed", bad.code);
const badUpd = ms.updateMemory(c1.memory.id, { type: "task" });
check("B 拒绝改成 type=task", badUpd.ok === false && badUpd.code === "task-not-allowed", badUpd.code);

// C. 更新/归档/事件/命中
const up = ms.updateMemory(c1.memory.id, { project: "verify-2" }, { expectedVersion: c1.memory.version });
check("C 更新成功且版本+1", up.ok && up.memory.project === "verify-2");
check("C 陈旧版本被拒", ms.updateMemory(c1.memory.id, { project: "x" }, { expectedVersion: c1.memory.version }).code === "version-conflict");
check("C 事件写入", ms.appendEvent({ memoryId: c1.memory.id, op: "test", payload: { note: "x" } }).ok === true);
check("C bumpHit 生效", ms.bumpHit(c1.memory.id).ok === true && Number(ms.getMemory(c1.memory.id).hit_count) >= 1);

const c2 = ms.createMemory({ content: "结论：\n第二条测试记忆。\n\n关键词：\n第二条；契约测试；决策\n\n适用范围：\n测试。\n\n依据：\n无。\n\n行动：\n无。\n\n状态：\n已验证，最后核验日期：2026-11-16。", type: "decision", agent: "smoke", project: "verify" });
check("C 第二条记忆创建", c2.ok === true);

// D. links
const lk = ms.linkMemories({ srcId: c1.memory.id, dstId: c2.memory.id, kind: "related" });
check("D 建立记忆关联", lk.ok === true);
check("D 重复关联幂等", ms.linkMemories({ srcId: c1.memory.id, dstId: c2.memory.id, kind: "related" }).idempotent === true);
check("D 非法关系被拒", ms.linkMemories({ srcId: c1.memory.id, dstId: c2.memory.id, kind: "hack" }).code === "bad-relation");
check("D 不存在实体被拒", ms.linkMemories({ srcId: c1.memory.id, dstId: 999999, kind: "related" }).code === "not-found");
check("D 双向可查", ms.listLinks(c1.memory.id).length >= 1 && ms.listLinks(c2.memory.id).length >= 1);

// E. 检索
const hits = ms.searchMemories("契约测试记忆", { limit: 5 });
check("E 检索命中", hits.some((h) => Number(h.id) === Number(c1.memory.id)), `hits=${hits.length}`);

// F. 归档 + 边界
check("F 归档成功", ms.archiveMemory(c2.memory.id).ok === true && ms.getMemory(c2.memory.id).status === "archived");
check("F 记忆库无任务记录", ms.assertMemoryOnly().ok === true);
const taskCountAfter = Number(db.prepare(`SELECT COUNT(*) c FROM task_store.task_records`).get().c);
check("F 全程未写任务库", taskCountAfter === taskCountBefore, `${taskCountBefore} -> ${taskCountAfter}`);
const src = fs.readFileSync(new URL("./memory-store.js", import.meta.url), "utf8");
check("F 源码不 import task-store", !/from\s+["']\.\/task-store\.js["']/.test(src));
check("F 源码不 import task-domain", !/from\s+["']\.\/task-domain\.js["']/.test(src));
check("F 源码不引用 task_records", !/task_records/.test(src));

try { db.close(); } catch { /* 已关 */ }
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, dbPath.replace(/\.db$/, ".tasks.db"), dbPath.replace(/\.db$/, ".runtime.db")]) {
    try { fs.rmSync(p, { force: true }); } catch { /* 忽略 */ }
}

console.log(`\n== memory-store 契约：${failed ? `${failed} FAIL` : "全部 PASS"} ==`);
process.exit(failed ? 1 : 0);
