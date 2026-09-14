/**
 * MemoryOS v0.2 — MCP Server（fastmcp v3 / FastMCP）
 * Tools: memory_write（embed + 去重/冲突预检） / memory_search（混合检索 RRF）
 * 启动：stdio（默认 transport），node dist/server.js
 */
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { openDb, writeMemory, readMemory, dedupeDecisionFast, getVectorsOnProject, bumpConfidence, logUsage, logUsageBatch, logDaemon, appendEvent, setStatus, updateMemory, } from "./db.js";
import { hybridSearch } from "./search.js";
import { funnel, trend, topMemories, zombies, crossTool, usageHealth, REPORT_NAMES } from "./report.js";
import { getEmbedder, embedMode } from "./embed.js";
import { importVault, exportMemories, writeNoteToVault } from "./obsidian-sync.js";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
// —— 运行时身份读取（R3 分工：读写自动带 agent/agent_fpath）——
const DB_PATH = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url)); // fileURLToPath 正确 decode 中文路径
const AGENT = process.env.MEMORY_AGENT ?? "unknown";
const AGENT_FPATH = process.env.MEMORY_AGENT_FPATH ?? null;
function auditAgentIdentity() {
    if (!AGENT_FPATH) {
        console.error(`[warn] MEMORY_AGENT_FPATH 未设置，身份无法佐证（agent=${AGENT}）`);
        return;
    }
    if (!fs.existsSync(path.resolve(AGENT_FPATH))) {
        console.error(`[warn] 配置路径指纹不存在: ${path.resolve(AGENT_FPATH)}（agent=${AGENT}）`);
    }
}
const db = openDb(DB_PATH);
auditAgentIdentity();
// P0① 启动自检：embed 模式兜底告警（存储向量已是 bge-m3 真实嵌入；检索若跑 fake 模式则 query 向量与库不匹配，召回必失效）
const _embedMode = embedMode();
console.error(`[embed] EMBED_MODE=${_embedMode}${_embedMode === "fake" ? "  ⚠ 无语义检索：生产使用需在客户端 MCP 配置注入 EMBED_MODE=local（见 deploy-mcp.mjs 或 dashboard 工具连接页配置示例）" : ""}`);
const server = new FastMCP({
    name: "memory-hub",
    version: "0.2.0",
    instructions: "共享记忆中心（语义检索）。会话开始/执行关键任务前先调用一次 memory_context 一键注入当前项目高价值记忆；提交修复结论/技术决策/隐藏约定/第三方坑时调用 memory_write；需要精确检索时 memory_search（scope 不确定先 memory_projects）。禁写：绝不写入敏感凭据。",
});
/**
 * 工具级错误兜底（P0-2.1）。
 * 现状：本文件注册 16 个工具，但全文件仅 9 处 try/catch —— 未捕获异常会以原始堆栈
 * 形式抛给 MCP 客户端，用户看到的是内部实现细节；涉及嵌入计算 / LLM 调用 / 文件 IO
 * 的工具异常面尤其大。
 * 本包装保证：任何工具异常都被转为结构化文本结果 + stderr 留痕，绝不抛裸异常。
 *
 * 实现方式：覆盖「实例上的 addTool 方法」（实例属性遮蔽原型方法），而非改写 16 个注册点 ——
 * 这样注册点的参数类型推断与可读性完全不变，只在运行时多包一层 try/catch。
 */
const _origAddTool = server.addTool.bind(server);
server.addTool = (def) => {
    const orig = def.execute;
    def.execute = async (...a) => {
        try {
            return await orig.apply(def, a);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[tool:${def.name}] 执行失败: ${msg}`);
            return `⚠ ${def.name} 执行失败：${msg}\n（异常已捕获，会话未中断。若为 SQLite 锁竞争，可稍后重试一次。）`;
        }
    };
    _origAddTool(def);
};
server.addTool({
    name: "memory_write",
    description: "写入一条共享记忆（自动做向量嵌入与去重/冲突预检）。适用时机：>30min 修复 / 技术决策 / 隐藏约定 / 第三方坑。",
    parameters: z.object({
        content: z.string().describe("记忆正文（结构化，含结论 + 依据）"),
        type: z
            .enum(["decision", "experience", "pitfall", "convention"])
            .default("experience")
            .describe("记忆类型"),
        project: z.string().default("global").describe("项目 scope；'global' 存跨项目通用经验"),
        session_id: z.string().optional().describe("当前会话/任务标识（价值度量的 inferred-cited 判定基础）"),
        task_hint: z.string().optional().describe("任务提示词/上下文标签（埋点用）"),
    }),
    async execute(args) {
        // P0② 硬门禁（R1 闭环）：写前提示先检索——软规则（conf 0.9 #671）失效后的代码层兜底
        const _searched = db
            .prepare(`SELECT COUNT(*) c FROM memory_usage WHERE event IN ('search','returned') AND reader_agent=? AND created_at>=datetime('now','-24 hours')`)
            .get(AGENT)?.c ?? 0;
        const _gate = _searched > 0 ? "" : "\n⚠ 本会话近 24h 未调用 memory_search：写前先检索，避免重复沉淀（rule #671 硬门禁）";
        const embedder = await getEmbedder();
        const [emb] = await embedder.embedTexts([args.content]);
        // M-1.3 去重/冲突预检（★ P0-2.1 快速路径：先用 gram 粗筛候选，再 cosine 精排）
        const existing = getVectorsOnProject(db, args.project);
        if (existing.length) {
            // 快速预检：先用 gram 粗筛 top 100 候选，节省全量 cosine 计算
            const d = dedupeDecisionFast(db, args.project, emb, args.content);
            if (d.action === "merge" && d.targetId) {
                bumpConfidence(db, d.targetId, 0.1);
                const t = readMemory(db, d.targetId);
                return `已与 #${t.id} 重复，已合并（confidence+0.1）[${t.type}|${t.agent}|${t.created_at.slice(0, 10)}] ${t.content.replace(/\s+/g, " ").slice(0, 120)}` + _gate;
            }
            if (d.action === "conflict") {
                const row = writeMemory(db, {
                    content: args.content,
                    type: args.type,
                    agent: AGENT,
                    agent_fpath: AGENT_FPATH,
                    project: args.project,
                    embedding: emb,
                    confidence: 0.5, // 疑似冲突低置信入库，供 v0.3 仲裁
                });
                // v0.3 M-2.4：落 conflict_with 指向旧记忆，仲裁队列才有来源
                db.prepare(`UPDATE memories SET conflict_with=? WHERE id=?`).run(d.targetId, row.id);
                appendEvent(db, {
                    memory_id: row.id,
                    op: "possible-conflict",
                    payload: JSON.stringify({ conflict_with: d.targetId, sim: Number(d.sim.toFixed(3)) }),
                });
                logUsage(db, {
                    memory_id: row.id,
                    event: "write",
                    reader_agent: AGENT,
                    writer_agent: AGENT,
                    project: row.project,
                    session_id: args.session_id,
                    task_hint: args.task_hint,
                });
                return `已写入记忆 #${row.id}（⚠ 疑似与 #${d.targetId} 冲突，置信 0.5，待 v0.3 仲裁）[${row.type}|${row.agent}]` + _gate;
            }
        }
        const row = writeMemory(db, {
            content: args.content,
            type: args.type,
            agent: AGENT,
            agent_fpath: AGENT_FPATH,
            project: args.project,
            embedding: emb,
        });
        logUsage(db, {
            memory_id: row.id,
            event: "write",
            reader_agent: AGENT,
            writer_agent: AGENT,
            project: row.project,
            session_id: args.session_id,
            task_hint: args.task_hint,
        });
        const oneLine = row.content.replace(/\s+/g, " ").slice(0, 300);
        return `已写入记忆 #${row.id} [${row.type}|${row.agent}|${row.created_at.slice(0, 10)}] ${oneLine}` + _gate;
    },
});
server.addTool({
    name: "memory_search",
    description: "语义+关键词混合检索共享记忆（RRF 融合，scope 隔离）。适合新任务前 / 改核心模块前 / 遇报错时。跨表述召回：写'时间戳容差5min'，查'签名校验失败'也能命中。",
    parameters: z.object({
        query: z.string().describe("检索描述/关键词"),
        project: z.string().default("global").describe("项目 scope"),
        limit: z.number().int().min(1).max(50).default(10).describe("返回条数"),
        type: z
            .enum(["decision", "experience", "pitfall", "convention", "rule"])
            .optional()
            .describe("按类型过滤（只返回该类型记忆）"),
        agent: z.string().optional().describe("按写入方 agent 过滤（如 trae/codex/zcode）"),
        session_id: z.string().optional().describe("当前会话/任务标识（回访 + inferred-cited 判定基础）"),
        task_hint: z.string().optional().describe("任务标签（埋点用）"),
    }),
    async execute(args) {
        const embedder = await getEmbedder();
        // 自动双 scope：默认(未指定/global 时)同时搜 global + 知识库，合并去重。中文笔记主体在知识库（实证 #3228）。
        // 显式指定非 global scope 则尊重调用方（保持隔离语义）。
        const scopes = !args.project || args.project === "global" ? ["global", "知识库"] : [args.project];
        const results = [];
        const seen = new Set();
        for (const sp of scopes) {
            const hits = await hybridSearch(db, embedder, { query: args.query, project: sp, limit: args.limit });
            for (const h of hits) {
                if (seen.has(h.id))
                    continue;
                // 过滤参数（type/agent）：结果级后置过滤，保持 search.ts 签名不变（最小改动）
                if (args.type && h.type !== args.type)
                    continue;
                if (args.agent && h.agent !== args.agent)
                    continue;
                seen.add(h.id);
                results.push(h);
            }
        }
        const hits = results.slice(0, args.limit);
        // M-1.5: 调用计数埋点。search 每次只需记 1 条（含零命中），与 returned 区分"调用次数"与"命中条数"。
        // 修正口径：零命中（最需要写记忆的场景）也必须计入，否则门禁会把"搜了但无果"误判成"没搜过"。
        const hitRef = hits[0] ?? { id: 0, agent: AGENT, project: args.project };
        // M-1.5 + PerfOpt-3：1 条 search + N 条 returned 合并为单事务批量写入
        //   （写入内容与逐条 logUsage 完全一致，立即落库；仅 I/O 形态从 N 次提交变 1 次）
        logUsageBatch(db, [
            {
                memory_id: hitRef.id,
                event: "search",
                reader_agent: AGENT,
                writer_agent: hitRef.agent,
                project: hitRef.project,
                session_id: args.session_id,
                task_hint: args.task_hint,
            },
            ...hits.map((h) => ({
                memory_id: h.id,
                event: "returned",
                reader_agent: AGENT,
                writer_agent: h.agent,
                project: h.project,
                session_id: args.session_id,
                task_hint: args.task_hint,
            })),
        ]);
        if (hits.length === 0) {
            // 零命中降级：FTS 探测其他 project 是否有相关内容（只报数量，不返回正文，保持 scope 隔离）
            const q = args.query.trim().replace(/["'()*]/g, " ").replace(/\s+/g, " ").trim();
            let hint = "";
            if (q.length >= 3) {
                const esc = q.replace(/"/g, '""');
                try {
                    const probe = db
                        .prepare(`SELECT m.project project, COUNT(*) c
                 FROM memories_fts f
                 JOIN memories m ON m.id = f.rowid
                WHERE f MATCH ?
                  AND m.project != ?
                  AND m.status = 'active'
                GROUP BY m.project ORDER BY c DESC LIMIT 5`)
                        .all(`"${esc}"`, args.project);
                    const others = probe.filter((r) => r.project !== args.project);
                    if (others.length) {
                        hint = `\n🔍 其他 project 有关键词相关内容（语义未验证）：${others.map((p) => `${p.project}(${p.c})`).join("、")}。可指定对应 project 重搜；不确定有哪些 scope 可调 memory_projects。`;
                    }
                }
                catch (e) {
                    hint = "";
                    console.error(`[search] 跨 scope FTS 探测失败（已降级为空提示）：${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (!hint && args.project !== "global") {
                // 指定 scope 零命中时，提示默认 global 也可能有通用内容
                hint = `\n可将 project 改为 global 重试（当前 scope=${args.project} 无命中）。`;
            }
            return `未命中任何记忆（scope=${args.project}）。${hint || `\n（可在相关修复/决策后 memory_write 沉淀。）`}`;
        }
        const body = hits
            .map((h) => `#${h.id} [${h.type}|${h.agent}|${h.created_at.slice(0, 10)}](conf=${h.confidence.toFixed(2)}) ${h.content
            .replace(/\s+/g, " ")
            .slice(0, 220)}`)
            .join("\n");
        return `命中 ${hits.length} 条${embedMode() !== "fake" ? "" : "（fake-embed：跨表述命中需 EMBED_MODE=local/api）"}:\n${body}`;
    },
});
/** 调用本地 LLM 生成问答答案（RGA：仅基于记忆作答）。30s 超时防挂起，失败抛错由工具层降级。 */
async function askLlm(system, user) {
    const url = process.env.MIMOS_URL?.trim() || "http://127.0.0.1:18900/v1/chat/completions";
    const model = process.env.INGEST_MODEL?.trim() || "agnes-2.5-flash";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: ctrl.signal,
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
                max_tokens: 600,
                temperature: 0.3,
            }),
        });
        if (!res.ok)
            throw new Error(`LLM HTTP ${res.status}`);
        const data = (await res.json());
        const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
        if (!text)
            throw new Error("LLM 空回复");
        return text;
    }
    finally {
        clearTimeout(t);
    }
}
/** 清洗命中记忆正文：剥掉 LLM 提炼时误包进来的 JSON 字符串（如 {"content":"...","type":"..."}），保留纯文本。 */
function cleanMemoryText(content) {
    const t = content.trim();
    if (t.startsWith("{") && t.endsWith("}")) {
        try {
            const j = JSON.parse(t);
            const c = j?.content;
            if (typeof c === "string" && c.trim())
                return c.trim();
        }
        catch {
            /* 不是合法 JSON，按原文返回 */
        }
    }
    return t;
}
server.addTool({
    name: "memory_ask",
    description: "记忆库问答（RGA：Retrieve→Generate）。检索命中记忆后，让 LLM 仅基于这些记忆生成答案，每条结论标注引用来源 [#记忆ID]，禁止编造记忆之外的内容。适合『直接要答案』而非『要原始记忆列表』的场景：如问本库沉淀过什么结论/踩坑/约定。需要原始命中列表仍用 memory_search；本工具为只读，不写库。",
    parameters: z.object({
        query: z.string().describe("要回答的问题（用作检索词，建议直接写问题）"),
        project: z.string().default("global").describe("项目 scope，默认 global（同时搜 global + 知识库）"),
        limit: z.number().int().min(1).max(20).default(8).describe("参与回答的命中记忆条数"),
        session_id: z.string().optional().describe("当前会话/任务标识（埋点用）"),
        task_hint: z.string().optional().describe("任务标签（埋点用）"),
    }),
    async execute(args) {
        const embedder = await getEmbedder();
        // 与 memory_search 同款自动双 scope：默认搜 global + 知识库，显式指定则尊重
        const scopes = !args.project || args.project === "global" ? ["global", "知识库"] : [args.project];
        const seen = new Set();
        const hits = [];
        for (const sp of scopes) {
            const res = await hybridSearch(db, embedder, { query: args.query, project: sp, limit: args.limit });
            for (const h of res) {
                if (seen.has(h.id))
                    continue;
                seen.add(h.id);
                hits.push(h);
            }
        }
        const top = hits.slice(0, args.limit);
        // 埋点：与 memory_search 对齐（search 一次 + returned 每条）；PerfOpt-3 单事务批量
        const hitRef = top[0] ?? { id: 0, agent: AGENT, project: args.project };
        logUsageBatch(db, [
            {
                memory_id: hitRef.id,
                event: "search",
                reader_agent: AGENT,
                writer_agent: hitRef.agent,
                project: hitRef.project,
                session_id: args.session_id,
                task_hint: args.task_hint,
            },
            ...top.map((h) => ({
                memory_id: h.id,
                event: "returned",
                reader_agent: AGENT,
                writer_agent: h.agent,
                project: h.project,
                session_id: args.session_id,
                task_hint: args.task_hint,
            })),
        ]);
        if (top.length === 0) {
            return `记忆库中未找到与「${args.query}」相关的记忆（scope=${args.project}）。可在相关修复/决策后 memory_write 沉淀，之后此问题即可被回答。`;
        }
        // 清洗后拼上下文：剥 JSON 包裹 + 压缩空白，保留引用 ID
        const ctx = top
            .map((h) => `[#${h.id}] ${cleanMemoryText(h.content).replace(/\s+/g, " ")}`)
            .join("\n");
        const system = "你是记忆库问答助手。用户问题相关的事实已作为【可用记忆】提供，你必须【仅基于这些记忆】回答，禁止编造或引入记忆之外的知识。" +
            "每条结论后标注引用来源 [#记忆ID]。若记忆不足以回答，直接说「记忆库中未找到足够依据」。回答简洁，≤250 字。";
        try {
            const answer = await askLlm(system, `问题：${args.query}\n\n【可用记忆】\n${ctx}`);
            return answer;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[memory_ask] LLM 生成失败（降级为检索结果）：${msg}`);
            // 降级：LLM 不可用时退回原始命中列表，不空手返回
            const body = top
                .map((h) => `#${h.id} [${h.type}|${h.agent}|${h.created_at.slice(0, 10)}](conf=${h.confidence.toFixed(2)}) ${cleanMemoryText(h.content).replace(/\s+/g, " ").slice(0, 220)}`)
                .join("\n");
            return `⚠ LLM 生成失败（${msg}），已降级返回原始检索命中：\n命中 ${top.length} 条:\n${body}`;
        }
    },
});
server.addTool({
    name: "memory_projects",
    description: "列出记忆库所有可用 project 及各自记忆条数。memory_search 的 project 参数取值以此为准；scope 不确定时先看一眼再决定搜哪个。避免因不知道存在某 project 而漏检。",
    parameters: z.object({}),
    async execute() {
        const rows = db
            .prepare(`SELECT project, COUNT(*) c FROM memories WHERE status='active' GROUP BY project ORDER BY c DESC`)
            .all();
        return "可用 project（active 条数）：\n" + rows.map((r) => `- ${r.project} (${r.c})`).join("\n");
    },
});
server.addTool({
    name: "memory_context",
    description: "会话开始/执行关键任务前调用一次：一键拉取当前项目的高价值记忆摘要注入上下文，省去多次 memory_search。返回：①当前 scope 的 Top-N 高价值记忆（按引用/曝光/命中排序）②可用 project 清单 ③当前 agent 身份。适合『开工前先注入相关记忆』的场景——避免只写不搜（R1 闭环）。",
    parameters: z.object({
        project: z.string().default("global").describe("项目 scope；只注入该 scope 高价值记忆（含 global 通用）"),
        limit: z.number().int().min(1).max(20).default(5).describe("注入的高价值记忆条数（Top 5 默认）"),
        focus: z.string().optional().describe("可选任务主题词。填写后注入『与该主题最相关』的记忆（语义+词法混合检索），而非全库曝光榜——让注入贴合当前任务"),
        session_id: z.string().optional().describe("当前会话/任务标识（价值度量）"),
        task_hint: z.string().optional().describe("任务标签（埋点用）"),
    }),
    async execute(args) {
        // ① 注入记忆：传 focus → 主题近邻（hybridSearch，语义+词法，含意图聚焦动态加权）；不传 → 全库曝光榜 topMemories
        let top;
        if (args.focus) {
            const embedder = await getEmbedder();
            const hits = await hybridSearch(db, embedder, { query: args.focus, project: args.project, limit: args.limit });
            // 统一成 topMemories 形状（cited/returned 无则补 0）
            top = hits.map((h) => ({ id: h.id, content: h.content, type: h.type, agent: h.agent, cited: 0, returned: 0, hit_count: 0, confidence: h.confidence, project: h.project }));
        }
        else {
            top = topMemories(db, { project: args.project, limit: args.limit });
            // ★ H4/R5-1：曝光榜不走 hybridSearch（已 SQL 过滤 secret），这里补一层剥除
            if (top.length) {
                const ph = top.map(() => "?").join(",");
                const sens = db
                    .prepare(`SELECT id, sensitivity FROM memories WHERE id IN (${ph})`)
                    .all(...top.map((t) => t.id));
                const secretSet = new Set(sens.filter((s) => s.sensitivity === "secret").map((s) => s.id));
                if (secretSet.size)
                    top = top.filter((t) => !secretSet.has(t.id));
            }
        }
        const scopes = db
            .prepare(`SELECT project, COUNT(*) c FROM memories WHERE status='active' GROUP BY project ORDER BY c DESC`)
            .all();
        // ② 埋点：视为一次 context 注入（帮助漏斗追踪"自动注入"，区别于手动 search）；PerfOpt-3 批量
        const injectedRows = [];
        for (const t of top) {
            const writer_agent = db.prepare(`SELECT agent FROM memories WHERE id=?`).get(t.id)?.agent ?? AGENT;
            const proj = db.prepare(`SELECT project FROM memories WHERE id=?`).get(t.id)?.project ?? args.project;
            injectedRows.push({
                memory_id: t.id,
                // ★ 口径修正（2026-09-12）：memory_context 是"开工自动注入"，不是用户主动检索。
                // 原记 returned 污染了 usage-health 的检索命中数（注入曝光 ≈946 远超真实命中）。
                // 现独占 injected 事件，与 memory_search/memory_ask 的检索 returned 彻底分离。
                event: "injected",
                reader_agent: AGENT,
                writer_agent,
                project: proj,
                session_id: args.session_id,
                task_hint: args.task_hint,
            });
        }
        logUsageBatch(db, injectedRows);
        const head = top.length
            ? top.map((t) => `#${t.id} [${t.type}|${t.agent}]${args.focus ? "" : ` cited=${t.cited} hit=${t.hit_count}`} conf=${t.confidence.toFixed(2)}: ${t.content.replace(/\s+/g, " ").slice(0, 120)}`).join("\n")
            : "（该 scope 暂无相关记忆，可 memory_write 沉淀）";
        const scopeStr = scopes.map((s) => `- ${s.project} (${s.c})`).join("\n");
        const rankNote = args.focus
            ? `按『${args.focus}』主题相关度排序（语义+词法混合检索）`
            : "按引用/曝光排序（全库曝光榜）";
        return (`【MemoryContext 注入 · agent=${AGENT} · scope=${args.project}】\n` +
            `相关记忆 Top${Math.min(top.length, args.limit)}（${rankNote}）：\n${head}\n\n` +
            `可用 project（active 条数）：\n${scopeStr}\n\n` +
            `用法：先看上面的记忆是否含相关结论；再针对当前任务用 memory_search 精确检索；执行完沉淀用 memory_write。`);
    },
});
server.addTool({
    name: "memory_read",
    description: "按 id 读取单条记忆的**完整正文**（不受 memory_search 的 220 字截断限制）。适合：search 命中的片段想展开看全文、需要精确引用记忆细节时。返回全文 + 类型/来源/置信/创建时间。",
    parameters: z.object({
        memory_id: z.number().int().min(1).describe("要读取的记忆 id"),
        session_id: z.string().optional().describe("当前会话/任务标识（价值度量）"),
        task_hint: z.string().optional().describe("任务标签（埋点用）"),
    }),
    async execute(args) {
        const row = readMemory(db, args.memory_id);
        if (!row) {
            return `记忆 #${args.memory_id} 不存在。`;
        }
        // ★ H4/R5-1：secret 记忆仅本机前端可读 —— MCP 工具通道一律拒绝返回内容
        if (String(row.sensitivity ?? "normal") === "secret") {
            return `记忆 #${args.memory_id} 为私密记忆（sensitivity=secret），仅本机前端可读，不出现在工具通道。`;
        }
        // 全读也视为一次有效曝光（价值漏斗 returned）
        logUsage(db, {
            memory_id: row.id,
            event: "returned",
            reader_agent: AGENT,
            writer_agent: row.agent,
            project: row.project,
            session_id: args.session_id,
            task_hint: args.task_hint,
        });
        return (`#${row.id} [${row.type}|${row.agent}|${row.project}] conf=${row.confidence.toFixed(2)} status=${row.status} 创建=${row.created_at.slice(0, 10)}\n` +
            `完整正文（${row.content.length} 字）：\n${row.content}`);
    },
});
server.addTool({
    name: "memory_feedback",
    description: "对一条记忆标记『已过时/有误』——纠错闭环。Agent 发现记忆内容已过期或不正确时调用，把该记忆 soft-reject（status=rejected，不再进入检索；不物理删除、可追溯审计）。区别于 memory_cite（正向采用）与 memory_write（新增沉淀），本工具是负向修正通道。",
    parameters: z.object({
        memory_id: z.number().int().min(1).describe("要标记为过时/错误的记忆 id"),
        reason: z.string().describe("修正原因：为什么这条过期/错误（写入审计留痕）"),
        session_id: z.string().optional().describe("当前会话/任务标识"),
        task_hint: z.string().optional().describe("任务标签"),
    }),
    async execute(args) {
        const row = readMemory(db, args.memory_id);
        if (!row) {
            return `记忆 #${args.memory_id} 不存在，无法反馈。`;
        }
        if (row.status !== "active") {
            return `记忆 #${row.id} 当前状态=${row.status}，非 active，无需再修正。`;
        }
        setStatus(db, row.id, "rejected");
        logDaemon(db, {
            task: "agent-feedback",
            op: "reject",
            memory_id: row.id,
            operator: `agent:${AGENT}`,
            detail: `AI 反馈过时/错误：${String(args.reason ?? "").slice(0, 200)}${args.session_id ? ` (session=${args.session_id})` : ""}`,
        });
        return `已标记记忆 #${row.id} 为过时/有误（status=rejected，不再被检索；原因已审计留痕）。`;
    },
});
server.addTool({
    name: "memory_cite",
    description: "声明实际采用了某条记忆（价值漏斗最后一环，R4）。Agent 在落地方案/修改代码引用到记忆内容时调用；同一任务结束后通常触发一次 write 可被记为 inferred-cited，此工具提供显式的 raw-cited。",
    parameters: z.object({
        memory_id: z.number().int().min(1).describe("被采用记忆的 id"),
        session_id: z.string().optional().describe("当前会话/任务标识"),
        task_hint: z.string().optional().describe("任务标签"),
    }),
    async execute(args) {
        const row = readMemory(db, args.memory_id);
        if (!row) {
            return `记忆 #${args.memory_id} 不存在，无法 cite。`;
        }
        logUsage(db, {
            memory_id: row.id,
            event: "cited",
            reader_agent: AGENT,
            writer_agent: row.agent,
            project: row.project,
            session_id: args.session_id,
            task_hint: args.task_hint,
        });
        bumpConfidence(db, row.id, 0.05); // 被采用强化
        return `已 cite 记忆 #${row.id} [${row.type}|${row.agent}|${row.project}](confidence 已 +0.05)`;
    },
});
server.addTool({
    name: "memory_report",
    description: "周报五查询（价值度量）。funnel=漏斗(w/r/cited/inferred，含 R4 下界口径)；trend=每日 w/r/c 三线；top=高价值 Top；zombies=待归档僵尸；cross_tool=跨工具复用。适用于周报/复盘。",
    parameters: z.object({
        report: z
            .enum(REPORT_NAMES)
            .describe("查询类型：funnel / trend / top / zombies / cross_tool"),
        project: z.string().default("").describe("项目 scope 过滤，空=全部"),
        limit: z.number().int().min(1).max(50).default(10).describe("返回条数（top/zombies/cross_tool）"),
        days: z.number().int().min(1).default(90).describe("zombies 判定：创建超 N 天仍 0 命中"),
    }),
    async execute(args) {
        const p = { project: args.project, limit: args.limit, days: args.days };
        switch (args.report) {
            case "funnel": {
                const f = funnel(db, p);
                return f.map((r) => `${r.event}: ${r.value}`).join("\n") +
                    "\n（R4 下界口径：raw_cited 系统性偏低，升级决策以 inferred_cited 为主）";
            }
            case "trend": {
                const t = trend(db, p);
                if (!t.length)
                    return "暂无埋点数据";
                return t.map((r) => `${r.day}  write=${r.write} returned=${r.returned} cited=${r.cited}`).join("\n");
            }
            case "top": {
                const t = topMemories(db, p);
                if (!t.length)
                    return "暂无记忆";
                return t
                    .map((r) => `#${r.id} [${r.type}|${r.agent}] cited=${r.cited} returned=${r.returned} hit=${r.hit_count} conf=${r.confidence.toFixed(2)} ${r.content
                    .replace(/\s+/g, " ")
                    .slice(0, 100)}`)
                    .join("\n");
            }
            case "zombies": {
                const z = zombies(db, p);
                if (!z.length)
                    return "无待归档僵尸（active 且超期 0 命中）";
                return z
                    .map((r) => `#${r.id} [${r.type}|${r.agent}] ${r.days}天无命中  ${r.content.replace(/\s+/g, " ").slice(0, 100)}`)
                    .join("\n");
            }
            case "cross_tool": {
                const c = crossTool(db, p);
                if (!c.length)
                    return "暂无跨工具复用（不同 agent 消费过本工具写入）";
                return c.map((r) => `${r.writer_agent} → ${r.reader_agent} (${r.event}) x${r.n}`).join("\n");
            }
            default:
                return "未知 report 类型";
        }
    },
});
server.addTool({
    name: "memory_health",
    description: "查看记忆库『使用侧健康度』（效果监控）：近 N 天 search/write/returned/cited 次数、检索触发率(search/write)、空召回率、写读比，以及各 agent 的使用漏斗。用于诊断『只写不搜』（触发率→0/搜索趋零）和各工具是否真正在用记忆。",
    parameters: z.object({
        days: z.number().int().min(1).max(365).default(30).describe("统计窗口（天，默认近30天）"),
    }),
    async execute(args) {
        const h = usageHealth(db, args.days);
        const lines = [`【Memory 使用健康 · 近${args.days}天】`, `search=${h.search}  write=${h.write}  returned=${h.returned}  cited=${h.cited}`];
        const triggerFlag = h.search_trigger_rate < 1 ? " ⚠ 只写不搜（沉淀>检索）" : "";
        lines.push(`检索触发率(search/write)=${h.search_trigger_rate}${triggerFlag}`);
        lines.push(`空召回率≈${h.empty_recall_rate}  写读比(write/returned)=${h.write_read_ratio}`);
        lines.push(`\n各 agent 使用漏斗（search/returned/cited/write）：`);
        for (const a of h.per_agent) {
            lines.push(`  ${a.agent}: search=${a.search} returned=${a.returned} cited=${a.cited} write=${a.write}`);
        }
        return lines.join("\n");
    },
});
server.addTool({
    name: "obsidian_import",
    description: "把 Obsidian vault 的 .md 笔记增量导入共享记忆库（幂等：按内容哈希，不变跳过/变更更新/新增入库，agent=obsidian，project 默认取 vault 目录名）。适合把本地笔记/知识库沉淀为可检索记忆。",
    parameters: z.object({
        vault: z.string().describe("Obsidian vault 绝对路径（含 .md 笔记的根目录）"),
        project: z.string().optional().describe("project scope，默认取 vault 目录名"),
        dry_run: z.boolean().default(false).describe("预演：只统计不落库"),
    }),
    async execute(args) {
        try {
            const embedder = await getEmbedder();
            const stats = await importVault(db, embedder, {
                vaultPath: args.vault,
                project: args.project,
                dryRun: args.dry_run,
                agent: "obsidian",
            });
            return `扫描 ${stats.scanned} 个笔记 → 新增 ${stats.added} / 更新 ${stats.updated} / 去重合并 ${stats.merged} / 跳过 ${stats.skipped} / 失败 ${stats.failed}（project=${stats.project}${stats.dryRun ? "，dry-run 未落库" : ""}）`;
        }
        catch (e) {
            return `obsidian_import 失败：${e instanceof Error ? e.message : String(e)}`;
        }
    },
});
server.addTool({
    name: "obsidian_export",
    description: "把记忆库中 active 记忆导出为 Markdown 笔记（带溯源 frontmatter），写入 vault/MemoryOS 导出/，幂等不覆盖。适合把高价值记忆沉淀回 Obsidian 复盘。",
    parameters: z.object({
        vault: z.string().describe("Obsidian vault 绝对路径（导出目录 = vault/MemoryOS 导出）"),
        project: z.string().optional().describe("project scope 过滤，缺省=全部"),
        type: z.string().optional().describe("类型过滤（decision/experience/pitfall/convention）"),
        limit: z.number().int().min(1).max(500).optional().describe("导出条数上限（按 id 升序）"),
    }),
    async execute(args) {
        try {
            const stats = exportMemories(db, {
                vaultPath: args.vault,
                project: args.project,
                type: args.type,
                limit: args.limit,
            });
            return `导出到 ${stats.dir}：写入 ${stats.written} / 跳过(已存在) ${stats.skipped} / 失败 ${stats.failed}`;
        }
        catch (e) {
            return `obsidian_export 失败：${e instanceof Error ? e.message : String(e)}`;
        }
    },
});
server.addTool({
    name: "obsidian_write_note",
    description: "往 Obsidian vault 写单条笔记（带溯源 frontmatter），同时同步写入共享记忆库（去重预检 + 埋点），并记录 obsidian_sync 元表映射。文件已存在时加时间戳后缀，绝不覆盖。适用：Agent 把修复结论/技术决策/隐藏约定沉淀回 Obsidian 笔记库。",
    parameters: z.object({
        vault: z.string().describe("Obsidian vault 绝对路径"),
        title: z.string().describe("笔记标题（同时用作文件名）"),
        content: z.string().describe("笔记正文（结构化，含结论 + 依据）"),
        type: z
            .enum(["decision", "experience", "pitfall", "convention"])
            .default("experience")
            .describe("记忆类型"),
        project: z.string().default("global").describe("记忆库 project scope（默认 global，所有 Agent 可检索）"),
        folder: z.string().optional().describe("vault 内子文件夹（默认 MemoryOS 写入）"),
    }),
    async execute(args) {
        try {
            const embedder = await getEmbedder();
            const result = await writeNoteToVault(db, embedder, {
                vaultPath: args.vault,
                title: args.title,
                content: args.content,
                type: args.type,
                project: args.project,
                folder: args.folder,
                agent: AGENT,
                agent_fpath: AGENT_FPATH,
            });
            return `已写入笔记 → ${result.notePath}（记忆 #${result.memoryId}，${result.created ? "新建" : "已存在→加时间戳后缀"}，project=${args.project}）`;
        }
        catch (e) {
            return `obsidian_write_note 失败：${e instanceof Error ? e.message : String(e)}`;
        }
    },
});
const TASK_STATUSES = ["pending", "in_progress", "blocked", "review", "done", "failed", "cancelled"];
/** 合法迁移白名单：源状态 → 允许的目标状态（done/cancelled 为终态，无 out-edge） */
const TASK_TRANSITIONS = {
    pending: ["in_progress", "cancelled"],
    in_progress: ["blocked", "review", "done", "failed", "cancelled"],
    blocked: ["in_progress", "cancelled", "failed"],
    review: ["done", "in_progress", "failed"],
    done: [],
    failed: ["in_progress", "cancelled"],
    cancelled: [],
};
/** 存量状态 → v1.1 标准态 归一 */
const TASK_NORMALIZE = { open: "pending", claimed: "in_progress", done: "done" };
/** 校验迁移合法性，非法返回错误提示；空/可写由调用方决定 */
function assertTransition(from, to) {
    const allowed = TASK_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
        return `非法状态迁移 ${from} → ${to}（白名单: ${allowed.join(", ") || "终态不可迁移"}）`;
    }
    return null;
}
/** content 头正则：兼容七态 + 存量三态（open/claimed/done） */
const TASK_HEAD_RE = /^\[task\]\[assignee:[^\]]*\]\[status:([a-z_]+)\]/;
function taskHead(status, assignee) {
    return `[task][assignee:${assignee}][status:${status}]`;
}
/** 依赖段：`[depends:12,15]`（紧跟状态头之后，可缺省） */
const TASK_DEP_RE = /\[depends:([0-9,\s]+)\]/;
function readTaskState(content) {
    const m = content.match(TASK_HEAD_RE);
    if (!m)
        return null;
    const am = content.match(/\[assignee:([^\]]*)\]/);
    const dm = content.match(TASK_DEP_RE);
    const deps = dm ? dm[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : [];
    return { assignee: am ? am[1] : "?", status: TASK_NORMALIZE[m[1]] || m[1], deps };
}
/** 拆掉状态头和依赖段的纯正文 */
function taskBody(content) {
    return content.replace(TASK_HEAD_RE, "").replace(TASK_DEP_RE, "").trim();
}
/** 构造正文时保留依赖段 */
function taskBodyWithDep(status, assignee, deps, body) {
    const depStr = deps.length ? ` [depends:${deps.join(",")}]` : "";
    return `${taskHead(status, assignee)}${depStr} ${body}`;
}
/** 依赖是否全部 done */
function depsSatisfied(deps, doneIds) {
    return deps.every((d) => doneIds.has(d));
}
server.addTool({
    name: "task_assign",
    description: "多 Agent 协同：把任务交给指定 Agent（写 type='task' 记忆，状态 open）。可声明 depends_on 依赖其他任务（多个用 , 分隔），被依赖任务全部 done 后本任务才可做。另一 Agent 用 task_claim 领取、task_done 完成、task_next 查询可做集。",
    parameters: z.object({
        content: z.string().describe("任务描述（不含状态头，工具自动加）"),
        assignee: z.string().describe("接收方 agent 名（如 codex/trae/zcode/claude）"),
        depends_on: z.string().optional().describe("依赖的任务 id，逗号分隔（如 '12,15'）；依赖全 done 后本任务才可做"),
        project: z.string().default("global").describe("任务 scope"),
        session_id: z.string().optional(),
        task_hint: z.string().optional(),
    }),
    async execute(args) {
        const body = args.content.trim();
        const deps = (args.depends_on ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => /^\d+$/.test(s))
            .join(",");
        const full = deps
            ? `${taskHead("pending", args.assignee)} [depends:${deps}] ${body}`
            : `${taskHead("pending", args.assignee)} ${body}`;
        const row = writeMemory(db, {
            content: full,
            type: "task",
            agent: AGENT,
            agent_fpath: AGENT_FPATH,
            project: args.project,
        });
        appendEvent(db, {
            memory_id: row.id,
            op: "task_assign",
            payload: JSON.stringify({ from: AGENT, to: args.assignee, project: args.project, depends: deps || null }),
            operator: `agent:${AGENT}`,
        });
        logUsage(db, {
            memory_id: row.id, event: "write", reader_agent: AGENT, writer_agent: AGENT,
            project: row.project, session_id: args.session_id, task_hint: args.task_hint,
        });
        return `已分派任务 #${row.id} → ${args.assignee}（status=pending）[${row.type}|${row.agent}] ${row.content.replace(/\s+/g, " ").slice(0, 120)}`;
    },
});
server.addTool({
    name: "task_claim",
    description: "多 Agent 协同：领取『分配给我 / 未认领』的 pending 任务，把状态头 pending→in_progress。调用方通常=任务 assignee 或任意可接手 agent。返回当前可领的 pending 任务列表。",
    parameters: z.object({
        as: z.string().optional().describe("以谁的身份领取（缺省=当前 agent）；传 'any' 领取无人认领兜底"),
        project: z.string().default("global").describe("任务 scope"),
        memory_id: z.number().int().optional().describe("指定领取某条任务 id；不填则列出当前可领的 pending 任务"),
        session_id: z.string().optional(),
        task_hint: z.string().optional(),
    }),
    async execute(args) {
        if (args.memory_id) {
            const row = readMemory(db, args.memory_id);
            if (!row || row.type !== "task")
                return `#${args.memory_id} 不存在或非任务。`;
            const st = readTaskState(row.content);
            if (!st)
                return `#${args.memory_id} 任务头格式异常，无法认领。`;
            if (st.status !== "pending")
                return `#${args.memory_id} 当前 status=${st.status}，仅 pending 可认领。`;
            const who = args.as && args.as !== "any" && args.as !== AGENT ? args.as : AGENT;
            if (args.as !== "any" && st.assignee !== "?" && st.assignee !== who) {
                return `#${args.memory_id} 指派给 ${st.assignee}，你不是接收方（可传 as=any 强制托管认领）。`;
            }
            const newContent = taskBodyWithDep("in_progress", who, st.deps, taskBody(row.content));
            updateMemory(db, row.id, { content: newContent }); // 同步 FTS
            appendEvent(db, { memory_id: row.id, op: "task_claim", payload: JSON.stringify({ by: who }), operator: `agent:${AGENT}` });
            return `已认领任务 #${row.id}（status=in_progress by ${who}）：${newContent.replace(/\s+/g, " ").slice(0, 120)}`;
        }
        // 列可领任务：type='task' 且状态头 pending（★ H4：secret 任务不进工具通道）
        const rows = db.prepare(`SELECT id, content, agent, created_at FROM memories
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'
       ORDER BY created_at DESC LIMIT ?`).all(args.project, 50);
        const open = rows.filter((r) => readTaskState(r.content)?.status === "pending");
        if (!open.length)
            return "当前无可领的 pending 任务。";
        return open.map((r) => `#${r.id} [${readTaskState(r.content)?.assignee}] ${r.content.slice(30, 160)}`).join("\n");
    },
});
server.addTool({
    name: "task_done",
    description: "多 Agent 协同：把已认领/待办任务标记为完成（状态头 → done），并把结论追加进任务正文。调用方应为当前认领者或任务接收方。",
    parameters: z.object({
        memory_id: z.number().int().min(1).describe("要完成的记忆 id"),
        conclusion: z.string().describe("完成结论/结果摘要（追加进任务正文）"),
        session_id: z.string().optional(),
        task_hint: z.string().optional(),
    }),
    async execute(args) {
        const row = readMemory(db, args.memory_id);
        if (!row || row.type !== "task")
            return `#${args.memory_id} 不存在或非任务。`;
        const st = readTaskState(row.content);
        if (!st)
            return `#${args.memory_id} 任务头格式异常，无法完成。`;
        if (st.status === "done")
            return `#${args.memory_id} 已完成，无需重复标记。`;
        // v1.1 状态机：仅 in_progress / review → done 合法
        const tErr = assertTransition(st.status, "done");
        if (tErr)
            return `#${args.memory_id} ${tErr}`;
        const body = taskBody(row.content);
        const newContent = `${taskBodyWithDep("done", st.assignee, st.deps, body)}\n→ 结论(${AGENT})：${args.conclusion.trim()}`;
        updateMemory(db, row.id, { content: newContent });
        bumpConfidence(db, row.id, 0.05); // 完成任务强化
        appendEvent(db, { memory_id: row.id, op: "task_done", payload: JSON.stringify({ by: AGENT }), operator: `agent:${AGENT}` });
        return `任务 #${row.id} 已完成（status=done）[${row.type}|${row.agent}] 结论：${args.conclusion.trim().slice(0, 100)}`;
    },
});
server.addTool({
    name: "task_next",
    description: "多 Agent 协同·依赖拓扑：给当前 agent 算出『现在可做的开放任务』（依赖拓扑的入度=0 集）。open 且所有 depends_on 依赖均已 done 的任务才可做；被依赖未完成的任务标记 blocked 并说明卡在哪个依赖。同时列出本人名下已认领/在做的任务。",
    parameters: z.object({
        project: z.string().default("global").describe("任务 scope"),
        as: z.string().optional().describe("以谁的身份查（缺省=当前 agent）；传 '' 或 'any' 查全部可做集"),
        domain: z.boolean().default(false).describe("只返回依赖链中当前可做链路的路径提示（A→B→C）"),
        session_id: z.string().optional(),
        task_hint: z.string().optional(),
    }),
    async execute(args) {
        const rows = db.prepare(`SELECT id, content, agent, source_ref, created_at FROM memories
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'
       ORDER BY julianday(created_at), id ASC LIMIT 500`).all(args.project);
        // 全体任务状态/依赖解码 + done 集合
        const states = new Map();
        const doneIds = new Set();
        for (const r of rows) {
            const st = readTaskState(r.content);
            if (!st)
                continue;
            states.set(r.id, { st });
            if (st.status === "done")
                doneIds.add(r.id);
        }
        const who = !args.as || args.as === "any" ? AGENT : args.as;
        const avail = [];
        const blocked = [];
        const mine = [];
        // ★ A 2026-09-14：区分卡任务 vs 手动任务；B：优先取卡片 priority 排序
        const isCardTask = (r) => String(r.source_ref ?? "").startsWith("card:");
        const cardOf = (r) => {
            const m = String(r.source_ref ?? "").match(/^card:(\d+)$/);
            return m ? Number(m[1]) : null;
        };
        // 一次性拉取所涉卡片的 priority
        const cardIds = [...new Set(rows.map(cardOf).filter((n) => n !== null))];
        const cardPrio = new Map();
        if (cardIds.length) {
            const ph = cardIds.map(() => "?").join(",");
            db.prepare(`SELECT id, priority FROM cards WHERE id IN (${ph})`).all(...cardIds).forEach((r) => cardPrio.set(r.id, Number(r.priority ?? 0)));
        }
        const srcTag = (r) => {
            if (isCardTask(r))
                return `[卡片#${cardOf(r)}]`;
            return "[agent任务]";
        };
        const prioOf = (r) => {
            const cid = cardOf(r);
            return cid !== null ? (cardPrio.get(cid) ?? 0) : 0;
        };
        const tsOf = (r) => Date.parse(r.created_at) || 0;
        for (const r of rows) {
            const s = states.get(r.id)?.st;
            if (!s)
                continue;
            const depDone = depsSatisfied(s.deps, doneIds);
            const blockedBy = s.deps.filter((d) => !doneIds.has(d));
            if (s.status === "pending") {
                if (!args.as || args.as === "any" || s.assignee === who || s.assignee === "?") {
                    if (depDone)
                        avail.push({ prio: prioOf(r), key: tsOf(r), label: `#${r.id} ${srcTag(r)} → ${s.assignee}: ${taskBody(r.content).slice(0, 80)} ${isCardTask(r) ? "(卡)" : ""}` });
                    else
                        blocked.push({ prio: prioOf(r), key: tsOf(r), label: `#${r.id} ${srcTag(r)} 阻塞（等 #${blockedBy.join(",#")}）→ ${taskBody(r.content).slice(0, 60)}` });
                }
            }
            else if (s.status === "in_progress" && s.assignee === who) {
                mine.push(`#${r.id} ${srcTag(r)} 进行中(已认领 by ${s.assignee}): ${taskBody(r.content).slice(0, 80)}`);
            }
        }
        // ★ B 排序：卡片 priority 高优先，同优先级按创建时间旧的在前
        const sortLane = (a, b) => b.prio - a.prio || a.key - b.key;
        avail.sort(sortLane);
        blocked.sort(sortLane);
        let out = `【task_next · as=${who}】\n`;
        out += `可做（pending 且依赖done，按优先级）:\n${avail.length ? avail.map((x) => x.label).join("\n") : "（暂无，检查阻塞项）"}\n\n`;
        out += `阻塞（依赖未完成）:\n${blocked.length ? blocked.map((x) => x.label).join("\n") : "（无）"}\n\n`;
        out += `我在做:\n${mine.length ? mine.join("\n") : "（无进行中任务）"}`;
        return out;
    },
});
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    // 连接心跳：每次 server 被某个客户端 stdio 拉起时留痕（op=connect）。MEMORY_AGENT 由 MCP 配置 env 注入 → 可精确到"哪个 agent 连上了"
    try {
        appendEvent(db, {
            memory_id: null,
            op: "connect",
            payload: JSON.stringify({ agent: AGENT, agent_fpath: AGENT_FPATH, ts: new Date().toISOString() }),
            operator: `agent:${AGENT}`,
        });
    }
    catch {
        /* 心跳失败不阻断启动 */
    }
    await server.start({ transportType: "stdio" });
}
