/** T8（P2-3）：buildApp 路由域拆分 —— knowledge 域。
 * handler 自 dashboard.js 原行 2397-2727 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { syncNotesIndex, demoteNoteLinks, writeNoteToVault } from "./obsidian-sync.js";
import { getEmbedder } from "./embed.js";
import { detectSkillTargets } from "./skill-sync.js";
import { resolveLlm, runAgent, buildSystemPrompt } from "./agent-core.js";
import { unprotectSecret } from "./secret-store.js";
import fs from "node:fs";
import path from "node:path";
export function registerKnowledge(app, ctx) {
    const { db, restricted, RESTRICTED, readDiskConfig, getAgentMcp, resetAgentMcp } = ctx;
    // —— Agent 画像（泳道 + 负载）——
    app.get("/api/agents", async () => {
        const targets = detectSkillTargets();
        const loadRows = db.prepare(`SELECT assignee, COUNT(*) c FROM cards WHERE status IN ('running','ready') AND assignee IS NOT NULL GROUP BY assignee`).all();
        const load = new Map(loadRows.map((r) => [r.assignee, r.c]));
        return {
            agents: (Array.isArray(targets) ? targets : []).map((a) => ({
                id: a?.name ?? a?.id ?? String(a),
                load: load.get(a?.name ?? a?.id ?? String(a)) ?? 0,
            })),
        };
    });
    // —— 知识图谱（H1 统一图 + H4 secret 折叠 + R2-1 上限 200 + focus/depth BFS）——
    app.get("/api/graph", async (req) => {
        const scope = String(req.query.scope ?? "all").trim() || "all";
        const depth = Math.min(Math.max(Number(req.query.depth) || 1, 1), 3);
        const focusRaw = String(req.query.focus ?? "").trim();
        const sectorFilter = String(req.query.sector ?? "").trim();
        const kinds = scope === "note" ? ["note"] : scope === "memory" ? ["memory"] : scope === "card" ? ["card"] : ["note", "memory", "card"];
        const nodes = [];
        const edges = [];
        const nodeMap = new Map();
        const keyOf = (kind, id) => `${kind}:${id}`;
        const addNode = (kind, id, label, sector) => {
            const k = keyOf(kind, id);
            if (!nodeMap.has(k)) {
                nodeMap.set(k, nodes.length);
                nodes.push({ id: k, kind, label: String(label).slice(0, 60), sector, degree: 0 });
            }
            return nodeMap.get(k);
        };
        // 节点池（secret 记忆折叠为占位节点，R5-4）
        let secretCount = 0;
        if (kinds.includes("note")) {
            const notes = db.prepare(`SELECT id, title, sector FROM notes`).all();
            for (const n of notes)
                addNode("note", n.id, n.title, n.sector);
        }
        if (kinds.includes("memory")) {
            const mems = db
                .prepare(`SELECT id, content, sector, sensitivity FROM memories WHERE status='active' AND sensitivity != 'secret'`)
                .all();
            for (const m of mems)
                addNode("memory", m.id, m.content.slice(0, 60), m.sector);
            secretCount = Number(db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='active' AND sensitivity='secret'`).get().c);
        }
        if (kinds.includes("card")) {
            const cards = db.prepare(`SELECT id, title, kind FROM cards WHERE status NOT IN ('archived','cancelled')`).all();
            for (const c of cards)
                addNode("card", c.id, `${c.title.slice(0, 50)}`, c.kind);
        }
        if (secretCount > 0)
            addNode("memory", -1, `secret ×${secretCount}`, "secret");
        // 边：links 表（note/memory/card 互通）
        const linkRows = db.prepare(`SELECT src_kind, src_id, dst_kind, dst_id, kind FROM links WHERE dst_id IS NOT NULL`).all();
        for (const l of linkRows) {
            const s = nodeMap.get(keyOf(l.src_kind, l.src_id));
            const t = nodeMap.get(keyOf(l.dst_kind, l.dst_id));
            if (s === undefined || t === undefined)
                continue;
            edges.push({ source: nodes[s].id, target: nodes[t].id, kind: l.kind });
        }
        // focus/depth BFS 过滤（内存图）
        if (focusRaw) {
            const fk = nodeMap.get(focusRaw);
            if (fk !== undefined) {
                const adj = new Map();
                for (const e of edges) {
                    const s = nodeMap.get(e.source);
                    const t = nodeMap.get(e.target);
                    (adj.get(s) ?? adj.set(s, []).get(s)).push(t);
                    (adj.get(t) ?? adj.set(t, []).get(t)).push(s);
                }
                const keep = new Set([fk]);
                let frontier = [fk];
                for (let d = 0; d < depth && frontier.length; d++) {
                    const next = [];
                    for (const n of frontier)
                        for (const m of adj.get(n) ?? [])
                            if (!keep.has(m)) {
                                keep.add(m);
                                next.push(m);
                            }
                    frontier = next;
                }
                const keepNodes = nodes.filter((_, i) => keep.has(i));
                const keepSet = new Set(keepNodes.map((n) => n.id));
                const keepEdges = edges.filter((e) => keepSet.has(e.source) && keepSet.has(e.target));
                return { nodes: keepNodes, edges: keepEdges, truncated: false, secret_folded: secretCount > 0 };
            }
        }
        // 全局图：按度数截断到 200
        const degreeMap = new Map();
        for (const e of edges) {
            degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
            degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
        }
        nodes.forEach((n, i) => { n.degree = degreeMap.get(n.id) ?? 0; });
        let finalNodes = nodes;
        let truncated = false;
        if (nodes.length > 200) {
            finalNodes = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 200);
            truncated = true;
        }
        const keepIds = new Set(finalNodes.map((n) => n.id));
        const finalEdges = edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target));
        if (sectorFilter) {
            const kept = finalNodes.filter((n) => n.sector === sectorFilter);
            const keptIds = new Set(kept.map((n) => n.id));
            return { nodes: kept, edges: finalEdges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target)), truncated, secret_folded: secretCount > 0 };
        }
        return { nodes: finalNodes, edges: finalEdges, truncated, secret_folded: secretCount > 0 };
    });
    // —— 反向链接（linked/unlinked/outgoing/unresolved）——
    app.get("/api/backlinks", async (req, reply) => {
        const kind = String(req.query.kind ?? "note").trim() || "note";
        const id = Number(req.query.id);
        if (!id)
            return reply.code(400).send({ ok: false, error: "id 必填" });
        const outgoing = db
            .prepare(`SELECT dst_kind, dst_id, dst_title, kind, anchor, alias, context FROM links WHERE src_kind=? AND src_id=?`)
            .all(kind, id);
        const linked = db
            .prepare(`SELECT src_kind, src_id, context FROM links WHERE dst_kind=? AND dst_id=?`)
            .all(kind, id);
        const unresolved = outgoing.filter((l) => l.dst_id === null);
        // unlinked mentions（简化：note 目标按标题 LIKE 检索正文含标题但无 [[ ]] 的候选）
        let unlinked = [];
        if (kind === "note") {
            const me = db.prepare(`SELECT title, vault_root FROM notes WHERE id=?`).get(id);
            if (me) {
                const title = me.title;
                unlinked = db
                    .prepare(`SELECT id, body FROM notes WHERE vault_root=? AND id<>? AND body LIKE ? LIMIT 10`)
                    .all(me.vault_root, id, `%${title}%`).map((r) => {
                    const i = r.body.indexOf(title);
                    return { note_id: r.id, snippet: r.body.slice(Math.max(0, i - 40), i + 60) };
                });
            }
        }
        return { ok: true, linked, unlinked, outgoing, unresolved };
    });
    // —— 笔记（用户自建 + vault 镜像；POST/PUT/DELETE 走写盘 + 索引同步）——
    app.get("/api/notes", async (req) => {
        const where = [];
        const params = [];
        if (req.query.vault) {
            where.push("vault_root=?");
            params.push(req.query.vault);
        }
        if (req.query.origin) {
            where.push("origin=?");
            params.push(req.query.origin);
        }
        const rows = (where.length
            ? db.prepare(`SELECT id, vault_root, rel_path, title, tags, sector, origin, mtime_ms FROM notes WHERE ${where.join(" AND ")} ORDER BY mtime_ms DESC LIMIT 500`).all(...params)
            : db.prepare(`SELECT id, vault_root, rel_path, title, tags, sector, origin, mtime_ms FROM notes ORDER BY mtime_ms DESC LIMIT 500`).all());
        return { ok: true, notes: rows };
    });
    app.post("/api/notes", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "noteCreate");
        const b = req.body ?? {};
        const vault = String(b.vault ?? "").trim();
        const title = String(b.title ?? "").trim();
        const content = String(b.content ?? "").trim();
        if (!vault || !title)
            return reply.code(400).send({ ok: false, error: "vault/title 必填" });
        // 复用 writeNoteToVault：写盘（MemoryOS 写入/）+ 同步记忆库 + notes 镜像 + links + M5 回填
        try {
            const embedder = await getEmbedder();
            const r = await writeNoteToVault(db, embedder, {
                vaultPath: vault,
                title,
                content: content || title,
                agent: "human:dashboard",
            });
            return { ok: true, file: r.file, note_path: r.notePath, memory_id: r.memoryId, created: r.created };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
    app.put("/api/notes/:id", async (req, reply) => {
        const id = Number(req.params.id);
        const n = db.prepare(`SELECT * FROM notes WHERE id=?`).get(id);
        if (!n)
            return reply.code(404).send({ ok: false, error: "笔记不存在" });
        const content = String(req.body?.content ?? "").trim();
        if (!content)
            return reply.code(400).send({ ok: false, error: "内容不能为空" });
        const filePath = path.join(n.vault_root, n.rel_path);
        // R4-7：写盘前读 hash，不一致（用户在外改过）→ 写 merge 副本，不覆盖
        const onDisk = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "") : null;
        const bodyMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(onDisk ?? "");
        const diskBody = bodyMatch ? bodyMatch[1].trim() : (onDisk ?? "").trim();
        if (onDisk !== null && diskBody !== content && n.origin === "user") {
            const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const mergePath = `${filePath.slice(0, -3)}.memoryos-merge-${ts}.md`;
            fs.writeFileSync(mergePath, `---\ntitle: ${n.title}\n---\n\n${diskBody}\n`, "utf8");
        }
        const fm = ["---", `title: ${n.title}`, `type: experience`, "source: memoryos", "---"].join("\n");
        fs.writeFileSync(filePath, `${fm}\n\n${content}\n`, "utf8");
        syncNotesIndex(db, n.vault_root);
        return { ok: true, id };
    });
    app.delete("/api/notes/:id", async (req, reply) => {
        const id = Number(req.params.id);
        const n = db.prepare(`SELECT * FROM notes WHERE id=?`).get(id);
        if (!n)
            return reply.code(404).send({ ok: false, error: "笔记不存在" });
        // 软删：移入 .trash（文件）+ 链接退化为未解析（M5）
        const trashDir = path.join(n.vault_root, ".trash");
        fs.mkdirSync(trashDir, { recursive: true });
        const filePath = path.join(n.vault_root, n.rel_path);
        try {
            if (fs.existsSync(filePath))
                fs.renameSync(filePath, path.join(trashDir, path.basename(filePath)));
        }
        catch { /* 文件不存在忽略 */ }
        demoteNoteLinks(db, id);
        db.prepare(`DELETE FROM notes WHERE id=?`).run(id);
        db.prepare(`DELETE FROM links WHERE src_kind='note' AND src_id=?`).run(id);
        return { ok: true, id };
    });

    /* ── Agent（C 路线：dashboard 内置智能体）──────────────────────────────
     * 与 CLI（dist/agent.js）共用 dist/agent-core.js —— 同一个 agent 循环、同一个 MCP 工具面（18 工具），
     * 只是把「大脑」换成可插拔 LLM 端点、「工具客户端」换成 dashboard 进程内 stdio 拉起。
     * LLM 端点：设置页 llmUrl/llmModel（config.json 落盘）优先，环境变量 LLM_* 兜底，默认本地 Ollama qwen3:8b。
     *           API Key 绝不落盘（P-4171）：如需鉴权走环境变量 LLM_API_KEY（config.json 不含明文密钥）。
     * 写门禁：默认全拒（记忆库写操作须先获同意）。前端显式带 allowWrites=true 且非受限模式时才放行写类工具。
     * 无状态：对话历史由前端回传（仅收 user/assistant 文本），服务端不持有会话，重启不丢、也不串号。 */
    /** agent 状态：模型端点 + 工具面 + 写门禁（前端页头直接展示，避免"以为在用 A 其实在用 B"） */
    app.get("/api/agent/status", async () => {
        const disk = readDiskConfig();
        // 密钥：env 优先，否则解 config.json 的 DPAPI 密文（与 llm.js 同口径）
        const key = process.env.LLM_API_KEY || process.env.INGEST_KEY || (disk.llmKeyEnc ? await unprotectSecret(disk.llmKeyEnc) : null);
        const llm = resolveLlm({ baseUrl: disk.llmUrl || undefined, model: disk.llmModel || undefined, apiKey: key || undefined });
        let tools = null;
        let mcpError = null;
        try {
            tools = (await (await getAgentMcp()).tools()).map((t) => t.name);
        }
        catch (e) {
            ctx.resetAgentMcp(); // 拉起失败不缓存坏句柄，下次请求重试
            mcpError = e instanceof Error ? e.message : String(e);
        }
        return {
            ok: true,
            agent: "dashboard-agent",
            llm: {
                model: llm.model,
                baseUrl: llm.baseUrl,
                endpoint: `${llm.baseUrl}/chat/completions`,
                source: disk.llmUrl ? "config.json（设置页）" : "默认本地 Ollama",
                keySet: !!key,
            },
            mcp: { tools: tools ?? [], toolCount: tools?.length ?? 0, error: mcpError },
            writeMode: {
                allowed: !RESTRICTED,
                restricted: RESTRICTED,
                hint: RESTRICTED
                    ? "受限模式：由系统统一派发，agent 仅可读"
                    : "默认只读；勾选「允许写入记忆库」后本次对话内 agent 的写类工具才会执行",
            },
        };
    });
    /** 跑一轮 agent：返回答案 + 工具调用轨迹（前端据此展示"它干了什么"） */
    app.post("/api/agent/chat", async (req, reply) => {
        const b = (req.body ?? {});
        const message = String(b.message ?? "").trim();
        if (!message)
            return reply.code(400).send({ ok: false, error: "message 不能为空" });
        if (message.length > 4000)
            return reply.code(400).send({ ok: false, error: "message 过长（上限 4000 字）" });
        const disk = readDiskConfig();
        const key = process.env.LLM_API_KEY || process.env.INGEST_KEY || (disk.llmKeyEnc ? await unprotectSecret(disk.llmKeyEnc) : null);
        const llm = resolveLlm({ baseUrl: disk.llmUrl || undefined, model: disk.llmModel || undefined, apiKey: key || undefined });
        let mcp;
        try {
            mcp = await getAgentMcp();
        }
        catch (e) {
            ctx.resetAgentMcp();
            return reply.code(503).send({ ok: false, error: "MCP 工具面不可用：" + (e instanceof Error ? e.message : String(e)) });
        }
        const messages = [{ role: "system", content: buildSystemPrompt("dashboard-agent") }];
        for (const h of (Array.isArray(b.history) ? b.history.slice(-12) : [])) {
            const role = h?.role === "assistant" ? "assistant" : h?.role === "user" ? "user" : null;
            const content = String(h?.content ?? "").trim().slice(0, 3000);
            if (role && content)
                messages.push({ role, content });
        }
        messages.push({ role: "user", content: message });
        const allowWrites = b.allowWrites === true && !RESTRICTED;
        const toolLog = [];
        const denied = [];
        const t0 = Date.now();
        const steps = Math.min(Math.max(Number(b.maxSteps) || 8, 1), 16);
        try {
            const r = await runAgent({
                llm, mcp, messages, maxSteps: steps,
                onStep: (s) => {
                    if (s.type === "tool_call")
                        toolLog.push({ tool: s.tool, args: JSON.stringify(s.args ?? {}).slice(0, 240), ok: null });
                    if (s.type === "tool_result") {
                        const last = toolLog[toolLog.length - 1];
                        if (last && last.tool === s.tool)
                            last.ok = s.ok;
                    }
                    if (s.type === "write_denied")
                        denied.push(s.tool);
                },
                // 未获同意 → 写门禁一律拒绝（agent 收到拒绝提示后改为只读作答，不会硬重试）
                writeGate: allowWrites ? null : () => false,
            });
            return {
                ok: true, answer: r.answer, steps: r.steps, llmSteps: r.steps,
                toolLog, deniedWrites: denied, allowWrites, elapsedMs: Date.now() - t0,
                llm: { model: llm.model, baseUrl: llm.baseUrl },
            };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const hint = /fetch failed|ECONNREFUSED|HTTP 500/i.test(msg)
                ? `（LLM 端点 ${llm.baseUrl} 不可达：本地 Ollama 未启动可执行 ollama serve；或在设置页把 llmUrl/llmModel 指向可用端点）`
                : "";
            return reply.code(502).send({ ok: false, error: `agent 执行失败：${msg}${hint}`, toolLog, elapsedMs: Date.now() - t0 });
        }
    });
}
