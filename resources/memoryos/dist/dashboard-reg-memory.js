/** T8（P2-3）：buildApp 路由域拆分 —— memory 域。
 * handler 自 dashboard.js 原行 500-669 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { logUsage, logDaemon, writeMemory, updateMemory, queryByType, rejectMemory, SECTOR_KEYS } from "./db.js";
import { reembedStale } from "./daemon.js";
import { syncRules } from "./sync-rules.js";
import { getEmbedder } from "./embed.js";
import { TASK_HEAD_RE_STATES, TASK_HEAD_RE, TASK_NORMALIZE, TASK_DEP_RE, TASK_BUCKETS } from "./dashboard-task-util.js";
/** ★ 批次⑦X2（2026-09-23）：规则增删改后自动刷新注入段（幂等替换，5 个目标文件，毫秒级）。
 *  失败绝不阻断业务请求 —— 记审计留痕，下次规则变更或手动同步再自愈。 */
function autoSyncRules(db, reason) {
    try {
        syncRules(db);
        logDaemon(db, { task: "sync-rules", op: "auto-resync", operator: "system:auto", detail: `规则变更自动同步（${reason}）` });
    }
    catch (e) {
        try {
            logDaemon(db, { task: "sync-rules", op: "auto-resync-failed", operator: "system:auto", detail: String(e?.message ?? e) });
        }
        catch { /* 审计失败也不阻断 */ }
    }
}
export function registerMemory(app, ctx) {
    const { db, restricted, RESTRICTED, clampLimit, ALLOWED_TYPES } = ctx;
    app.post("/api/memory", async (req, reply) => {
        const content = String(req.body?.content ?? "").trim();
        if (!content)
            return reply.code(400).send({ ok: false, error: "content 不能为空" });
        const type = ALLOWED_TYPES.includes(req.body?.type) ? req.body.type : "experience";
        const project = String(req.body?.project ?? "global").trim() || "global";
        const sector = String(req.body?.sector ?? "").trim() || undefined;
        const sensitivity = String(req.body?.sensitivity ?? "normal").trim() || "normal";
        if (!["normal", "private", "secret"].includes(sensitivity))
            return reply.code(400).send({ ok: false, error: "sensitivity 非法" });
        // P1-1: 人工沉淀必须进语义路——新建即嵌入向量；embed 失败降级 null 不阻塞建库
        let embedding = null;
        try {
            const [v] = await (await getEmbedder()).embedTexts([content]);
            embedding = v ?? null;
        }
        catch {
            embedding = null; // 嵌入暂不可用 → 建库照常，语义路下次 backfill 兜底
        }
        const row = writeMemory(db, { content, type, agent: "human:dashboard", agent_fpath: null, project, embedding, confidence: 0.8, sector, sensitivity });
        logUsage(db, { memory_id: row.id, event: "write", reader_agent: "human:dashboard", writer_agent: "human:dashboard", project: row.project });
        logDaemon(db, { task: "manual-write", op: "write", memory_id: row.id, operator: "human:dashboard", detail: `Dashboard 手动新建记忆（${type}）${embedding ? "（已嵌入）" : "（未嵌入）"}` });
        if (type === "rule")
            autoSyncRules(db, `新建规则 #${row.id}`); // ★ 批次⑦X2：新建规则即自动注入刷新
        return { ok: true, id: row.id };
    });
    // —— 编辑记忆：content/type 更新，同步 FTS（embedding 保持原值，v0.3 约定） ——
    app.put("/api/memory/:id", async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "id 非法" });
        const type = req.body?.type;
        if (type && !ALLOWED_TYPES.includes(type))
            return reply.code(400).send({ ok: false, error: "type 非法" });
        const sector = req.body?.sector !== undefined ? String(req.body.sector).trim() : undefined;
        if (sector !== undefined && sector !== "" && !SECTOR_KEYS.includes(sector))
            return reply.code(400).send({ ok: false, error: "sector 非法" });
        let row;
        try {
            row = updateMemory(db, id, { content: req.body?.content, type, sector });
        }
        catch (e) {
            return reply.code(400).send({ ok: false, error: String(e) });
        }
        if (!row)
            return reply.code(404).send({ ok: false, error: "记忆不存在" });
        // ★ 批次⑦X2：inject 开关写入（规则强制注入）——只动本列，不碰 FTS/向量
        const injectChanged = req.body?.inject !== undefined;
        if (injectChanged) {
            const inj = req.body.inject ? 1 : 0;
            db.prepare(`UPDATE memories SET inject=? WHERE id=?`).run(inj, row.id);
        }
        logDaemon(db, { task: "manual-edit", op: "edit", memory_id: row.id, operator: "human:dashboard", detail: "Dashboard 手动编辑记忆" });
        // ★ 批次⑦X2：规则内容/类型/注入开关变更 → 自动刷新注入段
        if (row.type === "rule" || type !== undefined || injectChanged)
            autoSyncRules(db, `编辑 #${row.id}${injectChanged ? `（inject=${req.body.inject ? 1 : 0}）` : ""}`);
        return { ok: true, id: row.id };
    });
    /* ★ 一致性⑥（2026-09-19）：OpenAI 兼容 /v1/embeddings 共享嵌入端点 —— 内核侧常驻真向量嵌入
     *  （Electron 注入 EMBED_MODE=local，bge-m3 已在本进程加载）。MCP 侧 agent 配
     *  EMBED_MODE=api + EMBED_API_URL=http://127.0.0.1:8787/v1/embeddings + EMBED_API_KEY=<data/token>
     *  即共享同一份真向量语义：一份模型全端共享，agent 不必各载各的模型（省 N×GB 内存与启动耗时），
     *  并从此杜绝 MCP 侧 fake 向量混入真向量语料（半真半假比全假更糟）。
     *  鉴权：全局访问控制钩子已覆盖（?token= / x-memory-token / cookie / Bearer 任一）。
     *  响应与 OpenAI /v1/embeddings 同形（{object:"list", data:[{index, embedding}]}），embed.js ApiEmbedder 直读。 */
    app.post("/v1/embeddings", async (req, reply) => {
        const body = req.body ?? {};
        const input = (Array.isArray(body.input) ? body.input : [body.input ?? ""]).map((t) => String(t ?? ""));
        if (!input.length || input.some((t) => !t.trim()))
            return reply.code(400).send({ ok: false, error: "input-required", hint: "body.input 须为非空字符串或非空字符串数组" });
        try {
            const embedder = await getEmbedder();
            if (embedder.mode === "fake")
                return reply.code(503).send({ ok: false, error: "embedder-fake", hint: "内核未以 EMBED_MODE=local/api 运行：宁可不服务，也不产出伪向量污染真向量语料（⑥纪律）" });
            const vectors = await embedder.embedTexts(input);
            return {
                object: "list",
                model: String(body.model ?? embedder.modelName ?? embedder.mode),
                data: vectors.map((v, i) => ({ object: "embedding", index: i, embedding: Array.from(v) })),
            };
        }
        catch (e) {
            return reply.code(502).send({ ok: false, error: `embed-failed: ${e instanceof Error ? e.message : String(e)}` });
        }
    });
    // ★ P0-2：手动触发单条记忆向量重算
    app.post("/api/embed/recompute/:id", async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "id 非法" });
        try {
            const r = await reembedStale(db, 1);
            return { ok: true, done: r.done, failed: r.failed, pending: r.pending };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e) });
        }
    });
    // —— 删除记忆/规则：软删 status='rejected'，审计留痕 ——
    app.delete("/api/memory/:id", async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "id 非法" });
        const old = db.prepare(`SELECT id, type FROM memories WHERE id=?`).get(id);
        if (!old)
            return reply.code(404).send({ ok: false, error: "记忆不存在" });
        rejectMemory(db, id, "human:dashboard");
        if (old.type === "rule")
            autoSyncRules(db, `删除规则 #${id}`); // ★ 批次⑦X2：删规则即从注入段移除
        return { ok: true, id };
    });
    // —— 规则列表：type='rule'，默认只列 active（删除即消失，审计留痕另查） ——
    app.get("/api/rules", async (req) => {
        const limit = clampLimit(req.query.limit, 500, 2000);
        const status = (req.query.status ?? "").trim() || "active"; // 默认 active
        const rows = queryByType(db, "rule", { limit, status }).map((r) => ({
            id: r.id,
            content: r.content,
            type: r.type,
            agent: r.agent,
            project: r.project,
            status: r.status,
            confidence: r.confidence,
            eff: r.eff_confidence ?? r.confidence,
            hits: r.hit_count,
            created_at: r.created_at,
            inject: r.inject ? 1 : 0,   // ★ 批次⑦X2：强制注入开关（规则页展示）
        }));
        return { total: rows.length, rows };
    });
    // —— 任务看板：解码 type='task' 记忆约定头 → 结构化七态（v1.1 状态机：多 Agent 协同可视化）——
    // 解码与 server.js taskHead 同源：`[task][assignee:X][status:<七态>]`；存量 open/claimed/done 归一
    app.get("/api/tasks", async (req) => {
        const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
        const raw = queryByType(db, "task", { limit: limit * 3, status: "active" });
        const rows = raw.map((r) => {
            const m = r.content.match(TASK_HEAD_RE);
            const am = r.content.match(/\[assignee:([^\]]*)\]/);
            const cm = r.content.match(/→ 结论\(([^)]*)\)：([\s\S]*)$/);
            const dm = r.content.match(TASK_DEP_RE);
            const rawStatus = m ? m[1] : "unknown";
            const status = rawStatus === "unknown" ? "unknown" : (TASK_NORMALIZE[rawStatus] ?? rawStatus);
            const assignee = am ? am[1] : null;
            const deps = dm ? dm[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : [];
            const body = r.content
                .replace(TASK_HEAD_RE, "")
                .replace(/\[plan:[^\]]+\]\[taskid:[^\]]+\]/g, "")
                .replace(TASK_DEP_RE, "")
                .replace(/→ 结论\(.*$/s, "")
                .trim();
            return { id: r.id, status, assignee, submittedBy: r.agent, deps, blocked: false, body: body.slice(0, 200), conclusion: cm ? cm[2].trim().slice(0, 200) : null, concludedBy: cm ? cm[1] : null, confidence: r.confidence, created_at: r.created_at };
        });
        const doneIds = new Set(rows.filter((t) => t.status === "done").map((t) => t.id));
        // 补 blocked 标记：pending 但依赖未全 done
        rows.forEach((t) => { t.blocked = t.status === "pending" && t.deps.some((d) => !doneIds.has(d) && rows.some((x) => x.id === d)); });
        const buckets = {};
        TASK_BUCKETS.forEach((b) => { buckets[b] = []; });
        for (const t of rows) {
            if (buckets[t.status])
                buckets[t.status].push(t);
        }
        return { total: rows.length, ...buckets };
    });
    // —— 任务看板：人工创建任务（约定头由服务端拼装，避免前端拼错导致任务不显示）——
    app.post("/api/task", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "taskCreate");
        const b = req.body ?? {};
        const title = String(b.title ?? "").trim();
        if (!title)
            return reply.code(400).send({ ok: false, error: "任务标题不能为空" });
        const statusRaw = String(b.status ?? "pending").trim();
        const status = TASK_BUCKETS.includes(statusRaw) ? statusRaw : "pending";
        const assignee = String(b.assignee ?? "").trim() || "unassigned";
        const deps = Array.isArray(b.depends)
            ? b.depends.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
            : [];
        const summary = String(b.summary ?? "").trim();
        const depTag = deps.length ? `[depends:${deps.join(",")}]` : "";
        const content = `[task][assignee:${assignee}][status:${status}]${depTag} ${title}${summary ? "\n\n" + summary : ""}`;
        let embedding = null;
        try {
            const [v] = await (await getEmbedder()).embedTexts([content]);
            embedding = v ?? null;
        }
        catch {
            embedding = null; // 嵌入暂不可用 → 建任务照常
        }
        const row = writeMemory(db, {
            content,
            type: "task",
            agent: "human:dashboard",
            agent_fpath: null,
            project: String(b.project ?? "global").trim() || "global",
            embedding,
            confidence: 0.8,
        });
        logUsage(db, { memory_id: row.id, event: "write", reader_agent: "human:dashboard", writer_agent: "human:dashboard", project: row.project });
        logDaemon(db, {
            task: "manual-task",
            op: "create",
            memory_id: row.id,
            operator: "human:dashboard",
            detail: `看板新建任务 #${row.id}（${status} · ${assignee}）：${title.slice(0, 60)}`,
        });
        return { ok: true, id: row.id, status, assignee, deps };
    });
}
