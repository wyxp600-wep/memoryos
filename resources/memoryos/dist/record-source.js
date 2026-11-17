/**
 * ★ 2026-11-17（B8/解耦）：显式跨库查询接口 —— `temp.memories` UNION 视图的唯一替代方案。
 *
 * 为什么需要这个模块
 * ─────────────────
 * 旧实现用一个 TEMP VIEW 把两库「伪装」成一个 `memories` 表，谁都能写 `FROM memories`，
 * 于是 100+ 处代码在不知道自己在跨库的情况下跨库读写。要删视图，就必须把这些点改成
 * **显式声明查哪一侧**。但如果让每个调用方各自拼 `main.knowledge_records` /
 * `task_store.task_records`，表名会散落全仓，等于把隐式耦合换成显式重复。
 *
 * 本模块是**除 task-links 之外唯一允许出现两张物理表名的地方**：
 *   · 调用方只表达意图（scope: 'memory' | 'task' | 'both'）；
 *   · 表名解析、Union 拼接、旧库降级全部收敛在这里；
 *   · 其余模块禁止直接引用 MEMORY_TABLE / TASK_TABLE。
 *
 * 与旧视图的差异（重要）
 * ─────────────────────
 *   · 视图：全局存在、隐式可写、任何 SQL 自动跨库 —— 删除后无法回退到「不知道在跨库」。
 *   · 本接口：按调用点声明 scope，`scope='both'` 才产生 UNION；写操作不在此模块
 *     （写必须走 createMemoryRow / createTaskRow，见 memory-writer / task-writer）。
 *
 * 设计取舍
 * ───────
 *   A. 只做「源片段」不做通用仓储：36 处里有大量 JOIN（卡片↔记录、链接↔记录），
 *      通用 query() 无法表达；recordsFrom() 返回可直接拼进 FROM/JOIN 的片段，
 *      改动量与「换表名」同级，风险最低。
 *   B. 同时给 5 个高频简单形态的便捷方法（count/list/get/exists/tableOf），
 *      避免调用方为了一个 COUNT 也去拼 SQL。
 *   C. 旧库降级：没有 task_store 时 scope='task' 返回一个空集子查询而不是抛错，
 *      让 merge-db / 迁移场景仍能跑（与 daemon 的双表分流口径一致）。
 */
import { TASK_TABLE, MEMORY_TABLE, MEMORY_VECTORS, TASK_VECTORS, TASK_FTS, TASK_GRAM, MEMORY_GRAM } from "./record-tables.js";

export { TASK_TABLE, MEMORY_TABLE, MEMORY_VECTORS, TASK_VECTORS, TASK_FTS, TASK_GRAM, MEMORY_GRAM };

const SCOPES = new Set(["memory", "task", "both"]);

function assertScope(scope) {
    if (!SCOPES.has(scope)) throw new Error(`record-source: 非法 scope=${scope}（只允许 memory/task/both）`);
}

/**
 * 表存在性缓存：一次探测结果按 db 实例缓存，避免热路径（检索/治理循环）里
 * 每次拼源片段都多打一次 `SELECT 1 ... LIMIT 1`。
 */
const _probe = new WeakMap();

/** 表是否存在（探测失败一律按不存在处理，旧库 / 未拆表场景安全降级）。 */
function tableExists(db, table) {
    let slot = _probe.get(db);
    if (!slot) { slot = new Map(); _probe.set(db, slot); }
    if (slot.has(table)) return slot.get(table);
    let ok = false;
    try {
        db.prepare(`SELECT 1 AS ok FROM ${table} LIMIT 1`).get();
        ok = true;
    }
    catch { ok = false; }
    slot.set(table, ok);
    return ok;
}

/** 任务库是否已 ATTACH（旧单库为 false）。 */
export function hasTaskSchema(db) {
    return tableExists(db, TASK_TABLE);
}

/**
 * 生成可直接拼进 FROM / JOIN 的「记录源」片段。
 *
 * @example
 *   // 旧：`SELECT id, content FROM memories m WHERE m.status='active'`
 *   // 新：`SELECT id, content FROM ${recordsFrom(db, { alias: "m" })} WHERE m.status='active'`
 *
 * @param {object} db 已打开（含 ATTACH）的库
 * @param {object} opts
 * @param {"memory"|"task"|"both"} [opts.scope="both"] 查哪一侧
 * @param {string} [opts.alias="r"] 别名（UNION 分支必须用同一列集合）
 * @param {string} [opts.columns="*"] UNION 时的列清单；两表同构，`*` 即可
 * @returns {string} `main.knowledge_records m` / `task_store.task_records m` / `(SELECT ... ) AS m`
 */
export function recordsFrom(db, { scope = "both", alias = "r", columns = "*" } = {}) {
    assertScope(scope);
    const taskOk = scope === "task" || scope === "both" ? hasTaskSchema(db) : false;

    if (scope === "memory") return `${MEMORY_TABLE} ${alias}`;
    // 旧单库没有任务表：task 侧退化为空集（列结构仍与记忆表一致，UNION 不报错）
    if (scope === "task") return taskOk ? `${TASK_TABLE} ${alias}` : `(SELECT ${columns} FROM ${MEMORY_TABLE} WHERE 0) AS ${alias}`;
    if (!taskOk) return `${MEMORY_TABLE} ${alias}`;
    return `(SELECT ${columns} FROM ${MEMORY_TABLE} UNION ALL SELECT ${columns} FROM ${TASK_TABLE}) AS ${alias}`;
}

/** 计数。@returns {number} */
export function countRecords(db, { scope = "both", where = "", params = [] } = {}) {
    assertScope(scope);
    const sql = `SELECT COUNT(*) AS c FROM ${recordsFrom(db, { scope, alias: "r" })}${where ? ` WHERE ${where}` : ""}`;
    return Number(db.prepare(sql).get(...params)?.c ?? 0);
}

/** 列表查询。`order` / `where` 里的列请用 `r.` 前缀（与 alias 对应）。 */
export function listRecords(db, { scope = "both", columns = "*", where = "", params = [], order = "", limit = 100 } = {}) {
    assertScope(scope);
    const sql = `SELECT ${columns} FROM ${recordsFrom(db, { scope, alias: "r" })}`
        + `${where ? ` WHERE ${where}` : ""}`
        + `${order ? ` ORDER BY ${order}` : ""}`
        + `${Number.isFinite(limit) ? ` LIMIT ${Number(limit)}` : ""}`;
    return db.prepare(sql).all(...params);
}

/**
 * 按编号取单条（需要按归属分流时用）。
 * @returns {object|null} 行对象；额外带 `__scope: "memory"|"task"`
 */
export function getRecord(db, id, { columns = "*" } = {}) {
    const n = Number(id);
    if (!Number.isFinite(n)) return null;
    if (hasTaskSchema(db)) {
        const t = db.prepare(`SELECT ${columns} FROM ${TASK_TABLE} WHERE id=?`).get(n);
        if (t) return { ...t, __scope: "task" };
    }
    const m = db.prepare(`SELECT ${columns} FROM ${MEMORY_TABLE} WHERE id=?`).get(n);
    return m ? { ...m, __scope: "memory" } : null;
}

/** 记录是否存在（不关心归属）。 */
export function recordExists(db, id) {
    return getRecord(db, id, { columns: "id" }) !== null;
}

/** 归属判定：'memory' | 'task' | null。 */
export function tableOf(db, id) {
    const r = getRecord(db, id, { columns: "id" });
    return r ? r.__scope : null;
}

/**
 * 向量源：向量表与记录表是一对一拆表的，所以 scope 必须与记录侧一致。
 * 任务向量在 task_store 中与任务表同名存在时使用；否则视为无向量。
 */
export function vectorsFrom(db, { scope = "both", alias = "v" } = {}) {
    assertScope(scope);
    const taskVectors = tableExists(db, TASK_VECTORS);
    if (scope === "memory") return `${MEMORY_VECTORS} ${alias}`;
    if (scope === "task") return taskVectors ? `${TASK_VECTORS} ${alias}` : `(SELECT * FROM ${MEMORY_VECTORS} WHERE 0) AS ${alias}`;
    if (!taskVectors) return `${MEMORY_VECTORS} ${alias}`;
    return `(SELECT * FROM ${MEMORY_VECTORS} UNION ALL SELECT * FROM ${TASK_VECTORS}) AS ${alias}`;
}
