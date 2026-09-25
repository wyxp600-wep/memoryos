import { getVectorsOnProjectCached, lexSearch, readMemoriesByIds, withTx, readConfig } from "./db.js";
import { cosine } from "./embed.js";
import { SECTORS } from "./db.js";
const RRF_K = 60;
/** ★ R4-4 waypoint 模块级缓存（60s TTL）：daemon 每晚预计算存 config['waypoints']，检索只读表 */
let wpCache = null;
function waypointOf(db, id) {
    const now = Date.now();
    if (!wpCache || now - wpCache.at > 60000) {
        const raw = readConfig(db, "waypoints", {});
        const map = new Map();
        for (const [k, v] of Object.entries(raw ?? {})) {
            const n = Number(k);
            if (Number.isFinite(n) && typeof v === "number")
                map.set(n, Math.max(0, Math.min(1, v)));
        }
        wpCache = { at: now, map };
    }
    return wpCache.map.get(id) ?? 0;
}
/**
 * ★ P1-2.4 stale 惩罚系数。
 * 记忆正文被编辑后若向量尚未重算（embedding_stale=1），其向量与正文语义已脱节，
 * 按原相似度排序会把「标题相关但内容已变」的记忆排到前面 —— 即命中错误内容。
 * 这里不直接排除（正文本身可能仍相关），而是降权，让 daemon 重算完成前的过渡期更安全。
 */
const STALE_PENALTY = 0.9;
/** ★ 2026-09-25 P0（检索降级可观测）：hybridSearch 语义路失败原本只在 catch 里静默置空 Map，
 *  调用方（memory_search/memory_context）无从得知「本次已是纯词法」——跨表述召回为 0 却无任何提示，
 *  是"召回差且查不出原因"的主要盲区。这里记最近一次降级供调用方在回执里显式告警；
 *  每次 hybridSearch 开头清零（单线程事件循环，await 间隙不会交错两次检索）。
 *  返回 { msg, at } 或 null（null = 语义路正常）。 */
let _lastDegradation = null;
export function semanticDegradation() {
    return _lastDegradation;
}
/**
 * Gram-Schmidt 正交化：量每个候选对查询向量的「独立贡献度」。
 * 线性相关（同质重复）的候选贡献→0，正交的保留。对顺序敏感，是近似值。
 * 用途：语义路 cosine 粗筛后，把互相重复的记忆压下去，让正交的独立记忆浮上来。
 */
export function orthogonalContrib(qv, cands) {
    const dim = qv.length;
    const basis = [];
    return cands
        .map((c) => {
        let v = new Float32Array(c.vec); // 拷贝，避免污染原向量
        for (const u of basis) {
            let d = 0;
            for (let i = 0; i < dim; i++)
                d += v[i] * u[i];
            for (let i = 0; i < dim; i++)
                v[i] -= d * u[i];
        }
        let m = 0;
        for (let i = 0; i < dim; i++)
            m += v[i] * v[i];
        m = Math.sqrt(m);
        if (m > 1e-6) {
            const u = new Float32Array(dim);
            for (let i = 0; i < dim; i++)
                u[i] = v[i] / m;
            basis.push(u);
            let d = 0;
            for (let i = 0; i < dim; i++)
                d += qv[i] * u[i];
            return { id: c.id, contrib: Math.abs(d) };
        }
        return { id: c.id, contrib: 0 }; // 线性相关，无独立贡献
    })
        .sort((a, b) => b.contrib - a.contrib);
}
/**
 * 意图聚焦度（logicDepth，0~1）：用语义路候选的 cosine 相似度分布算熵。
 * VCP EPA 用 PCA 主成分熵；我们没有 Tag 坐标系，退化为直接对相似度分布算熵。
 * 熵低=相似度集中（query 聚焦某主题）→ logicDepth 高；熵高=分散（query 发散）→ logicDepth 低。
 */
export function intentDepth(sims) {
    if (sims.length === 0)
        return 0.5; // 无语义候选 → 中性，不偏袒任一路
    const m = Math.max(...sims);
    if (m <= 0)
        return 0.5;
    let psum = 0;
    const probs = sims.map((s) => {
        const p = Math.max(0, s / m);
        psum += p;
        return p;
    });
    let entropy = 0;
    for (let i = 0; i < probs.length; i++) {
        const p = psum > 0 ? probs[i] / psum : 0;
        if (p > 1e-9)
            entropy -= p * Math.log2(p);
    }
    const norm = sims.length > 1 ? entropy / Math.log2(sims.length) : 0;
    return Math.max(0, Math.min(1, 1 - norm));
}
/**
 * 混合检索入口。返回按 RRF 分排序的 active 记忆（score=RRF 融合分）。
 * 副作用：命中记忆 hit_count+1、last_hit_at 更新（回血，遗忘曲线输入）。
 */
export async function hybridSearch(db, embedder, p) {
    const limit = p.limit ?? 10;
    const topK = Math.max(40, limit * 4);
    // 语义路
    let semScores = new Map();
    let depth = null; // 意图聚焦度；语义路成功才有值
    _lastDegradation = null; // ★ 本次检索先清零：catch 分支会重新置入
    try {
        const [qv] = await embedder.embedTexts([p.query]);
        if (qv) {
            // P0-4.1：改走带缓存的读取端。原实现每次检索都全表拉取并逐条反序列化 embedding
            // （1024 维 float32 ≈ 4KB/条 → 516 条≈2MB/次，万条级≈40MB/次），而两次写入之间该数据不变。
            // 缓存以 db 实例为键（WeakMap），写入/状态流转后由 invalidateVectorCache 失效，另有 60s TTL 兜底。
            const existing = getVectorsOnProjectCached(db, p.project, true); // 仅 active：非 active 候选后续必被过滤，提前收窄候选池
            // cosine 粗筛（保留向量，供正交化重排；阈值 0.4 与原 vecSearch 一致）
            // ★ P1-2.4：对 stale（正文已改、向量未重算）的记忆按 STALE_PENALTY 降权后再排序。
            const candidates = existing
                .map((e) => ({ id: e.id, vec: e.vec, sim: cosine(qv, e.vec) * (e.stale ? STALE_PENALTY : 1) }))
                .filter((x) => x.sim > 0.4)
                .sort((a, b) => b.sim - a.sim)
                .slice(0, topK);
            // Gram-Schmidt 独立贡献度重排：同质重复→贡献 0，正交独立→上浮
            const ranked = orthogonalContrib(qv, candidates);
            ranked.forEach((r, i) => semScores.set(r.id, 1 / (RRF_K + i + 1)));
            // 意图聚焦度：相似度越集中(logicDepth高) → 越偏语义精排
            depth = intentDepth(candidates.map((c) => c.sim));
        }
    }
    catch (e) {
        semScores = new Map(); // embedding 失败 → 纯词法降级
        _lastDegradation = { msg: e instanceof Error ? e.message : String(e), at: Date.now() }; // ★ 2026-09-25：不再静默，留给调用方回执告警
    }
    // 词法路
    const lex = lexSearch(db, p.query, p.project, topK);
    const lexScores = new Map();
    lex.forEach((h, i) => lexScores.set(h.id, 1 / (RRF_K + i + 1)));
    // RRF 融合归并（按意图聚焦度动态加权：聚焦→偏语义，发散→偏词法；语义路失败则纯词法）
    //   semW = 0.7 + 0.7*depth ∈ [0.7,1.4]；lexW = 1.3 - 0.7*depth ∈ [1.3,0.6]
    //   depth=0.5(中性) 时 sem=1.05/lex=0.95 ≈ 等权，默认行为与改动前一致
    const semW = depth === null ? 0 : 0.7 + 0.7 * depth;
    const lexW = depth === null ? 1 : 1.3 - 0.7 * depth;
    const agg = new Map();
    for (const [id, s] of semScores)
        agg.set(id, (agg.get(id) ?? 0) + s * semW);
    for (const [id, s] of lexScores)
        agg.set(id, (agg.get(id) ?? 0) + s * lexW);
    // ★ R4-5 惰性衰减 + w_sector 加权 + H4 secret 过滤 + H6 前瞻过期排除：
    //   一次性拉取全部候选行，按 final = agg × w_sector × eff_effective 重排后截断
    //   （不先截断——避免把待过滤的 secret/过期行挤进前 limit 造成"漏过滤"）。
    const now = Date.now();
    const decayEff = (rc) => {
        if (rc.pinned)
            return rc.salience; // pinned=1 免衰减
        const lambda = rc.decay_lambda ?? SECTORS[rc.sector]?.lambda ?? 0.01; // 单位/天（M9）
        const base = rc.last_seen_at ?? rc.created_at; // H5：以最近被检索为基准，高频使用不衰
        const days = Math.max(0, (now - Date.parse(base)) / 86400000);
        return rc.salience * Math.exp(-lambda * days);
    };
    const wOf = (rc) => SECTORS[rc.sector]?.w ?? 1;
    const fetchedAll = readMemoriesByIds(db, [...agg.keys()]);
    const ranked = [...agg.keys()]
        .map((id) => {
        const rc = fetchedAll.get(id);
        if (!rc || rc.status !== "active")
            return null;
        if (String(rc.sensitivity ?? "normal") === "secret")
            return null; // H4 双保险（词法路已 SQL 过滤，语义路在此兜底）
        // ★ C 2026-09-14：卡片派发任务（source_ref='card:N'）不进普通检索 —— 避免把「待办的卡任务」当经验记忆召回
        //   （任务应经 task_next/task_claim 领取，不是当记忆搜出来）。agent 手动 task_assign 保留在检索（真·经验片）。
        if (rc.type === "task" && (rc.source_ref ?? "").startsWith("card:"))
            return null;
        if (rc.valid_until && Date.parse(rc.valid_until) <= now)
            return null; // H6：前瞻已过期直接排除
        const eff = decayEff(rc);
        if (eff <= 0.15)
            return null; // 沿用原 eff 阈值（现为现算的显著度衰减）
        // ★ R4-4：waypoint 图关联加分（0.85~1.15），邻居在高频集越多越靠前
        const wp = waypointOf(db, id);
        return { id, rc, final: agg.get(id) * wOf(rc) * eff * (0.85 + 0.3 * wp) };
    })
        .filter((x) => x !== null)
        .sort((a, b) => b.final - a.final)
        .slice(0, limit);
    const out = [];
    const hitIds = [];
    for (const { id, rc } of ranked) {
        out.push({
            id: rc.id,
            content: rc.content,
            type: rc.type,
            agent: rc.agent,
            project: rc.project,
            status: rc.status,
            confidence: rc.confidence,
            created_at: rc.created_at,
            score: rc.salience * wOf(rc), // 暴露显著度×权重供上层参考（RRF 原始分见 final 逻辑）
        });
        hitIds.push(id);
    }
    // H5：命中回血升级 —— 同步 last_seen_at（惰性衰减的刷新基准）。withTx 守卫并发。
    if (hitIds.length) {
        const bump = db.prepare(`UPDATE memories SET hit_count = hit_count + 1, last_hit_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`);
        withTx(db, () => {
            for (const id of hitIds)
                bump.run(id);
        });
    }
    return out;
}
