/**
 * ★ 2026-11-16（B4 组1b/组3 收尾）：任务写入的唯一入口。
 *
 * 为什么独立成叶子模块：task-domain 与 targeted-queue 都需要创建任务，
 *   而 task-domain 已 import targeted-queue —— 若把写入函数留在 task-domain 会形成环形依赖。
 *   本模块只依赖 db.js 的索引原语与 task-store，不依赖任何领域模块。
 *
 * 职责：task-store 写物理表 + 补齐 writeMemory 原本承担的索引副作用
 *   （任务向量 / CJK 2-gram / 关键词 / 元数据 / 检索缓存失效）。
 *   缺任一项任务就会「正文在、检索不到」，故必须同事务完成。
 */
import { upsertVector, syncGrams, invalidateVectorCache, normalizeSector, sectorLambda, withTx } from "./db.js";
import { setMemoryTerms, refreshMemoryMetadata } from "./memory-metadata.js";
import { createTaskStore } from "./task-store.js";

/** 任务物理表限定名（与 task-domain 同口径）。 */
export const TASK_TABLE = "task_store.task_records";

export function createTaskRow(db, { content, agent, agent_fpath = null, project = "global", embedding = null, confidence = 0.8, ...rest } = {}) {
    let row = null;
    withTx(db, () => {
        const created = createTaskStore({ db, helpers: { normalizeSector, sectorLambda } }).createTask({
            content, agent, agent_fpath, project, embedding, confidence, ...rest,
        });
        const id = created.id;
        if (embedding) {
            // 与 writeMemory 同源的向量出处标签（同步路径不调 embedderProvenance）
            const mode = process.env.EMBED_MODE ?? "fake";
            const model = mode === "local" ? (process.env.EMBED_MODEL ?? "Xenova/bge-m3")
                : mode === "api" ? (process.env.EMBED_MODEL ?? "bge-m3") : "fake";
            upsertVector(db, id, embedding, { model, dim: embedding.length, recordType: "task" });
        }
        syncGrams(db, id, content);
        setMemoryTerms(db, id, { content, type: "task", agent, project, sector: created.sector });
        refreshMemoryMetadata(db, id);
        invalidateVectorCache(db);
        row = db.prepare(`SELECT * FROM ${TASK_TABLE} WHERE id=?`).get(id);
    });
    return row;
}
