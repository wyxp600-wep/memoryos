/**
 * MemoryOS 批次⑧ — 规则生产线（每日反思，方案 A）
 * 背景：规则「生产」原先依赖仓外复盘 skill 手动触发（实测 type=rule 最后一条停在 2026-09-16，
 *   workbuddy/codex/trae/zcode/memoryos:summary 渠道全静默、内核 cron 触发器 0 条），同步端再勤快列表也断更。
 * 流程：daemon 与 dashboard 双钩子每小时水位检查 → 每天 ≥21:00（config reflect.hour 可改）且当日未认领 →
 *   取水位后新增的 active 记忆（experience/convention/pitfall/decision，按时间正序 40 条/轮，可逐日排水）→
 *   一次 LLM 调用提炼 ≤5 条简短规则（对照现有规则防重复）→
 *   写 type=rule（agent='memoryos:reflection'，inject=1）→ syncRules 刷新全目标注入段（批次⑦ X2 同链路）。
 * 状态存 config 表 KEY='reflect'：{watermark, lastAttemptDay, hour, lastRun, produced, firstRunAt}。
 * 幂等/并发/失败语义：
 *   · 首启只立水位（now-30s），绝不回溯处理存量 1400+ 条记忆；
 *   · 当日认领先写库再调 LLM —— dashboard 与 daemon 双钩子同晚不双跑；
 *   · 成功推进水位到本批最老一条的 created_at（ASC 取数 → 既不重复也不跳过，>40 条逐日排干）；
 *   · LLM 失败**不推进水位**（lastAttemptDay 已认领 → 次日窗口连同今天候选一起补），审计 reflect-failed。
 * 开关：env MEMORY_REFLECT_ON=0 全关；config reflect.enabled=false / reflect.hour 改窗口。
 * 用法：内核自动调用；冒烟走 maybeRunRuleReflection(db, {force:true, llm:fake, sync:false})。
 */
import { readConfig, writeConfig, writeMemory, queryByType, rowOf, logDaemon } from "./db.js";
import { llmConf } from "./llm.js";
import { getEmbedder } from "./embed.js";
import { syncRules } from "./sync-rules.js";

const CANDIDATE_TYPES = ["experience", "convention", "pitfall", "decision"];
const MAX_CANDIDATES = 40;
const MAX_RULES = 5;
const GRACE_SECONDS = 30; // 30s 宽限：不把正在写入的会话半截记忆纳入本轮

function dayKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SYSTEM = `你是规则治理器（MemoryOS 每日反思）：从「近期新增记忆」中提炼所有 AI Agent 都应遵守的简短规则，并对照「现有规则」防止重复。
只产出跨会话通用、可执行的约束/约定/踩坑结论；不要经验叙述、不要待办、不要一次性上下文、不要 LLM 通识。
要求：每条 ≤160 字；以「- **关键词**：」开头；含关键路径/命令/数值；宁缺毋滥（最多 ${MAX_RULES} 条）；语义与现有规则重复的不输出。
只输出 JSON 数组，形如 [{"content":"- **关键词**：规则句"}]；没有合格内容输出 []；除 JSON 外不输出任何字。`;

/** 容错解析模型输出（仅接受 JSON 数组；失败返回空数组，绝不回落成记忆） */
export function parseRules(text) {
    const fence = String(text ?? "").match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (fence ? fence[1] : String(text ?? "")).trim();
    const tryArr = (s) => {
        const j = JSON.parse(s);
        return Array.isArray(j) ? j : null;
    };
    let arr = null;
    try { arr = tryArr(raw); } catch { arr = null; }
    if (!arr) {
        const i0 = raw.indexOf("[");
        const i1 = raw.lastIndexOf("]");
        if (i0 >= 0 && i1 > i0) {
            try { arr = tryArr(raw.slice(i0, i1 + 1)); } catch { arr = null; }
        }
    }
    if (!arr)
        return [];
    const out = [];
    const seen = new Set();
    for (const x of arr) {
        let c = String(typeof x === "string" ? x : (x?.content ?? "")).trim().slice(0, 600);
        if (c.length < 8)
            continue; // 短于 8 字不成规则
        if (!/^[-*·#]/.test(c))
            c = "- " + c;
        const k = c.replace(/\s+/g, "").toLowerCase();
        if (seen.has(k))
            continue;
        seen.add(k);
        out.push(c);
    }
    return out.slice(0, MAX_RULES);
}

/** 一次 LLM 调用（60s 超时）。返回解析后的规则字符串数组；非 2xx/网络错误抛错。 */
async function reflectLlm(candidates, existingRules) {
    const conf = await llmConf();
    if (conf.keySource === "undecryptable")
        throw new Error("LLM 密钥无法解密：请在设置页重新填写密钥");
    const cand = candidates.map((m) => `#${m.id}[${m.type}] ${m.content.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
    const exist = existingRules.slice(0, 150).map((r) => r.content.replace(/\s+/g, " ").slice(0, 80)).join("\n");
    const user = `近期新增记忆（${candidates.length} 条）：\n${cand}\n\n现有规则摘要（防重复；共 ${existingRules.length} 条，显示最近 150 条）：\n${exist || "（暂无）"}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
        const res = await fetch(conf.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(conf.key ? { Authorization: `Bearer ${conf.key}` } : {}) },
            signal: ctrl.signal,
            body: JSON.stringify({
                model: conf.model,
                messages: [
                    { role: "system", content: SYSTEM },
                    { role: "user", content: user },
                ],
                max_tokens: 900,
                temperature: 0.2,
            }),
        });
        if (!res.ok)
            throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        return parseRules(data?.choices?.[0]?.message?.content ?? "");
    }
    finally { clearTimeout(timer); }
}

const normKey = (s) => String(s).replace(/\s+/g, "").toLowerCase();

/**
 * 每日规则反思（幂等；先认领当日再干活，dashboard/daemon 双钩子安全）。
 * 返回 {skipped:reason} | {watermark, candidates, produced}；LLM 失败记审计后抛错。
 * opts: {force?, llm?, sync?} —— force 跳过小时窗与当日认领闸（冒烟/手动）；llm 注入假调用；sync=false 不写目标文件。
 */
export async function maybeRunRuleReflection(db, opts = {}) {
    if (process.env.MEMORY_REFLECT_ON === "0")
        return { skipped: "disabled" };
    let st = readConfig(db, "reflect", {}) || {};
    const now = new Date();
    if (!st.watermark) {
        // 首启只立水位（now-宽限），绝不回溯处理存量记忆
        const wm = new Date(now.getTime() - GRACE_SECONDS * 1000).toISOString();
        writeConfig(db, "reflect", { ...st, watermark: wm, firstRunAt: now.toISOString() });
        return { skipped: "watermark-armed", watermark: wm };
    }
    if (!opts.force) {
        if (st.enabled === false)
            return { skipped: "disabled" };
        const hour = Number.isFinite(Number(st.hour)) ? Number(st.hour) : 21;
        if (now.getHours() < hour)
            return { skipped: "before-window" };
        if (st.lastAttemptDay === dayKey(now))
            return { skipped: "already-ran" };
    }
    // 先认领当日（UPSERT 原子），防 dashboard 与 daemon 同晚双跑双花 LLM
    st = { ...st, lastAttemptDay: dayKey(now) };
    writeConfig(db, "reflect", st);

    const graceMs = (opts.force ? 0 : GRACE_SECONDS) * 1000;
    const until = new Date(now.getTime() - graceMs).toISOString();
    // 正序取最老的未处理候选（ASC + 成功后水位=本批最老之后 → 不重不漏，>40 条逐日排干）
    const candidates = db
        .prepare(`SELECT * FROM memories WHERE status='active' AND type IN (${CANDIDATE_TYPES.map(() => "?").join(",")})
                  AND created_at > ? AND created_at <= ? ORDER BY created_at ASC LIMIT ${MAX_CANDIDATES}`)
        .all(...CANDIDATE_TYPES, st.watermark, until)
        .map(rowOf);
    if (!candidates.length)
        return { skipped: "no-candidates", watermark: st.watermark };

    const existing = queryByType(db, "rule", { status: "active", limit: 2000 });
    const existingKeys = new Set(existing.map((r) => normKey(r.content)));

    const call = opts.llm ?? reflectLlm;
    let produced = 0;
    try {
        const items = await call(candidates, existing);
        for (const content of items) {
            if (existingKeys.has(normKey(content)))
                continue; // 程序侧二次防重（LLM 已对过清单，仍兜底精确去重）
            let embedding = null;
            try {
                const [v] = await (await getEmbedder()).embedTexts([content]);
                embedding = v ?? null;
            }
            catch { embedding = null; } // 嵌入失败不阻塞建规则（语义路由 daemon backfill 兜底）
            const row = writeMemory(db, {
                content,
                type: "rule",
                agent: "memoryos:reflection",
                agent_fpath: null,
                project: "global",
                embedding,
                confidence: 0.75,
                status: "active",
            });
            db.prepare(`UPDATE memories SET inject=1 WHERE id=?`).run(row.id); // 自动进注入段（批次⑦ X2 开关直置）
            produced++;
        }
        // 水位推进到本批最老一条之后（ASC 末元素 = 本批 created_at 最大者）
        const wm = candidates[candidates.length - 1].created_at;
        writeConfig(db, "reflect", { ...st, watermark: wm, lastRun: now.toISOString(), produced, candidates: candidates.length });
        if (opts.sync !== false && produced > 0) {
            try { syncRules(db); }
            catch (e) { console.error(`[reflect] 注入段同步失败: ${e instanceof Error ? e.message : String(e)}`); }
        }
        logDaemon(db, { task: "reflect", op: produced > 0 ? "reflect-rules" : "reflect-empty", operator: "system:reflect", detail: `每日反思：产规则 ${produced} 条（候选 ${candidates.length}，水位→${wm.slice(0, 16)}）` });
        return { watermark: wm, candidates: candidates.length, produced };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        try { logDaemon(db, { task: "reflect", op: "reflect-failed", operator: "system:reflect", detail: msg.slice(0, 300) }); }
        catch { /* 审计失败也继续抛原错 */ }
        // 失败不推进水位（lastAttemptDay 已认领 → 明天窗口连同今天的一起补）
        throw new Error(`规则反思失败：${msg}`);
    }
}
