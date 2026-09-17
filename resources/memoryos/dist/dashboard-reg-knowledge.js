/** T8（P2-3）：buildApp 路由域拆分 —— knowledge 域。
 * handler 自 dashboard.js 原行 2397-2727 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { syncNotesIndex, demoteNoteLinks, writeNoteToVault } from "./obsidian-sync.js";
import { getEmbedder } from "./embed.js";
import { detectSkillTargets } from "./skill-sync.js";
import { resolveLlm, runAgent, buildSystemPrompt } from "./agent-core.js";
import { unprotectSecret } from "./secret-store.js";
import { createRunRegistry, readArtifact, extractArtifactPath, extractTaskHint, simpleDiff } from "./agent-runs.js";
import { resolveInside } from "./exec-tools.js";
import { listAgentSessions, getAgentSession, saveAgentSession, deleteAgentSession, appendAgentSession, compactAgentSession, allExecAudit } from "./db.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
export function registerKnowledge(app, ctx) {
    const { db, restricted, RESTRICTED, readDiskConfig, getAgentMcp, resetAgentMcp, dataDirOf } = ctx;
    // 注：RESTRICTED 顶层常量是 8 个 reg 模块共享的单一判定入口（dashboard.js:46 模块加载时求值）。
    //   桌面 core-process 注入 MEMORY_RESTRICTED=0（默认非受限）；受限演示/冒烟经 env 切换（非 buildApp opts）。
    /* ── Agent 执行中心：per-run 内存模型（模块级单例，注册一次）────────
     * 纪律：呈现层只读/只推，不改 writeGate 行为；审批三键端点未启用一律 501 占位（B1）。
     * F15：SSE 预览 ≤300 字；工具结果全文走 exec artifact（data/artifacts/）按 range 拉取。 */
    const runs = createRunRegistry();
    /** 工作区根（diff 快照的路径边界；与 server.js 执行面同口径） */
    const WORKSPACE_ROOT = path.resolve(process.env.MEMORYOS_WORKSPACE || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", ".."));
    /** 解析 file_write 参数里的路径 → 工作区内真实路径（resolveInside 边界校验：越界/UNC 拒绝，防符号链接逃逸） */
    function safeSnapshotPath(p) {
        try { return resolveInside(WORKSPACE_ROOT, String(p || "")); }
        catch { return null; }
    }
    function readSnapshot(absOrNull) {
        if (!absOrNull) return null;
        try { return fs.existsSync(absOrNull) ? fs.readFileSync(absOrNull, "utf8") : ""; }
        catch { return null; }
    }
    /** 跑一轮后台 agent run：共享 /chat 的 LLM 解析与 MCP 获取口径；onStep 喂 run 事件流。
     *  writeGate 规则与 /chat 完全一致：allowWrites=true 且非受限 才放行写。 */
    async function startRun(handle, b, mcp) {
        const disk = readDiskConfig();
        const key = process.env.LLM_API_KEY || process.env.INGEST_KEY || (disk.llmKeyEnc ? await unprotectSecret(disk.llmKeyEnc) : null);
        const llm = resolveLlm({ baseUrl: disk.llmUrl || undefined, model: disk.llmModel || undefined, apiKey: key || undefined });
        const message = String(b.message ?? "").trim();
        const messages = [{ role: "system", content: buildSystemPrompt("dashboard-agent") }];
        for (const h of (Array.isArray(b.history) ? b.history.slice(-12) : [])) {
            const role = h?.role === "assistant" ? "assistant" : h?.role === "user" ? "user" : null;
            const content = String(h?.content ?? "").trim().slice(0, 3000);
            if (role && content)
                messages.push({ role, content });
        }
        messages.push({ role: "user", content: message });
        const allowWrites = b.allowWrites === true && !RESTRICTED;
        const maxSteps = Math.min(Math.max(Number(b.maxSteps) || 8, 1), 16);
        // 任务联动：用户消息里的「任务 #N」→ run 的 taskHint（呈现层 join 用，不自动 claim，B1）
        const taskHint = b.taskHint != null ? Number(b.taskHint) : extractTaskHint(message);
        handle.run.taskHint = taskHint ?? null;
        // 写文件类步骤的前后快照（diff 数据源在路由层注入；路径经 resolveInside 边界校验，越界不快照）
        let pendingBefore = null;
        let pendingPath = null;
        const onStep = (s) => {
            if (s.type === "tool_call" && s.tool === "file_write") {
                pendingPath = safeSnapshotPath(s.args?.path);
                pendingBefore = readSnapshot(pendingPath);
            }
            if (s.type === "tool_result" && s.tool === "file_write") {
                const sid = handle.run.steps.find((x) => x.tool === "file_write" && x.state === "pending")?.stepId;
                if (sid != null) {
                    const after = readSnapshot(pendingPath);
                    handle.setStepDiff(sid, simpleDiff(pendingBefore ?? "", after ?? "", String(s.args?.path ?? "")));
                    pendingBefore = null;
                    pendingPath = null;
                }
            }
            handle.onStep(s);
            // 大输出：从工具结果全文提取 artifact 路径（exec-tools 截断时回传「完整输出：<abs>」）
            if (s.type === "tool_result" && s.result) {
                const ap = extractArtifactPath(s.result);
                if (ap) handle.run.steps[handle.run.steps.length - 1].artifactPath = ap;
            }
            // 任务联动事件：task_done 成功 → 推 task_done（前端任务看板 join）
            const lastStep = handle.run.steps[handle.run.steps.length - 1];
            if (s.type === "tool_result" && s.tool === "task_done" && s.ok && lastStep?.taskDone) {
                handle.ev("task_done", { taskId: lastStep.taskDone });
            }
        };
        try {
            // ★ A1：中止运行 —— 传 AbortSignal（agent-core 轮次间 + LLM fetch 可中断；
            //   进行中的 mcp.callTool 跑完，不硬杀进程）。
            const r = await runAgent({
                llm, mcp, messages, maxSteps,
                onStep,
                writeGate: allowWrites ? null : () => false,
                signal: handle.run.abortCtrl.signal,
            });
            handle.finish("done", { answer: r.answer, usage: r.usage, estimatedTokens: r.estimatedTokens });
            // 会话持久化：把本轮 user/assistant 追加进 agent_sessions（写入方截断纪律）
            if (b.sessionKey) {
                try {
                    appendAgentSession(db, { sessionKey: b.sessionKey, role: "user", content: message.slice(0, 3000), title: b.title });
                    appendAgentSession(db, { sessionKey: b.sessionKey, role: "assistant", content: r.answer.slice(0, 3000), title: b.title });
                }
                catch { /* 会话写失败不阻断 run */ }
            }
        }
        catch (e) {
            handle.finish("failed", { error: e instanceof Error ? e.message : String(e) });
        }
    }
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
    /**
     * Agent 执行中心（呈现层）：POST /api/agent/runs 立即回 runId，后台跑 runAgent，
     * 过程经 SSE /stream 实时推送；GET /runs、/runs/:id 读全量；artifact 与 sessions 只读/受限写。
     * 纪律：全部「追加」，不改 /chat 行为；审批三键端点未启用 → 501 占位（B1，不静默放行）。 */
    /** 建一个后台 run（立即返回，不阻塞） */
    app.post("/api/agent/runs", async (req, reply) => {
        const b = (req.body ?? {});
        const message = String(b.message ?? "").trim();
        if (!message)
            return reply.code(400).send({ ok: false, error: "message 不能为空" });
        if (message.length > 4000)
            return reply.code(400).send({ ok: false, error: "message 过长（上限 4000 字）" });
        let mcp;
        try {
            mcp = await getAgentMcp();
        }
        catch (e) {
            ctx.resetAgentMcp();
            return reply.code(503).send({ ok: false, error: "MCP 工具面不可用：" + (e instanceof Error ? e.message : String(e)) });
        }
        const handle = runs.createRun({ sessionId: b.sessionKey || undefined, title: b.title || message.slice(0, 60), taskHint: b.taskHint });
        startRun(handle, b, mcp); // 后台跑，不 await；错误在 startRun 内 catch → finish("failed")
        return reply.code(202).send({ ok: true, runId: handle.run.id, sessionKey: b.sessionKey || null });
    });
    /** run 列表（活动 + 终态，内存保留最近 50） */
    app.get("/api/agent/runs", async () => {
        const list = runs.allRuns();
        return { ok: true, runs: list, total: list.length };
    });
    /** 单 run 全量（steps + 事件回放 + 答案） */
    app.get("/api/agent/runs/:id", async (req, reply) => {
        const h = runs.getRun(req.params.id);
        if (!h)
            return reply.code(404).send({ ok: false, error: "run 不存在（内存保留最近 50 个）" });
        const l = h.list();
        return { ok: true, ...l, answer: h.run.answer, events: h.run.events };
    });
    /** SSE 实时流：Last-Event-ID 回补 + 增量推送；断线浏览器自动重连 */
    app.get("/api/agent/runs/:id/stream", async (req, reply) => {
        const h = runs.getRun(req.params.id);
        if (!h)
            return reply.code(404).send({ ok: false, error: "run 不存在" });
        reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
        });
        reply.raw.write(": agent-run stream\n\n");
        let sent = Number(req.headers["last-event-id"] || 0);
        const flush = (type, data, seq) => {
            reply.raw.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const out = [];
        h.evSince(h.run, sent, out);
        for (const e of out)
            flush(e.event, e.data, e.seq);
        const unsub = h.subscribe({
            onEvent: (type, data, seq) => {
                if (seq > sent) {
                    sent = seq;
                    flush(type, data, seq);
                }
            },
        });
        req.raw.on("close", () => unsub());
        if (h.run.status !== "running")
            reply.raw.end();
    });
    /** 大输出按段拉取（exec artifact；range=a-b 0 基；无 artifact 步骤返回内联预览） */
    app.get("/api/agent/runs/:id/steps/:sid/output", async (req, reply) => {
        const h = runs.getRun(req.params.id);
        if (!h)
            return reply.code(404).send({ ok: false, error: "run 不存在" });
        const step = h.run.steps.find((x) => x.stepId === Number(req.params.sid));
        if (!step)
            return reply.code(404).send({ ok: false, error: "步骤不存在" });
        if (!step.artifactPath)
            return { ok: true, inline: step.preview, totalLines: 0, from: 0, to: 0 };
        const dataDir = dataDirOf() || "";
        const r = readArtifact(dataDir, step.artifactPath, req.query.range ? [Number(req.query.range[0]), Number(req.query.range[1])] : null);
        if (!r.ok)
            return reply.code(502).send({ ok: false, error: r.error });
        return { ok: true, ...r };
    });
    /** artifact 下载（只读；RESTRICTED 下 403 体例；basename 白名单 + realpath 边界校验防越界） */
    app.get("/api/artifacts/:id", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const name = String(req.params.id || "").slice(0, 200);
        if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes(".."))
            return reply.code(400).send({ ok: false, error: "非法 artifact 名" });
        const dataDir = dataDirOf() || "";
        const abs = path.join(dataDir, "artifacts", name);
        try {
            const real = await fs.promises.realpath(abs);
            const root = await fs.promises.realpath(path.join(dataDir, "artifacts"));
            if (real !== root && !real.startsWith(root + path.sep))
                return reply.code(400).send({ ok: false, error: "artifact 越界" });
            const buf = await fs.promises.readFile(real);
            reply.raw.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "content-length": buf.length });
            reply.raw.end(buf);
        }
        catch {
            reply.code(404).send({ ok: false, error: "artifact 不存在" });
        }
    });
    /* ── Agent 会话持久化（agent_sessions 表；RESTRICTED 下写 403） ── */
    app.get("/api/agent/sessions", async () => ({ ok: true, sessions: listAgentSessions(db) }));
    app.get("/api/agent/sessions/:id", async (req, reply) => {
        const s = getAgentSession(db, req.params.id);
        return s ? { ok: true, ...s } : reply.code(404).send({ ok: false, error: "会话不存在" });
    });
    app.post("/api/agent/sessions", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const b = req.body ?? {};
        const sessionKey = String(b.sessionKey || crypto.randomUUID()).slice(0, 64);
        saveAgentSession(db, { sessionKey, title: String(b.title || "").slice(0, 200), messages: [] });
        return reply.code(201).send({ ok: true, sessionKey });
    });
    app.put("/api/agent/sessions/:id", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const b = req.body ?? {};
        const cur = getAgentSession(db, req.params.id);
        if (!cur)
            return reply.code(404).send({ ok: false, error: "会话不存在" });
        saveAgentSession(db, { sessionKey: req.params.id, title: b.title ?? cur.title, messages: Array.isArray(b.messages) ? b.messages : cur.messages });
        return { ok: true };
    });
    app.delete("/api/agent/sessions/:id", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const ok = deleteAgentSession(db, req.params.id);
        return ok ? { ok: true } : reply.code(404).send({ ok: false, error: "会话不存在" });
    });
    /** 审批三键端点（B1：writeGate 升级属功能变更，本次仅 501 占位，不静默放行） */
    app.post("/api/agent/runs/:id/steps/:sid/approval", async (req, reply) => {
        const h = runs.getRun(req.params.id);
        if (!h)
            return reply.code(404).send({ ok: false, error: "run 不存在" });
        return reply.code(501).send({ ok: false, error: "审批功能未启用（需单独立项：writeGate 升级为 (tool,risk,decision) 判定）", approval: "pending" });
    });
    /* ── 驾驶舱 6 端点（A1/A2/A3/A4/A6；A5 token 用量已随 startRun 落地到 /runs/:id 的 usage/estimatedTokens） ── */
    /** A1 中止运行：触发 AbortSignal（轮次间 + LLM fetch 可中断；进行中工具调用跑完） */
    app.post("/api/agent/runs/:id/abort", async (req, reply) => {
        const h = runs.getRun(req.params.id);
        if (!h)
            return reply.code(404).send({ ok: false, error: "run 不存在（内存保留最近 50 个）" });
        if (h.run.status !== "running")
            return reply.code(409).send({ ok: false, error: `run 已终态（${h.run.status}），无需中止` });
        h.abort(String((req.body ?? {}).reason || "用户手动中止"));
        return { ok: true, runId: h.run.id, status: "aborted" };
    });
    /** A2 会话压缩：保留最近 N 条消息（上下文管理；RESTRICTED 下 403） */
    app.post("/api/agent/sessions/:id/compact", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const keep = Number((req.body ?? {}).keepRecent ?? 20);
        const r = compactAgentSession(db, req.params.id, keep);
        if (!r)
            return reply.code(404).send({ ok: false, error: "会话不存在" });
        return { ok: true, ...r };
    });
    /** A3 全量记忆导出（JSON 附件；复用 /api/all SQL 口径；RESTRICTED 下 403） */
    app.get("/api/export/memories", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const limit = Math.min(Math.max(Number(req.query.limit ?? 5000) || 5000, 1), 20000);
        const status = (req.query.status ?? "").trim();
        const where = status ? `WHERE status=?` : "";
        const rows = db
            .prepare(`SELECT id, content, type, agent, agent_fpath, project, status, confidence, eff_confidence,
                      conflict_with, superseded_by, derived_from, hit_count, created_at
           FROM memories ${where} ORDER BY julianday(created_at) DESC, id DESC LIMIT ?`)
            .all(...(status ? [status, limit] : [limit]));
        const payload = JSON.stringify({ exportedAt: new Date().toISOString(), count: rows.length, rows }, null, 2);
        const name = `memoryos-memories-${new Date().toISOString().slice(0, 10)}.json`;
        reply.raw.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="${name}"`,
            "content-length": Buffer.byteLength(payload),
        });
        reply.raw.end(payload);
    });
    /** A4 执行审计导出（JSON 附件；全量 exec_audit 只读；RESTRICTED 下 403） */
    app.get("/api/export/audit", async (req, reply) => {
        if (RESTRICTED)
            return reply.code(403).send({ ok: false, error: "受限模式：由系统统一派发" });
        const limit = Math.min(Math.max(Number(req.query.limit ?? 5000) || 5000, 1), 5000);
        const rows = allExecAudit(db, limit);
        const payload = JSON.stringify({ exportedAt: new Date().toISOString(), count: rows.length, rows }, null, 2);
        const name = `memoryos-exec-audit-${new Date().toISOString().slice(0, 10)}.json`;
        reply.raw.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="${name}"`,
            "content-length": Buffer.byteLength(payload),
        });
        reply.raw.end(payload);
    });
    /** A6 MCP 重启：close 现有句柄 + reset + 惰性重 spawn（仅 dashboard 自己的 MCP 子进程） */
    app.post("/api/agent/mcp/restart", async (req, reply) => {
        try {
            const prev = await getAgentMcp().catch(() => null);
            try { await prev?.close(); } catch { /* 已坏/未起 */ }
            ctx.resetAgentMcp();
            const fresh = await getAgentMcp();
            const tools = (await fresh.tools()).length;
            return { ok: true, restarted: true, toolCount: tools };
        }
        catch (e) {
            ctx.resetAgentMcp();
            return reply.code(503).send({ ok: false, error: "MCP 重启失败：" + (e instanceof Error ? e.message : String(e)) });
        }
    });
}
