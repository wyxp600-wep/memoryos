/**
 * ★ 2026-11-16（B4 组4）契约测试：检索域边界 —— 记忆检索不再返回任务，任务检索只返回任务。
 *
 * 背景：`temp.memories` 跨库 UNION 视图让 `memory_search` 历史上能检到任务。
 *   组4 把检索链路改为只查 `main.knowledge_records`，本测试锁定该行为，防止日后被视图回归带回去。
 *
 * 覆盖：
 *   A. hybridSearch（记忆主检索）不返回任务 id
 *   B. taskStore.searchTasks 只返回任务 id
 *   C. memoryStore.searchMemories 只返回记忆 id
 *   D. 同一关键词在两侧都能各自命中（证明不是"都查不到"）
 *
 * 用法：node dist/smoke-search-scope.js
 */
import { openDb } from "./db.js";
import { hybridSearch } from "./search.js";
import { getEmbedder } from "./embed.js";
import { createTaskStore } from "./task-store.js";
import { createMemoryStore } from "./memory-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const dbPath = path.join(os.tmpdir(), `mem-scope-${stamp}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond) failed++;
}

const KEY = "边界词甲";
const SIX = `结论：\n${KEY} 只属于记忆域的测试条目。\n\n关键词：\n边界词甲；检索隔离；契约\n\n适用范围：\n检索域边界测试。\n\n依据：\n无。\n\n行动：\n无。\n\n状态：\n已验证，最后核验日期：2026-11-16。`;

const db = openDb(dbPath);
const ts = createTaskStore({ db });
const ms = createMemoryStore({ db });

const mem = ms.createMemory({ content: SIX, type: "experience", agent: "scope-smoke", project: "verify" }).memory;
const task = ts.createTask({ content: `[task][assignee:scope-smoke][status:pending] ${KEY} 只属于任务域的测试任务`, agent: "scope-smoke", project: "verify" });

check("夹具：记忆与任务均已创建", Number.isInteger(mem?.id) && Number.isInteger(task?.id), `mem=${mem?.id} task=${task?.id}`);

const emb = await getEmbedder();
const hits = await hybridSearch(db, emb, { query: `${KEY} 边界测试`, project: "verify", limit: 20, minScore: 0 });
const ids = hits.map((h) => Number(h.id));
check("A hybridSearch 不返回任务", !ids.includes(Number(task.id)), `ids=${ids.slice(0, 8).join(",")}`);
check("D hybridSearch 仍能命中记忆", ids.includes(Number(mem.id)), `ids=${ids.slice(0, 8).join(",")}`);

const taskHits = ts.searchTasks(KEY, { limit: 10 });
check("B 任务检索只返回任务", taskHits.length >= 1 && taskHits.every((h) => Number(h.id) >= 700000), `hits=${taskHits.length}`);
check("D 任务检索命中本任务", taskHits.some((h) => Number(h.id) === Number(task.id)));

const memHits = ms.searchMemories(KEY, { limit: 10 });
check("C 记忆检索只返回记忆", memHits.length >= 1 && memHits.every((h) => Number(h.id) < 700000), `hits=${memHits.length}`);
check("D 记忆检索命中本条", memHits.some((h) => Number(h.id) === Number(mem.id)));

try { db.close(); } catch { /* 已关 */ }
for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, dbPath.replace(/\.db$/, ".tasks.db"), dbPath.replace(/\.db$/, ".runtime.db")]) {
    try { fs.rmSync(p, { force: true }); } catch { /* 忽略 */ }
}
console.log(`\n== 检索域边界：${failed ? `${failed} FAIL` : "全部 PASS"} ==`);
process.exit(failed ? 1 : 0);
