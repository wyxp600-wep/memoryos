/**
 * ★ 2026-11-16（B3）：任务↔记忆关联层 —— 唯一允许同时认识两个域的模块。
 *
 * 硬约束：
 *   · 关联只存于 `{taskSchema}.task_memory_links`（独立表），**不写进**任务正文或记忆正文；
 *   · 存在性校验只经注入的 `taskStore.getTask` / `memoryStore.getMemory`，不直接查对方表；
 *   · 本模块自己的 SQL 只允许出现 `task_memory_links` 一张表；
 *   · 任务库或记忆库任一不可用时，关联能力显式降级（返回 code），不静默编造。
 *
 * 迁移：`migrateFromCardMemory()` 把历史 `card_memory` 行映射到新表；
 *   无法确定 task_id 的行标为 orphan，不自动猜测（避免把卡-记忆关系错挂到任务上）。
 */

const RELATIONS = ["related", "evidence", "output", "context"];

const nowIso = () => new Date().toISOString();
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** 建表（幂等）。放在任务库，因为关联的宿主是任务（任务被删时关联随之清理）。 */
export function ensureTaskLinksSchema(db, taskSchema = "task_store") {
    if (!db || typeof db.exec !== "function")
        throw new Error("ensureTaskLinksSchema: 需要 db");
    const t = `${taskSchema}.${q("task_memory_links")}`;
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     INTEGER NOT NULL,
        memory_id   INTEGER NOT NULL,
        relation    TEXT    NOT NULL DEFAULT 'related',
        note        TEXT,
        created_by  TEXT,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(task_id, memory_id, relation)
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${taskSchema}.idx_task_memory_links_task ON task_memory_links(task_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${taskSchema}.idx_task_memory_links_memory ON task_memory_links(memory_id)`);
    return { ok: true };
}

export function createTaskLinks({ db, taskStore, memoryStore, taskSchema = "task_store" } = {}) {
    if (!db || typeof db.prepare !== "function")
        throw new Error("createTaskLinks: 需要 db");
    if (!taskStore || typeof taskStore.getTask !== "function")
        throw new Error("createTaskLinks: 需要 taskStore（提供 getTask）");
    if (!memoryStore || typeof memoryStore.getMemory !== "function")
        throw new Error("createTaskLinks: 需要 memoryStore（提供 getMemory）");
    const L = `${taskSchema}.${q("task_memory_links")}`;

    ensureTaskLinksSchema(db, taskSchema);

    function link({ taskId, memoryId, relation = "related", note = null, createdBy = null }) {
        if (!RELATIONS.includes(relation))
            return { ok: false, code: "bad-relation", allowed: RELATIONS };
        const task = taskStore.getTask(taskId);
        if (!task) return { ok: false, code: "task-not-found", taskId: Number(taskId) };
        const mem = memoryStore.getMemory(memoryId);
        if (!mem) return { ok: false, code: "memory-not-found", memoryId: Number(memoryId) };
        const exists = db.prepare(`SELECT id FROM ${L} WHERE task_id=? AND memory_id=? AND relation=?`)
            .get(Number(taskId), Number(memoryId), relation);
        if (exists) return { ok: true, id: Number(exists.id), idempotent: true };
        const info = db.prepare(`INSERT INTO ${L} (task_id, memory_id, relation, note, created_by, created_at)
            VALUES (?,?,?,?,?,?)`)
            .run(Number(taskId), Number(memoryId), relation, note, createdBy, nowIso());
        return { ok: true, id: Number(info.lastInsertRowid) };
    }

    function unlink({ taskId, memoryId, relation = null }) {
        const ph = relation ? "AND relation=?" : "";
        const info = db.prepare(`DELETE FROM ${L} WHERE task_id=? AND memory_id=? ${ph}`)
            .run(Number(taskId), Number(memoryId), ...(relation ? [relation] : []));
        return { ok: Number(info.changes) > 0, deleted: Number(info.changes) };
    }

    function listForTask(taskId) {
        return db.prepare(`SELECT * FROM ${L} WHERE task_id=? ORDER BY id`).all(Number(taskId));
    }

    function listForMemory(memoryId) {
        return db.prepare(`SELECT * FROM ${L} WHERE memory_id=? ORDER BY id`).all(Number(memoryId));
    }

    function countForTask(taskId) {
        return Number(db.prepare(`SELECT COUNT(*) c FROM ${L} WHERE task_id=?`).get(Number(taskId)).c);
    }

    function deleteForTask(taskId) {
        const info = db.prepare(`DELETE FROM ${L} WHERE task_id=?`).run(Number(taskId));
        return { ok: true, deleted: Number(info.changes) };
    }

    /**
     * 从历史 card_memory 迁移。
     * card_memory(card_id, memory_id, relation, created_at)：卡片通过 ref_kind='task' 指向任务。
     * 无法解析出 task 的行 → orphan（不猜），返回清单供人工处理。
     */
    function migrateFromCardMemory({ dryRun = false } = {}) {
        let rows = [];
        try {
            rows = db.prepare(`SELECT card_id, memory_id, relation, created_at FROM ${taskSchema}.${q("card_memory")}`).all();
        }
        catch (e) {
            return { ok: false, code: "card-memory-unavailable", msg: String(e).slice(0, 120) };
        }
        const report = { total: rows.length, mapped: 0, duplicate: 0, orphan: [], badRelation: 0, dryRun: Boolean(dryRun) };
        for (const r of rows) {
            const card = db.prepare(`SELECT ref_kind, ref_id FROM ${taskSchema}.${q("cards")} WHERE id=?`).get(Number(r.card_id));
            const taskId = card && card.ref_kind === "task" ? Number(card.ref_id) : null;
            if (!taskId) { report.orphan.push({ card_id: r.card_id, memory_id: r.memory_id, reason: "card-not-linked-to-task" }); continue; }
            const rel = RELATIONS.includes(r.relation) ? r.relation : "related";
            if (rel !== r.relation) report.badRelation++;
            const exists = db.prepare(`SELECT id FROM ${L} WHERE task_id=? AND memory_id=? AND relation=?`)
                .get(taskId, Number(r.memory_id), rel);
            if (exists) { report.duplicate++; continue; }
            if (!dryRun) {
                db.prepare(`INSERT INTO ${L} (task_id, memory_id, relation, note, created_by, created_at)
                    VALUES (?,?,?,?,?,?)`).run(taskId, Number(r.memory_id), rel, "migrated:card_memory", "migration", r.created_at ?? nowIso());
            }
            report.mapped++;
        }
        return { ok: true, ...report };
    }

    /** 健康检查：孤儿关联（任务或记忆已被删除）+ 双向可查性。 */
    function doctor({ limit = 50 } = {}) {
        const rows = db.prepare(`SELECT * FROM ${L} ORDER BY id DESC LIMIT ?`).all(Number(limit));
        const orphanTask = [], orphanMemory = [];
        for (const r of rows) {
            if (!taskStore.getTask(r.task_id)) orphanTask.push(r.id);
            if (!memoryStore.getMemory(r.memory_id)) orphanMemory.push(r.id);
        }
        return {
            ok: orphanTask.length === 0 && orphanMemory.length === 0,
            scanned: rows.length,
            orphanTaskLinks: orphanTask,
            orphanMemoryLinks: orphanMemory,
        };
    }

    return {
        relations: RELATIONS,
        link, unlink, listForTask, listForMemory, countForTask, deleteForTask,
        migrateFromCardMemory, doctor,
    };
}
