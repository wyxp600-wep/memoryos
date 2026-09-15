/**
 * MemoryOS v0.3 — 巩固守护进程（M-2.1）
 * 三种运行态：
 *   node dist/daemon.js                常驻（先跑一轮，之后每小时）
 *   node dist/daemon.js --once         单跑一轮即退
 *   node dist/daemon.js --once --dry-run  只输出计划，不落库（事务回滚预演）
 * 三个任务（apply 时单事务，全成或全回滚）：
 *   ① 衰减    eff = conf × 0.5^(闲置天数 / (30 × e^(0.15×hits)))；decision 不衰减
 *   ② 归档    eff < 0.1 或 45 天无曝光 → status='archived'（写 daemon_log 留痕，不删除）
 *   ③ 去重    sim>0.96 合并，存活者=命中多者；跨来源印证 conf+0.1；LIMIT 50/轮
 * 验收：--once --dry-run 输出计划且不落库。
 */
import { openDb, listEffRows, setEff, archiveMemory, archiveTrial, markMerged, logDaemon, bumpConfidence, setStatus, readConfig, writeConfig, checkpointWal, backupDb, upsertVector, SECTORS, writeMemory } from "./db.js";
import { cosine, getEmbedder } from "./embed.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
export const DEFAULT_HYGIENE_CONFIG = {
    archiveEff: 0.1,
    archiveAgeDays: 45,
    dedupeSim: 0.96,
    dedupeRoundLimit: 50,
    qPromote: 0.65,
    trialAgeDays: 30,
    trialPolicy: "lenient",
};
/** 读治理配置：config 表有则用（部分覆盖），否则全量走默认。 */
export function loadHygieneConfig(db) {
    const stored = readConfig(db, "hygiene", {});
    return { ...DEFAULT_HYGIENE_CONFIG, ...(stored ?? {}) };
}
const Q_WEIGHT = { completeness: 0.4, confidence: 0.2, adoption: 0.25, freshness: 0.15 };
const Q_PROMOTE = 0.65; // 质量分及格线（与「曝光 OR 高分」双条件并列）。0.65 标定自真实库分布断层（见脚本校准）
/** 多因子质量评分（0~1）：completeness 0.4 / confidence 0.2 / adoption 0.25 / freshness 0.15。
 *  进攻型：识别「质量高但未被搜索命中」的好样本，弥补 trial 只看 0 曝光就杀的粗糙。 */
export function qualityScore(m) {
    // completeness：decision/convention 默认完整；正文有结论+依据（字数适中）加分
    const content = m.content ?? "";
    let comp = m.type === "decision" || m.type === "convention" ? 0.8 : 0.5;
    if (content) {
        const len = content.trim().length;
        if (len >= 40 && len <= 800)
            comp = Math.min(1, comp + 0.2);
        else if (len > 0 && len < 40)
            comp = Math.max(0, comp - 0.2);
    }
    // confidence 归一化（0~1 已自然满足）
    const conf = Math.max(0, Math.min(1, m.confidence));
    // adoption：命中采纳度，hit 越多越高（5 次饱和）
    const adoption = Math.min(1, (m.hit_count ?? 0) / 5);
    // freshness：30 天内满值，之后渐衰（130 天归 0）
    const age = daysSince(m.created_at);
    const freshness = Math.max(0, Math.min(1, 1 - Math.max(0, age - 30) / 100));
    const s = Q_WEIGHT.completeness * comp +
        Q_WEIGHT.confidence * conf +
        Q_WEIGHT.adoption * adoption +
        Q_WEIGHT.freshness * freshness;
    return Math.max(0, Math.min(1, s));
}
/** 纯 JS 日期差（天），避免每次调用新建 DB 实例。ISO8601 字符串或 'now' 均可输入。 */
function daysSince(iso) {
    if (iso === "now")
        return 0;
    const then = new Date(iso).getTime();
    const now = Date.now();
    if (Number.isNaN(then))
        return 0;
    return Math.max(0, (now - then) / 86400000);
}
export { daysSince };
/** 对全部 active 记忆计算衰减 eff（★ R4-5/M9：sector-λ 惰性公式，与 search.ts 检索口径一致：
 *   eff = salience × e^(-λ·Δt)，Δt 以天计，基准 = last_seen_at ?? last_hit_at ?? created_at；
 *   pinned=1 免衰减；λ = decay_lambda ?? 类默认。daemon 刷写仅供归档判定，检索已改查询时现算。） */
export function computeDecay(rows) {
    const ops = [];
    for (const r of rows) {
        if (r.pinned) {
            ops.push({ id: r.id, eff: r.salience, previous: r.eff_confidence, type: r.type });
            continue;
        }
        const last = r.last_seen_at ?? r.last_hit_at ?? r.created_at;
        const days = daysSince(last);
        const lambda = r.decay_lambda ?? SECTORS[r.sector]?.lambda ?? 0.01;
        const eff = r.salience * Math.exp(-lambda * days);
        ops.push({ id: r.id, eff: Number(eff.toFixed(4)), previous: r.eff_confidence, type: r.type });
    }
    return ops;
}
/** 由衰减结果 + 曝光龄判归档候选（eff<archiveEff 或 archiveAgeDays 天无曝光）。
 *  接受 computeDecay 的结果 map 直接复用，避免二次计算。 */
export function computeArchives(rows, decayMap, cfg = DEFAULT_HYGIENE_CONFIG) {
    const out = [];
    for (const r of rows) {
        if (r.pinned)
            continue; // pinned 免衰减 + 不自动归档
        const last = r.last_seen_at ?? r.last_hit_at ?? r.created_at;
        const days = daysSince(last);
        const eff = decayMap.get(r.id) ?? r.confidence;
        if (eff < cfg.archiveEff) {
            out.push({ id: r.id, eff, reason: "eff", daysSinceExposure: days, type: r.type });
        }
        else if (days > cfg.archiveAgeDays) {
            out.push({ id: r.id, eff, reason: "stale", daysSinceExposure: days, type: r.type });
        }
    }
    return out;
}
/** 去重扫描：active 且有向量，两两 sim>cfg.dedupeSim → winner=命中多者（平手保留 id 小）。LIMIT cfg.dedupeRoundLimit/轮 */
export function computeDedupes(rows, cfg = DEFAULT_HYGIENE_CONFIG) {
    const vec = rows.filter((r) => r.vec);
    const out = [];
    for (let i = 0; i < vec.length && out.length < cfg.dedupeRoundLimit; i++) {
        for (let j = i + 1; j < vec.length && out.length < cfg.dedupeRoundLimit; j++) {
            const a = vec[i];
            const b = vec[j];
            const sim = cosine(a.vec, b.vec);
            if (sim > cfg.dedupeSim) {
                const aWin = a.hit_count > b.hit_count || (a.hit_count === b.hit_count && a.id < b.id);
                const winner = aWin ? a : b;
                const loser = aWin ? b : a;
                out.push({ winner: winner.id, loser: loser.id, sim, crossSource: winner.agent !== loser.agent });
            }
        }
    }
    return out;
}
/** 试用期考核（第 4 任务）：decision 免考核立即转正；非 decision 以 created_at 记龄 ≥cfg.trialAgeDays 天才判，
 *  曝光(hit≥1 或 last_hit_at 非空) → promote active；零曝光但质量分≥cfg.qPromote → 也 promote（质量感知，防误杀好样本）；否则 archive。 */
export function computeTrials(rows, cfg = DEFAULT_HYGIENE_CONFIG) {
    const out = [];
    for (const r of rows) {
        const age = Math.floor(daysSince(r.created_at));
        if (r.type === "decision") {
            out.push({ id: r.id, type: r.type, action: "promote", ageDays: age, hits: r.hit_count });
            continue;
        }
        if (age < cfg.trialAgeDays)
            continue; // 考核期未满，暂不动
        if (cfg.trialPolicy === "lenient") {
            // 宽松策略：trial 阶段不做质量淘汰，一律放行转正。
            // 淘汰交给 active 层 —— eff 衰减到 <archiveEff 或 archiveAgeDays 天零曝光，由 computeArchives 自然收敛。
            out.push({ id: r.id, type: r.type, action: "promote", ageDays: age, hits: r.hit_count });
            continue;
        }
        const exposed = r.hit_count >= 1 || !!r.last_hit_at;
        // 质量感知：虽零曝光，但多因子质量达标也转正（进攻型——识别"好但没被搜到"的记忆）
        const q = qualityScore({ type: r.type, confidence: r.confidence, hit_count: r.hit_count, created_at: r.created_at, content: r.content });
        out.push({ id: r.id, type: r.type, action: exposed || q >= cfg.qPromote ? "promote" : "archive", ageDays: age, hits: r.hit_count });
    }
    return out;
}
/** 生成计划（纯计算，不落库）——dry-run 复用 */
export function buildPlan(db) {
    const cfg = loadHygieneConfig(db);
    const rows = listEffRows(db).map((r) => ({
        id: r.id,
        type: r.type,
        agent: r.agent,
        confidence: r.confidence,
        eff_confidence: r.eff_confidence,
        hit_count: r.hit_count,
        last_hit_at: r.last_hit_at,
        last_seen_at: r.last_seen_at,
        created_at: r.created_at,
        sector: r.sector,
        salience: r.salience,
        decay_lambda: r.decay_lambda,
        pinned: r.pinned,
        vec: r.vec,
    }));
    const decays = computeDecay(rows);
    const decayMap = new Map(decays.map((d) => [d.id, d.eff]));
    // 试用期考核：读取 status='trial' 的记忆（含 content，供质量分判断完整性）
    const trialRows = db
        .prepare(`SELECT id, type, agent, content, confidence, eff_confidence, hit_count, last_hit_at, last_seen_at, created_at, sector, salience, decay_lambda, pinned FROM memories WHERE status='trial'`)
        .all().map((r) => ({
        id: Number(r.id), type: r.type, agent: r.agent, content: r.content, confidence: r.confidence, eff_confidence: r.eff_confidence,
        hit_count: Number(r.hit_count), last_hit_at: r.last_hit_at, last_seen_at: r.last_seen_at, created_at: r.created_at,
        sector: r.sector ?? "episodic", salience: r.salience == null ? 1.0 : Number(r.salience),
        decay_lambda: r.decay_lambda, pinned: Number(r.pinned ?? 0), vec: null,
    }));
    return {
        decays,
        archives: computeArchives(rows, decayMap, cfg),
        dedupes: computeDedupes(rows, cfg),
        trials: computeTrials(trialRows, cfg),
    };
}
/** 落库（单事务，全成或全回滚）。dryRun=true 只打印不写。返回总结字符串。 */
export function applyPlan(db, plan, dryRun) {
    const archIds = new Set(plan.archives.map((a) => a.id));
    const lines = [];
    if (dryRun) {
        lines.push(`[dry-run] 计划：衰减 ${plan.decays.length}，归档 ${plan.archives.length}，去重 ${plan.dedupes.length}，试用考核 ${plan.trials.length}`);
        plan.archives.slice(0, 20).forEach((a) => lines.push(`  dry 归档 #${a.id} [${a.type}] eff=${a.eff} ${a.daysSinceExposure.toFixed(0)}天无曝光 (${a.reason})`));
        plan.dedupes.slice(0, 20).forEach((d) => lines.push(`  dry 去重 #${d.loser} → #${d.winner} (sim=${d.sim.toFixed(3)}${d.crossSource ? ", 跨来源conf+0.1" : ""})`));
        plan.trials.slice(0, 20).forEach((t) => lines.push(`  dry 试用 #${t.id} [${t.type}] ${t.ageDays}d ${t.action === "promote" ? "转正active" : "归档"} (hits=${t.hits})`));
        lines.push("  （dry-run：不落库）");
        return lines.join("\n");
    }
    db.exec("BEGIN");
    try {
        // ① 衰减
        for (const op of plan.decays) {
            setEff(db, op.id, op.eff);
            logDaemon(db, { task: "decay", op: "eff_update", memory_id: op.id, detail: `conf→eff: ${op.eff}` });
        }
        // ② 归档（仅 active，且排去重合并（merged 不归档）在后续步骤自然排除）
        const dedupeLosers = new Set(plan.dedupes.map((d) => d.loser));
        for (const a of plan.archives) {
            if (dedupeLosers.has(a.id))
                continue; // 同轮被去重合并的不归档
            archiveMemory(db, a.id);
            logDaemon(db, {
                task: "archive",
                op: "archive",
                memory_id: a.id,
                detail: `eff=${a.eff}, ${a.daysSinceExposure.toFixed(0)}d无曝光 (${a.reason})`,
            });
        }
        // ③ 去重（loser→merged + superseded_by；跨来源 winner conf+0.1）
        for (const d of plan.dedupes) {
            markMerged(db, d.loser, d.winner);
            if (d.crossSource)
                bumpConfidence(db, d.winner, 0.1);
            logDaemon(db, {
                task: "dedupe",
                op: "merge",
                memory_id: d.loser,
                detail: `→ #${d.winner} sim=${d.sim.toFixed(3)}${d.crossSource ? ", winner conf+0.1" : ""}`,
            });
        }
        // ④ 试用考核：promote → active；archive → archived（快速淘汰）
        for (const t of plan.trials) {
            if (t.action === "promote") {
                setStatus(db, t.id, "active");
                logDaemon(db, { task: "trial", op: "promote", memory_id: t.id, detail: `${t.ageDays}d ${t.hits}hit → active` });
            }
            else {
                archiveTrial(db, t.id);
                logDaemon(db, { task: "trial", op: "archive", memory_id: t.id, detail: `${t.ageDays}d 0曝光 → archived` });
            }
        }
        db.exec("COMMIT");
        // 治理落库后收拢 WAL（PASSIVE：尽力而为、不阻塞其他连接读取；失败不影响治理结果）
        try {
            db.exec("PRAGMA wal_checkpoint(PASSIVE)");
        }
        catch { /* WAL 收拢失败不视为治理失败 */ }
        lines.push(`已应用：eff更新 ${plan.decays.length}，归档 ${plan.archives.length}，去重 ${plan.dedupes.length}，试用考核 ${plan.trials.length}`);
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
    return lines.join("\n");
}
/**
 * ★ P1-2.4 重算 stale 向量。
 * updateMemory 只置 embedding_stale=1（它是同步 API，无法等待异步嵌入计算），
 * 由 daemon 每轮限量重算，恢复「正文 ↔ 向量」的语义一致。
 * 限量（默认 20/轮）避免一次性大批量嵌入长时间占用。
 */
export async function reembedStale(db, limit = 20) {
    const pendingAll = db.prepare(`SELECT COUNT(*) c FROM memories WHERE embedding_stale = 1`).get().c;
    if (pendingAll === 0)
        return { done: 0, failed: 0, pending: 0 };
    const rows = db
        .prepare(`SELECT id, content FROM memories WHERE embedding_stale = 1 ORDER BY id LIMIT ?`)
        .all(limit);
    const embedder = await getEmbedder();
    // ★ P1-2.2：向量写入独立表；memories 侧只清 stale 标记
    const clearStale = db.prepare(`UPDATE memories SET embedding_stale = 0 WHERE id = ?`);
    let done = 0;
    let failed = 0;
    for (const r of rows) {
        try {
            const [vec] = await embedder.embedTexts([r.content]);
            if (!vec) {
                failed++;
                continue;
            }
            upsertVector(db, r.id, vec);
            clearStale.run(r.id);
            done++;
        }
        catch (e) {
            failed++;
            console.error(`[reembed] #${r.id} 失败: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { done, failed, pending: Math.max(0, pendingAll - done) };
}
/**
 * 长期治理一轮（每小时）：
 *  ① 租约回收（H3）：过期 running → ready + 清 assignee/claim_lock + lease_expired 事件
 *  ② triage 超时（M1）：>24h → todo + auto_refine
 *  ③ 熔断：failed≥2 → blocked + circuit_break
 *  ④ 依赖提升（M3）：todo 且 depends 全 done → ready + auto_ready
 *  ⑤ working 清理（H2/R4-2）：updated_at < now-24h 物理 DELETE
 *  ⑥ 保留策略（R4-1）：card_events>180d / memory_usage>90d 归档到 *_archive；archived 卡片>30d 追加 jsonl
 *  ⑦ waypoint 预计算（R4-4）：距上次 >24h 才对 top-500 高频记忆重算一跳邻居命中计数
 * 全部幂等（状态前置 WHERE），daemon 与 dashboard /api/dispatch 并发安全。
 */
/**
 * ★ 2026-09-14：卡片 ↔ MCP 任务派发桥（双向闭环，全公开池）。
 *  方向① 卡→任务：把 status='ready' 且尚未派发的卡片转成 memories.type='task'
 *          （头 `[task][assignee:?][status:pending]`，assignee=? 即公开，任意 agent 可 task_next/task_claim）。
 *          card_memory 写 relation='dispatch'，作为「已派发 + 回写反查」锚点（幂等防重放）。
 *  方向② 任务→卡：扫描 type='task' 且 status='done' 的记忆，经 discharge card_memory 反查卡片，
 *          卡片未 done 则置 done（依赖卡随之被 housekeep ④ 自动提 ready）。
 * 全部幂等；异常不阻断（返回已派发/已回写统计）。
 */
export function syncTaskBridge(db) {
    const out = { dispatched: 0, syncedDone: 0, syncedRunning: 0 };
    try {
        // 方向① ready 卡 → task 记忆
        const ready = db.prepare(`SELECT id, title, body, priority FROM cards WHERE status='ready'`).all();
        for (const c of ready) {
            const already = db.prepare(`SELECT 1 FROM card_memory WHERE card_id=? AND relation='dispatch'`).get(c.id);
            if (already)
                continue;
            // ★ 2026-09-14：跨链路同主题去重 —— 防「task_assign 直写 + dispatcher 再派生」双套。
            // task_assign 只写 memories（不写 card_memory），dispatcher 感知不到 → 会对 ready 卡片重复派生一遍。
            // 用卡片标题压缩锚做 LIKE 查重：命中现有 active/trial 任务即视为已派发，跳过 + 记 card_event 可审计。
            const titleAnchor = (c.title || "")
                .replace(/\s+/g, "")
                .replace(/[\[\]【】():;，。：、]/g, "")
                .slice(0, 10);
            if (titleAnchor.length >= 6) {
                const dup = db
                    .prepare(`SELECT id FROM memories WHERE type='task' AND status IN ('active','trial') AND content LIKE '%'||?||'%' ORDER BY id LIMIT 1`)
                    .get(titleAnchor);
                if (dup) {
                    db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`)
                        .run(c.id, "dispatcher", "dedupe_skip", "ready", "ready", `已存在同主题任务 #${dup.id}，跳过再派生（防双套）`);
                    continue;
                }
            }
            const deps = db.prepare(`SELECT dst_id FROM links WHERE src_kind='card' AND src_id=? AND kind='depends' AND dst_id IS NOT NULL`).all(c.id)
                .map((d) => Number(d.dst_id)).filter(Number.isFinite);
            // 全公开池：assignee=? ；若卡指定 assignee 则顺带给该 agent
            const assignee = c.body && typeof c.body === "string" ? (c.body.match(/\[assignee:([^\]]+)\]/) || [])[1] : null;
            const body = `${c.title}${c.body ? "\n" + c.body : ""}`.slice(0, 2000);
            const head = `[task][assignee:${assignee || "?"}][status:pending]`;
            const depStr = deps.length ? ` [depends:${deps.join(",")}]` : "";
            const row = writeMemory(db, {
                content: `${head}${depStr} ${body}`,
                type: "task",
                agent: "dispatcher",
                agent_fpath: null,
                project: "global",
                sector: "social",
                source_ref: `card:${c.id}`,
            });
            db.prepare(`INSERT INTO card_memory(card_id, memory_id, relation) VALUES (?,?,?)`).run(c.id, row.id, "dispatch");
            db.prepare(`UPDATE cards SET meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(JSON.stringify({ dispatch_memory_id: row.id }), c.id);
            out.dispatched++;
        }
        // 方向② task 状态记忆 → 关联卡片同步（done→done, in_progress→running）
        const doneTasks = db.prepare(`SELECT cm.card_id, cm.memory_id FROM card_memory cm
       JOIN memories m ON m.id=cm.memory_id
       WHERE cm.relation='dispatch' AND m.type='task' AND m.status IN ('active','trial')`).all();
        for (const d of doneTasks) {
            const m = db.prepare(`SELECT content, status FROM memories WHERE id=?`).get(d.memory_id);
            if (!m)
                continue;
            // 记忆生命周期用 internal status 判定：读 content 头
            const stm = m.content.match(/\[status:([^\]]+)\]/);
            if (!stm)
                continue;
            const taskStatus = stm[1];
            const card = db.prepare(`SELECT status FROM cards WHERE id=?`).get(d.card_id);
            if (!card)
                continue;
            // done → done（不覆盖 archived 终态）
            if (taskStatus === "done") {
                if (card.status === "done" || card.status === "archived")
                    continue;
                db.prepare(`UPDATE cards SET status='done', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(d.card_id);
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`)
                    .run(d.card_id, "dispatcher", "auto_done", card.status, "done", `MCP 任务 #${d.memory_id} 完成，卡片同步`);
                out.syncedDone++;
            }
            // in_progress → running（不覆盖 done/archived 终态，已是 running 则跳过）
            else if (taskStatus === "in_progress") {
                if (card.status === "running" || card.status === "done" || card.status === "archived")
                    continue;
                db.prepare(`UPDATE cards SET status='running', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(d.card_id);
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`)
                    .run(d.card_id, "dispatcher", "auto_running", card.status, "running", `MCP 任务 #${d.memory_id} 进行中，卡片同步`);
                out.syncedRunning++;
            }
        }
    }
    catch (e) {
        console.error(`[syncTaskBridge] 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
    }
    return out;
}
export function housekeepBoard(db, opts = {}) {
    const out = { leased_back: 0, auto_refined: 0, circuit_break: 0, promoted: 0, working_cleared: 0, events_archived: 0, usage_archived: 0, cards_jsonl: 0, waypoints: 0 };
    const now = opts.nowIso ?? new Date().toISOString();
    const ev = (cardId, action, from, to, detail) => db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(cardId, "dispatcher", action, from, to, detail);
    db.exec("BEGIN IMMEDIATE");
    try {
        // ① 租约回收
        const expired = db.prepare(`SELECT id, assignee FROM cards WHERE status='running' AND lease_expires_at < ?`).all(now);
        for (const e of expired) {
            db.prepare(`UPDATE cards SET status='ready', assignee=NULL, claim_lock=NULL, updated_at=? WHERE id=? AND status='running'`).run(now, e.id);
            ev(e.id, "lease_expired", "running", "ready", `租约过期（原 ${e.assignee ?? "?"}），产物请从评论交接`);
            out.leased_back++;
        }
        // ② triage 超时
        const stale = db.prepare(`SELECT id FROM cards WHERE status='triage' AND created_at < datetime('now','-24 hours')`).all();
        for (const s of stale) {
            db.prepare(`UPDATE cards SET status='todo', updated_at=? WHERE id=? AND status='triage'`).run(now, s.id);
            ev(s.id, "auto_refine", "triage", "todo", "24h 未动自动提升");
            out.auto_refined++;
        }
        // ③ 熔断
        const failed = db.prepare(`SELECT id FROM cards WHERE status='failed' AND failure_count>=2`).all();
        for (const f of failed) {
            db.prepare(`UPDATE cards SET status='blocked', updated_at=? WHERE id=? AND status='failed'`).run(now, f.id);
            ev(f.id, "circuit_break", "failed", "blocked", "连续失败≥2 熔断");
            out.circuit_break++;
        }
        // ④ 依赖提升（只认 depends；被依赖全 done）
        const todos = db.prepare(`SELECT id FROM cards WHERE status='todo'`).all();
        for (const t of todos) {
            const deps = db.prepare(`SELECT dst_id FROM links WHERE src_kind='card' AND src_id=? AND kind='depends' AND dst_id IS NOT NULL`).all(t.id);
            const allDone = deps.every((d) => {
                const s = db.prepare(`SELECT status FROM cards WHERE id=?`).get(d.dst_id);
                return !!s && s.status === "done";
            });
            if (allDone) {
                db.prepare(`UPDATE cards SET status='ready', updated_at=? WHERE id=? AND status='todo'`).run(now, t.id);
                ev(t.id, "auto_ready", "todo", "ready", "依赖已满足");
                out.promoted++;
            }
        }
        // ⑤ working 清理：会话 24h 无更新 → 物理 DELETE（H2：不进 memories，杜绝僵尸行）
        const w = db.prepare(`DELETE FROM working_memory WHERE updated_at IS NULL OR updated_at < datetime('now','-24 hours')`).run();
        out.working_cleared = Number(w.changes);
        // ⑥ 保留策略归档（只归档不删除）
        const evRows = db.prepare(`SELECT * FROM card_events WHERE created_at < datetime('now','-180 days')`).all();
        if (evRows.length) {
            db.prepare(`INSERT OR IGNORE INTO card_events_archive SELECT * FROM card_events WHERE created_at < datetime('now','-180 days')`).run();
            db.prepare(`DELETE FROM card_events WHERE created_at < datetime('now','-180 days')`).run();
            out.events_archived = evRows.length;
        }
        const usRows = db.prepare(`SELECT * FROM memory_usage WHERE created_at < datetime('now','-90 days')`).all();
        if (usRows.length) {
            db.prepare(`INSERT OR IGNORE INTO memory_usage_archive SELECT * FROM memory_usage WHERE created_at < datetime('now','-90 days')`).run();
            db.prepare(`DELETE FROM memory_usage WHERE created_at < datetime('now','-90 days')`).run();
            out.usage_archived = usRows.length;
        }
        // archived 卡片 >30d → jsonl（幂等水位 config['retention.cards_maxid']）
        const maxId = Number(readConfig(db, "retention.cards_maxid", 0));
        const archivedCards = db
            .prepare(`SELECT id, board, kind, title, status, assignee, priority, meta, created_at, updated_at FROM cards WHERE status='archived' AND id > ? AND COALESCE(updated_at, created_at) < datetime('now','-30 days') ORDER BY id`)
            .all(maxId);
        if (archivedCards.length) {
            const outPath = opts.cardsArchivePath ?? fileURLToPath(new URL("../data/cards_archive.jsonl", import.meta.url));
            const lines = archivedCards.map((c) => JSON.stringify({ ...c, archived_at: now })).join("\n") + "\n";
            fs.appendFileSync(outPath, lines, "utf8");
            writeConfig(db, "retention.cards_maxid", archivedCards[archivedCards.length - 1].id);
            out.cards_jsonl = archivedCards.length;
        }
        db.exec("COMMIT");
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
    // ⑦ waypoint 预计算（R4-4，>24h 才重算）
    try {
        const lastWp = String(readConfig(db, "waypoint_ts", "") ?? "");
        if (!lastWp || Date.now() - Date.parse(lastWp) > 24 * 3600 * 1000) {
            const top = db.prepare(`SELECT id FROM memories WHERE status='active' ORDER BY hit_count DESC, COALESCE(last_seen_at, created_at) DESC LIMIT 500`).all();
            const topSet = new Set(top.map((t) => t.id));
            const neighborRows = db
                .prepare(`SELECT src_kind, src_id, dst_kind, dst_id FROM links WHERE dst_id IS NOT NULL`)
                .all();
            const counts = new Map();
            for (const l of neighborRows) {
                if (l.src_kind === "memory" && topSet.has(l.dst_id))
                    counts.set(l.src_id, (counts.get(l.src_id) ?? 0) + 1);
                if (l.dst_kind === "memory" && topSet.has(l.src_id))
                    counts.set(l.dst_id, (counts.get(l.dst_id) ?? 0) + 1);
            }
            const wp = {};
            for (const [id, n] of counts)
                wp[id] = Math.min(1, n / 3);
            writeConfig(db, "waypoints", wp);
            writeConfig(db, "waypoint_ts", now);
            out.waypoints = Object.keys(wp).length;
        }
    }
    catch (e) {
        console.error(`[daemon] waypoint 预计算失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ★ R6-6：补刷 last_seen_at（进程崩溃丢 hit 缓冲的自愈）——hit_count>0 且 last_seen 空 → 用 last_hit_at/created_at 回填
    try {
        const r6 = db.prepare(`UPDATE memories SET last_seen_at = COALESCE(last_hit_at, created_at) WHERE status='active' AND hit_count > 0 AND last_seen_at IS NULL`).run();
        if (r6.changes)
            console.log(`[housekeep] R6-6 补刷 last_seen_at ${r6.changes} 行`);
    }
    catch (e) {
        console.error(`[housekeep] R6-6 补刷失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ★ R4-3：未解析链接收敛（周扫）——30 天未解析 → config['unresolved_aging'] 待处理清单（前端 Obsidian 页待处理 tab 消费）
    try {
        const lastR43 = String(readConfig(db, "r43_last_run", "") ?? "");
        if (!lastR43 || Date.now() - Date.parse(lastR43) > 7 * 24 * 3600 * 1000) {
            const aged = db
                .prepare(`SELECT id, src_kind, src_id, dst_title, created_at FROM links WHERE dst_id IS NULL AND created_at < datetime('now','-30 days') ORDER BY created_at ASC LIMIT 500`)
                .all();
            writeConfig(db, "unresolved_aging", aged.map((r) => ({ link_id: r.id, src: `${r.src_kind}#${r.src_id}`, dst_title: r.dst_title, created_at: r.created_at })));
            writeConfig(db, "r43_last_run", now);
        }
    }
    catch (e) {
        console.error(`[housekeep] R4-3 未解析收敛失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    return out;
}
// —— CLI ——
const mainFile = (process.argv[1] ?? "").split(/[\\/]/).pop() ?? "";
if (mainFile === "daemon.js") {
    const args = process.argv.slice(2);
    const once = args.includes("--once");
    const dryRun = args.includes("--dry-run");
    const dbPath = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url)); // fileURLToPath 正确 decode 中文路径
    const db = openDb(dbPath);
    const run = async () => {
        const plan = buildPlan(db);
        const out = applyPlan(db, plan, dryRun);
        console.log(`[${new Date().toISOString()}] ${out}`);
        if (!dryRun) {
            // ★ R4 长期治理：看板运维 + 保留策略 + working 清理 + waypoint 预计算（异常不阻断主治理）
            try {
                const hk = housekeepBoard(db);
                console.log(`[housekeep] 租约回收 ${hk.leased_back} / triage提升 ${hk.auto_refined} / 熔断 ${hk.circuit_break} / 依赖提升 ${hk.promoted} / working清理 ${hk.working_cleared} / events归档 ${hk.events_archived} / usage归档 ${hk.usage_archived} / 卡片jsonl ${hk.cards_jsonl} / waypoint ${hk.waypoints}`);
            }
            catch (e) {
                console.error(`[housekeep] 失败（不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ 2026-09-14：卡片↔MCP 任务派发桥（ready 卡→公开任务池；agent done→卡片同步）
            try {
                const tb = syncTaskBridge(db);
                if (tb.dispatched || tb.syncedDone || tb.syncedRunning) {
                    console.log(`[taskbridge] 派发卡片→任务 ${tb.dispatched} / 任务完成→卡片 ${tb.syncedDone} / 任务进行中→卡片 ${tb.syncedRunning}`);
                }
            }
            catch (e) {
                console.error(`[taskbridge] 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ P1-2.4 重算被编辑过正文的记忆向量（限量，避免阻塞）
            try {
                const re = await reembedStale(db, 20);
                if (re.done || re.failed) {
                    console.log(`[reembed] 重算 ${re.done} 条${re.failed ? `，失败 ${re.failed} 条` : ""}，剩余待算 ${re.pending} 条`);
                }
            }
            catch (e) {
                console.error(`[reembed] 失败（不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ P1-1.1 每日备份（VACUUM INTO）。daemon 每小时一轮，但备份以「当日文件已存在」
            //   判据幂等跳过，故实际每日一份。WAL 模式下直接 copy .db 会得到损坏备份，
            //   必须走 VACUUM INTO（事务一致快照 + 自包含单文件）。
            try {
                const bak = backupDb(db, dbPath, { keep: 7 });
                console.log(`[backup] ${bak.note}`);
            }
            catch (e) {
                console.error(`[backup] 备份失败（不阻断治理）: ${e instanceof Error ? e.message : String(e)}`);
            }
            // ★ P1-1.2 WAL 检查点：合并并截断 WAL，防止其无限增长
            //   （实测 data/memory.db-wal 曾达 27.1MB，与主库 53MB 同量级 → 读放大 + 崩溃恢复变慢）。
            //   若有其他连接在读，SQLite 只做部分合并并返回 busy —— 不算失败，下轮自然重试。
            const ck = checkpointWal(db);
            console.log(`[wal] ${ck.ok ? "checkpoint 完成" : "checkpoint 部分完成（下轮重试）"} :: ${ck.detail}`);
        }
        if (dryRun)
            process.exit(0);
    };
    if (once) {
        // ★ --once 模式必须等 run() 完整跑完（含异步 reembed/backup/wal）再退出；
        //   否则 process.exit(0) 会截断未 await 完的 backup/wal（实测备份不落地）。
        run()
            .then(() => process.exit(0))
            .catch((e) => {
            console.error(`[daemon] 运行失败: ${e instanceof Error ? e.message : String(e)}`);
            process.exit(1);
        });
    }
    else {
        run().catch((e) => console.error(`[daemon] 运行失败: ${e instanceof Error ? e.message : String(e)}`));
        setInterval(run, 60 * 60 * 1000); // 常驻每小时（重型治理：plan/housekeep/reembed/backup/wal）
        // ★ 2026-09-15：任务桥独立高频调度（30s），与重型治理解耦。
        //   任务状态（in_progress/done）需秒级同步到卡片，不能等每小时一轮的重型治理。
        //   run() 中保留 syncTaskBridge 调用作为兜底，此处负责高频实时同步。
        const runTaskBridge = () => {
            try {
                const tb = syncTaskBridge(db);
                if (tb.dispatched || tb.syncedDone || tb.syncedRunning) {
                    console.log(`[taskbridge-fast] 派发 ${tb.dispatched} / done→卡片 ${tb.syncedDone} / in_progress→卡片 ${tb.syncedRunning}`);
                }
            }
            catch (e) {
                console.error(`[taskbridge-fast] 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
            }
        };
        runTaskBridge();
        setInterval(runTaskBridge, 30 * 1000); // 每 30 秒
    }
}
