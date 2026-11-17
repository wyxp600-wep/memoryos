/**
 * ★ 2026-11-17（B6 前置 · JS 回退封装）：向量热点入口。
 *
 * 背景：主计划 B6 要求用 napi-rs 把 `cosineTopK` 下沉到 Rust，但当前环境
 * cargo / rustc 均 MISSING，`native/vector/` 尚未创建。为了让调用方**现在**就能
 * 按最终接口写代码、并且以后换 Rust 实现时零改动，先落地本模块：
 *
 *   · backend()          → "rust" | "js"，供 /api/health 与自检暴露
 *   · cosineTopK(...)    → 统一的 topK 余弦检索入口
 *   · selfCheck()        → 一次性自检，返回诊断对象
 *
 * 边界（与 B6.2 对齐，必须遵守）：
 *   · 不访问 SQLite、不 import 任何业务模块；
 *   · 不持有全局任务/记忆状态（候选由调用方传入，函数内不缓存）；
 *   · Rust 缺失时必须落 JS 实现并**显式**标记 RUST_FALLBACK，禁止静默假成功。
 *
 * 产物查找顺序：
 *   1. ../native/vector/memoryos-vector.node（cargo build 的产物）
 *   2. 环境变量 MEMORYOS_VECTOR_NATIVE 指定的绝对路径（便于灰度）
 *   3. 均不可用 → JS 回退
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let _native = null;
let _nativeError = null;
let _resolved = false;

/** 惰性解析一次原生模块；失败原因保留给 selfCheck 展示，不抛给调用方。 */
function resolveNative() {
    if (_resolved) return _native;
    _resolved = true;
    const candidates = [
        process.env.MEMORYOS_VECTOR_NATIVE,
        join(HERE, "..", "native", "vector", "memoryos-vector.node"),
        join(HERE, "native", "vector", "memoryos-vector.node"),
    ].filter(Boolean).map((p) => resolve(p));
    for (const p of candidates) {
        if (!existsSync(p)) continue;
        try {
            _native = require(p);
            if (_native && typeof _native.cosineTopK === "function") return _native;
            _nativeError = `${p} 未导出 cosineTopK`;
            _native = null;
        }
        catch (e) {
            _nativeError = `${p} 加载失败：${e instanceof Error ? e.message : String(e)}`;
        }
    }
    if (!_nativeError) _nativeError = "未找到 napi 产物（cargo/rustc 缺失，B6 未落地）";
    return null;
}

/** 当前实际生效的实现。 */
export function backend() {
    return resolveNative() ? "rust" : "js";
}

/** 原生模块不可用的原因（JS 回退时为诊断信息）。 */
export function nativeUnavailableReason() {
    resolveNative();
    return _nativeError;
}

/** JS 回退的余弦相似度：与 db.js `cosine()` 同口径（点积 / 双模长），零向量返回 0。 */
export function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function jsCosineTopK(query, candidates, k, minSim) {
    const scored = [];
    for (const c of candidates) {
        const sim = cosine(query, c.vec);
        if (sim > minSim) scored.push({ id: c.id, sim });
    }
    scored.sort((x, y) => y.sim - x.sim);
    return scored.slice(0, k);
}

/**
 * 统一 topK 入口。
 * @param {ArrayLike<number>} query 查询向量
 * @param {Array<{id:number|string, vec:ArrayLike<number>}>} candidates 候选（调用方提供）
 * @param {number} k 返回条数
 * @param {number} minSim 相似度下限（与 vecSearch 的 0.4 默认一致）
 * @returns {Array<{id:number|string, sim:number}>} 按相似度降序
 */
export function cosineTopK(query, candidates, k = 20, minSim = 0.4) {
    const native = resolveNative();
    if (native) return native.cosineTopK(query, candidates, k, minSim);
    return jsCosineTopK(query, candidates, k, minSim);
}

/** 自检：跑一次已知答案的 topK，确认回退路径真的算得对（不是静默返回空）。 */
export function selfCheck() {
    const query = [1, 0, 0];
    const candidates = [
        { id: "same", vec: [1, 0, 0] },
        { id: "half", vec: [1, 1, 0] },
        { id: "orth", vec: [0, 1, 0] },
    ];
    const got = cosineTopK(query, candidates, 2, 0.4);
    const ok = got.length === 2 && got[0].id === "same" && Math.abs(got[0].sim - 1) < 1e-9
        && got[1].id === "half" && Math.abs(got[1].sim - Math.SQRT1_2) < 1e-9;
    return {
        backend: backend(),
        ok,
        reason: backend() === "js" ? `RUST_FALLBACK：${nativeUnavailableReason()}` : "napi 产物已加载",
        sample: got,
    };
}
