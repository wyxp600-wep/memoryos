/**
 * MemoryOS — 规则强制注入（sync-rules）：
 * 把记忆库中 status=active 且 confidence≥MIN_CONF 的 rule，同步写进各智能体
 * 启动必读的约束文件，让新会话「必然看到」并遵守（不只是按需检索）。
 *
 * 当前目标：WorkBuddy（~/.workbuddy/MEMORY.md）。
 * 幂等段维护：用 HTML 注释标记段头/段尾，重复同步只替换段内内容，不覆盖用户正文。
 * 首次注入前自动备份目标文件（~/_backup_memoryos-rules-<ts>/）。
 *
 * 用法：dashboard 调 syncRules(db,{target})；CLI：node dist/sync-rules.js [workbuddy]
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDb, queryByType } from "./db.js";
/** 只同步高置信规则（默认 ≥0.6），低置信/待仲裁的不强塞给智能体。
 *  v0.4 token 减负（P2）：全局/项目注入段从「全量高置信规则平铺」收敛为「内置门禁层」。
 *  门禁 = 跨项目通用行为守则，稳定且少量；其余规则留库靠 memory_search 按需检索（JIT）。
 *  设 SYNC_ALL_RULES=1 可回退旧全量行为（保底/对照）。
 */
const MIN_CONF = Math.max(0, Math.min(1, Number(process.env.RULE_MIN_CONF ?? 0.6) || 0.6));
/** 内置门禁层：仅这 8 条常驻注入段（token 收益最大的低语义重复行为守则） */
const GATE_RULES = [
    { content: "开工先读记忆（硬性触发·不可跳过·第一步）：收到用户任何消息后，先调用 memory_context 注入当前项目高价值记忆，才能开始回复或调用其他工具；之后可按需 memory_search 精确检索（关键词覆盖主题/模块/报错现象）；命中相关记忆须 memory_cite 标注来源，确无相关也须声明'已检索无相关'。禁止跳过此步直接回复或开干，修改核心模块或遇报错时尤其如此。", agent: "gate" },
    { content: "完成后沉淀：解决重要问题（>30min 修复/技术决策/踩坑/隐藏约定/阶段性结论）后，须 memory_write 沉淀一条核心结论+依据，与 memory_search/memory_cite 构成先查-命中-沉淀-回查闭环；未沉淀不得声明任务完成。", agent: "gate" },
    { content: "实证后声明：完成声明必须附 build/curl/netstat 等实证日志，禁用 should/probably/basically 等模糊表述，坚持 docs before code、evidence before conclusions。", agent: "gate" },
    { content: "副本修改：严禁直接修改源文件，必须复制文件后在副本上修改，保留原始版本；修改文件前明确告知改动范围，避免污染原路径（修改产物统一放桌面/独立目录）。", agent: "gate" },
    { content: "最小改动：遵循最小改动原则，仅修改必要部分，避免过度重构与无关变更；不创建多余抽象。", agent: "gate" },
    { content: "先方案后动手：提供方案须先陈述权衡分析（trade-off）再给明确建议，不可跳过对比直接给结论；改动前先读项目结构了解整体架构，遵循四步流程（root cause→solution→confirmation→implementation）。", agent: "gate" },
    { content: "敏感保护：严格保护敏感信息（.env、API Key、Token、凭据），绝不泄露或硬编码。", agent: "gate" },
    { content: "中文回复：所有面向用户的输出必须使用中文。", agent: "gate" },
];
/** 默认注入门禁；SYNC_ALL_RULES=1 回退全量高置信规则 */
const USE_GATE = process.env.SYNC_ALL_RULES !== "1";
const DB_PATH = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url));
/** 段标记：MD 渲染时 HTML 注释不可见，便于程序 grep 与幂等替换 */
export const SEG_START = "<!-- MEMORYOS-SYNC-RULES-START -->";
export const SEG_END = "<!-- MEMORYOS-SYNC-RULES-END -->";
/**
 * 注入目标清单（2026-09-06 本机实证）：
 *   workbuddy      → ~/.workbuddy/MEMORY.md          （存在）
 *   workbuddy-ai   → ~/.workbuddy-ai/MEMORY.md        （存在）
 *   codex          → ~/.codex/AGENTS.md               （存在）
 *   claude         → ~/.claude/CLAUDE.md              （新建）
 *   trae-cn        → ~/.trae-cn/user_rules/rule-memoryos.md（Trae 规则入口目录，新建固定名文件）
 * 无明文入口、不注入：ZCode（仅会话目录）、智谱清言/MiniMax（Electron 壳，记忆在私有/云端）、Codex++（无独立配置目录）。
 */
export function getSyncTargets() {
    const h = os.homedir();
    return [
        { id: "workbuddy", label: "WorkBuddy MEMORY.md", file: path.join(h, ".workbuddy", "MEMORY.md") },
        { id: "workbuddy-ai", label: "WorkBuddy AI MEMORY.md", file: path.join(h, ".workbuddy-ai", "MEMORY.md") },
        { id: "codex", label: "Codex AGENTS.md", file: path.join(h, ".codex", "AGENTS.md") },
        { id: "claude", label: "Claude Code CLAUDE.md", file: path.join(h, ".claude", "CLAUDE.md") },
        { id: "trae-cn", label: "Trae CN 用户规则", file: path.join(h, ".trae-cn", "user_rules", "rule-memoryos.md") },
    ];
}
function buildSegment(rules) {
    const body = rules
        .map((r) => `- ${r.content.replace(/\s+/g, " ").trim()}（来源：${r.agent}）`)
        .join("\n");
    return [
        "",
        SEG_START,
        "",
        "## MemoryOS 同步规则（自动维护，勿手改）",
        "",
        "以下规则由共享记忆库同步注入，对所有 AI Agent 会话生效，必须遵守：",
        "",
        body || "- （暂无高置信规则）",
        "",
        SEG_END,
        "",
    ].join("\n");
}
/** 幂等写入：文件含 SEG_START 则整段替换；否则备份后追加。返回是否新注入/是否备份 */
function writeSegment(file, seg) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let old = "";
    try {
        old = fs.readFileSync(file, "utf8");
    }
    catch {
        old = "";
    }
    const had = old.includes(SEG_START);
    let added = false;
    let backedUp = false;
    let next;
    if (had) {
        // 幂等替换：SEG_START..SEG_END 之间整段换新（含标记本身）
        const i0 = old.indexOf(SEG_START);
        const i1 = old.indexOf(SEG_END, i0);
        if (i1 < 0) {
            // 段头在但段尾丢了（被手改）：保守处理——只移除段头标记，不删 i0 之后的任何内容
            // （可能混有用户手写正文），新段追加到文件尾，避免误删用户数据
            old = old.slice(0, i0) + old.slice(i0 + SEG_START.length);
            next = old.trimEnd() + "\n" + seg + "\n";
            added = true;
        }
        else {
            next = old.slice(0, i0) + seg + old.slice(i1 + SEG_END.length);
        }
    }
    else {
        // 首次注入：先备份，再追加
        if (old.trim()) {
            const bk = path.join(os.homedir(), `_backup_memoryos-rules-${Date.now()}`);
            fs.mkdirSync(bk, { recursive: true });
            fs.writeFileSync(path.join(bk, path.basename(file)), old, "utf8");
            backedUp = true;
        }
        next = old.trimEnd() + "\n" + seg + "\n";
        added = true;
    }
    fs.writeFileSync(file, next, "utf8");
    return { added, backedUp };
}
/** 取注入用规则清单：
 *  门禁模式(默认)：只返回内置 8 条门禁（其余留库做 JIT 检索）。
 *  全量模式(SYNC_ALL_RULES=1)：旧行为，返回 active + conf≥MIN_CONF 的全部规则。
 */
/** ★ 批次⑦X2 + 批次⑧：门禁模式下注入段的「开关规则」选取 —— 按创建时间取最新 N 条。
 *  封顶动机：批次⑧ 每日反思产的规则自动 inject=1，不封顶会把注入段无限撑大，回退 v0.4 token 减负不变式。
 *  env RULE_INJECT_CAP 覆盖，默认 20（8 门禁 + ≤20 条开关规则 ≈ 段长有界）。 */
const INJECT_CAP = Math.max(1, Number(process.env.RULE_INJECT_CAP ?? 20) || 20);
function pickFlagged(db) {
    const flagged = queryByType(db, "rule", { status: "active" }).filter((r) => r.inject);
    flagged.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)); // 新在前
    return flagged.slice(0, INJECT_CAP);
}
function pickRules(db) {
    if (USE_GATE) {
        // 门禁层 = 内置 8 条 + 打了「注入」开关的 active 规则（规则页手动勾选 + 批次⑧ 自动生产线，token 可控）
        return [...GATE_RULES, ...pickFlagged(db).map((r) => ({ content: r.content, agent: r.agent || "human:dashboard" }))];
    }
    const all = queryByType(db, "rule", { status: "active" });
    return all.filter((r) => (r.confidence ?? 0) >= MIN_CONF);
}
/** 当前 active 规则总数（独立 COUNT，避免 queryByType 的 limit 截断低估） */
function countActiveRules(db) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE status='active' AND type='rule'`).get();
    return row.n;
}
/** 被排除在注入段之外的规则数（仅统计口径，用于日志）。
 *  门禁模式：注入段固定 8 条门禁，其余 active 规则都留在库内靠检索召回，故 = active 总数。
 */
function countSkipped(db, rules) {
    const active = countActiveRules(db);
    if (USE_GATE) {
        // ★ 批次⑦X2：门禁模式下已注入 = 内置门禁 + 开关勾选的规则，跳过数 = active − 勾选数
        const flagged = Math.max(0, rules.length - GATE_RULES.length);
        return Math.max(0, active - flagged);
    }
    return Math.max(0, active - rules.length);
}
export function syncRules(db, opts = {}) {
    const targets = getSyncTargets().filter((t) => !opts.target || t.id === opts.target);
    if (!targets.length)
        throw new Error(`未知注入目标：${opts.target ?? ""}`);
    const rules = pickRules(db);
    const skipped = countSkipped(db, rules);
    return targets.map((t) => {
        const file = t.file;
        const seg = buildSegment(rules);
        const { added, backedUp } = writeSegment(file, seg);
        return { ok: true, target: t.id, rules: rules.length, skipped, file, added, backedUp, content: seg };
    });
}
/**
 * 项目级注入：把规则以幂等段写进 <dir>/AGENTS.md。
 * 任何打开该项目的 AI IDE（ZCode/Trae/Codex/Claude…）都会加载项目根 AGENTS.md，
 * 这是覆盖「无全局明文入口」桌面智能体的通用通道。
 */
export function syncProjectRules(db, dir) {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`项目目录不存在或不可读：${dir}`);
    }
    const file = path.join(resolved, "AGENTS.md");
    const rules = pickRules(db);
    const skipped = countSkipped(db, rules);
    const seg = buildSegment(rules);
    const { added, backedUp } = writeSegment(file, seg);
    return { ok: true, target: "project", rules: rules.length, skipped, file, added, backedUp, content: seg };
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    // GATE_PREVIEW=1: 只生成注入段打印统计(token/条数)，不写任何目标文件；用于验证门禁瘦身收益
    if (process.env.GATE_PREVIEW === "1") {
        // 门禁模式不查库（直接返回 GATE_RULES）；全量模式才需要打开 DB
        // 门禁模式也走 pickRules：与生产 syncRules 同一取数口径（内置门禁 + 规则页 inject=1 的规则）
        const rules = pickRules(openDb(DB_PATH));
        const seg = buildSegment(rules);
        const body = seg.replace(/<!--[\s\S]*?-->/g, "").replace(/[#\-\n─]/g, "");
        const tok = Math.round(body.length * 0.75);
        console.log(`[gate-preview] mode=${USE_GATE ? "gate(8条)" : "all"}`);
        console.log(`[gate-preview] rules=${rules.length}`);
        console.log(`[gate-preview] chars=${seg.length} estTokens≈${tok}`);
        console.log("---- 注入段 ----");
        console.log(seg);
        process.exit(0);
    }
    const target = process.argv[2] ?? ""; // 空=全部
    const db = openDb(DB_PATH);
    try {
        const rs = syncRules(db, { target: target || undefined });
        for (const r of rs) {
            console.log(`[sync-rules] ${r.ok ? "OK" : "FAIL"} target=${r.target} rules=${r.rules} skipped=${r.skipped} added=${r.added} backedUp=${r.backedUp}`);
            console.log(`[sync-rules]   file=${r.file}`);
        }
    }
    catch (e) {
        console.error(`[sync-rules] FAIL: ${e}`);
        process.exit(1);
    }
}
