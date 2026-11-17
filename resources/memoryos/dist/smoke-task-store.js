/**
 * ★ 2026-11-16（B1）契约测试：task-store 只管理任务域。
 *
 * 覆盖：
 *   A. 创建任务 → 任务号来自 task_sequence，且**记录号序列不受影响**
 *   B. 读取/更新（含 CAS 版本冲突）/删除
 *   C. 任务事件、dispatch generation 单调递增、settle/release 只作用于 active
 *   D. 任务头部解析
 *   E. 检索（FTS 或 LIKE 兜底）
 *   F. 边界自检：任务库无非任务记录；源码不 import memory-store / task-links
 *
 * 用法：node dist/smoke-task-store.js
 */
import { openDb } from "./db.js";
import { createTaskStore } from "./task-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const dbPath = path.join(os.tmpdir(), `mem-task-store-${stamp}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond) failed++;
}

const db = openDb(dbPath);
const ts = createTaskStore({ db });
const recordSeqBefore = Number(db.prepare(`SELECT value FROM main.record_sequence WHERE id=1`).get().value);

// A. 创建
const created = ts.createTask({
    content: "[task][assignee:smoke][status:pending] 契约测试任务\n\n验证 task-store 独立编号",
    agent: "smoke",
    project: "verify",
});
check("A 创建任务返回 id", Number.isInteger(created?.id), `id=${created?.id}`);
check("A 任务号 >= 700000（独立号段）", created.id >= 700000, `id=${created.id}`);
const recordSeqAfter = Number(db.prepare(`SELECT value FROM main.record_sequence WHERE id=1`).get().value);
check("A 不影响记忆号段", recordSeqAfter === recordSeqBefore, `${recordSeqBefore} -> ${recordSeqAfter}`);
check("A type 固定为 task", created.type === "task");

// B. 读/更新/删除
const got = ts.getTask(created.id);
check("B getTask 命中", got?.id === created.id);
const up = ts.updateTask(created.id, { project: "verify-2" }, { expectedVersion: got.version });
check("B 正常更新成功且版本+1", up.ok && up.task.project === "verify-2" && Number(up.task.version) === Number(got.version) + 1);
const stale = ts.updateTask(created.id, { project: "x" }, { expectedVersion: got.version });
check("B 陈旧版本被拒（CAS）", stale.ok === false && stale.code === "version-conflict", stale.code);
const tmp = ts.createTask({ content: "[task][assignee:smoke][status:pending] 待删除", agent: "smoke" });
check("B 删除成功", ts.deleteTask(tmp.id).ok === true && ts.getTask(tmp.id) === null);

// C. 事件 / dispatch
const ev = ts.appendEvent({ memoryId: created.id, op: "claim", payload: { by: "smoke" }, operator: "smoke" });
check("C 事件写入", ev.ok && Number.isInteger(ev.id));
check("C 事件可查", ts.listEvents(created.id).length >= 1);
const d1 = ts.createDispatch({ key: "a".repeat(32), memoryId: created.id, agent: "smoke" });
const d2 = ts.createDispatch({ key: "b".repeat(32), memoryId: created.id, agent: "smoke" });
check("C dispatch generation 单调 +1", Number(d2.generation) === Number(d1.generation) + 1, `${d1.generation} -> ${d2.generation}`);
check("C 新一代取代旧 active", d2.superseded === d1.id && d1.id !== d2.id, `superseded=${d2.superseded}`);
check("C readActiveDispatch 取最新", Number(ts.readActiveDispatch(created.id).id) === Number(d2.id));
check("C settle 只作用于 active", ts.settleDispatch(d2.id, "succeeded") === true && ts.settleDispatch(d2.id, "succeeded") === false);
check("C release 已结算则失败", ts.releaseDispatch(d2.id) === false);

// D. 头部解析
const head = ts.parseHead(created.id);
check("D 头解析 assignee/status", head.assignee === "smoke" && head.status === "pending", JSON.stringify(head));

// E. 检索
const hits = ts.searchTasks("契约测试");
check("E 检索命中新建任务", hits.some((h) => Number(h.id) === Number(created.id)), `hits=${hits.length}`);

// F. 边界
check("F 任务库无非任务记录", ts.assertTaskOnly().ok === true);
const src = fs.readFileSync(new URL("./task-store.js", import.meta.url), "utf8");
check("F 源码不 import memory-store", !/from\s+["']\.\/memory-store\.js["']/.test(src));
check("F 源码不 import task-links", !/from\s+["']\.\/task-links\.js["']/.test(src));
const codeOnly = src.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");
check("F 代码不引用 knowledge_records（注释豁免）", !/knowledge_records/.test(codeOnly));
check("F stats 可读", ts.stats().tasks >= 1, JSON.stringify(ts.stats()));

try { db.close(); } catch { /* 已关 */ }
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.rmSync(p, { force: true }); } catch { /* 句柄未释放 */ } }
for (const p of [dbPath.replace(/\.db$/, ".tasks.db"), dbPath.replace(/\.db$/, ".runtime.db")]) { try { fs.rmSync(p, { force: true }); } catch { /* 忽略 */ } }

console.log(`\n== task-store 契约：${failed ? `${failed} FAIL` : "全部 PASS"} ==`);
process.exit(failed ? 1 : 0);
