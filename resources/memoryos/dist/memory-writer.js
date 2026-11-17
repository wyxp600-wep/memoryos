/**
 * ★ 2026-11-17（B4 组3b）：记忆写入的唯一入口。
 *
 * 与 task-writer.js 同构：
 *   · memory-store 只负责记忆物理表写入；
 *   · 本模块在**同一事务**内补齐 writeMemory 原本承担的索引副作用
 *     （记忆向量 / CJK 2-gram / 关键词 / 元数据 / 检索缓存失效）；
 *   · 返回值用 db.js 的 rowOf 规范化，保证与旧 writeMemory 的返回结构逐字段一致
 *     （调用方后续读 row.id / row.project / row.version）。
 *
 * 边界：本模块属组合层，允许 import db.js 的索引原语；memory-store 本身仍零依赖。
 */
import { upsertVector, syncGrams, invalidateVectorCache, normalizeSector, sectorLambda, withTx, rowOf } from "./db.js";
import { setMemoryTerms, refreshMemoryMetadata } from "./memory-metadata.js";
import { createMemoryStore } from "./memory-store.js";
import { createTaskRow } from "./task-writer.js";

export const MEMORY_TABLE = "main.knowledge_records";

export function createMemoryRow(db, input = {}) {
    // 与 writeMemory 同口径：正文换行归一（\r\n / \r → \n），避免同一内容两种字节形态
    const args = typeof input.content === "string"
        ? { ...input, content: input.content.replace(/\r\n?/g, "\n") }
        : { ...input };
    let row = null;
    // ★ 兼容入口：历史调用方仍用 memory_write(type='task') 建任务（smoke-p26 H2b 锁定该契约）。
    //   这里不改变行为，而是把落点路由到任务库 —— 记忆表不再出现任务行，同时调用方零改动。
    if (String(args.type) === "task") return createTaskRow(db, args);
    withTx(db, () => {
        const created = createMemoryStore({ db, helpers: { normalizeSector, sectorLambda } }).createMemory(args);
        if (!created.ok) throw new Error(created.msg || created.code || "memory-write-rejected");
        const id = created.memory.id;
        if (args.embedding) {
            // 与 writeMemory 同源的向量出处标签（同步路径不调 embedderProvenance）
            const mode = process.env.EMBED_MODE ?? "fake";
            const model = mode === "local" ? (process.env.EMBED_MODEL ?? "Xenova/bge-m3")
                : mode === "api" ? (process.env.EMBED_MODEL ?? "bge-m3") : "fake";
            upsertVector(db, id, args.embedding, { model, dim: args.embedding.length, recordType: created.memory.type });
        }
        syncGrams(db, id, args.content);
        setMemoryTerms(db, id, args); // 透传完整 args（keywords/tags 由此进入关键词索引）
        refreshMemoryMetadata(db, id);
        invalidateVectorCache(db);
        row = rowOf(db.prepare(`SELECT * FROM ${MEMORY_TABLE} WHERE id=?`).get(id));
    });
    return row;
}
