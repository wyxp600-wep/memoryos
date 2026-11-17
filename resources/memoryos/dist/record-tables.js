/**
 * ★ 2026-11-17：两库物理表名的唯一常量来源。
 *
 * 允许 import 本文件的模块只有：
 *   · record-source.js（显式跨库查询接口）
 *   · task-store.js / memory-store.js（各自物理层）
 *   · db.js（索引原语与归属判定）
 *   · storage.js（schema 定义）
 *
 * 其他模块请改用 record-source.js 的 recordsFrom / listRecords 等接口，
 * 不要直接引用表名常量 —— 否则表名会重新散落全仓，等于把隐式耦合换成显式重复。
 */
export const MEMORY_SCHEMA = "main";
export const TASK_SCHEMA = "task_store";

/** 记忆记录表（原 `memories` 视图的记忆侧） */
export const MEMORY_TABLE = `${MEMORY_SCHEMA}.knowledge_records`;
/** 任务记录表（原 `memories` 视图的任务侧） */
export const TASK_TABLE = `${TASK_SCHEMA}.task_records`;

/** 向量拆表（P1-2.2） */
export const MEMORY_VECTORS = `${MEMORY_SCHEMA}.memory_vectors`;
export const TASK_VECTORS = `${TASK_SCHEMA}.memory_vectors`;

/** 任务侧索引表（FTS / n-gram），跨库检索聚合时使用 */
export const TASK_FTS = `${TASK_SCHEMA}.task_fts`;
export const TASK_GRAM = `${TASK_SCHEMA}.task_gram`;
/** 记忆侧索引表 */
export const MEMORY_GRAM = `${MEMORY_SCHEMA}.memories_gram`;
