/** T8（P2-3）：buildApp 路由域拆分 —— plans 域。
 * handler 自 dashboard.js 原行 670-999 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { logUsage, logDaemon, writeMemory, queryByType } from "./db.js";
import { aiViews, aiVisible } from "./format.js";
import { scanAgents, connectGuideFor, applyConnectWrite, loadCustomAgents, saveCustomAgents } from "./scan.js";
import { syncRules, syncProjectRules, getSyncTargets } from "./sync-rules.js";
import { getEmbedder } from "./embed.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { TASK_BUCKETS } from "./dashboard-task-util.js";
export function registerPlans(app, ctx) {
    const { db, restricted, RESTRICTED, PLANS_DIR } = ctx;
    /** 计划结构校验（不引 JSON Schema 依赖，只校验 v1.1 必需字段与任务可导入性） */
    function checkPlanShape(plan) {
        const errors = [];
        if (!plan || typeof plan !== "object" || Array.isArray(plan))
            return { ok: false, errors: ["计划不是 JSON 对象"] };
        for (const k of ["schema_version", "plan_id", "plan_status", "created_at", "tasks", "artifacts"]) {
            if (plan[k] === undefined || plan[k] === null)
                errors.push(`缺少必填字段 ${k}`);
        }
        if (!Array.isArray(plan.tasks))
            errors.push("tasks 必须是数组");
        else {
            plan.tasks.forEach((t, i) => {
                if (!t || typeof t !== "object") {
                    errors.push(`tasks[${i}] 不是对象`);
                    return;
                }
                if (!t.id)
                    errors.push(`tasks[${i}] 缺少 id`);
                if (!t.title && !t.summary && !t.name)
                    errors.push(`tasks[${i}] 缺少 title / summary`);
                if (t.status && !TASK_BUCKETS.includes(String(t.status)))
                    errors.push(`tasks[${i}].status 非法：${t.status}`);
            });
        }
        if (!Array.isArray(plan.artifacts))
            errors.push("artifacts 必须是数组");
        return { ok: errors.length === 0, errors };
    }
    // —— 计划：列出 plans/*.json（概要 + 任务数 + 结构校验状态）——
    app.get("/api/plans", async () => {
        let files = [];
        try {
            files = fs.readdirSync(PLANS_DIR).filter((f) => /^plan-.*\.json$/i.test(f));
        }
        catch {
            /* 目录不存在 → 空列表 */
        }
        const rows = files.map((f) => {
            const full = path.join(PLANS_DIR, f);
            let plan = null;
            let parseError = null;
            try {
                plan = JSON.parse(fs.readFileSync(full, "utf8"));
            }
            catch (e) {
                parseError = `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`;
            }
            const v = plan ? checkPlanShape(plan) : { ok: false, errors: [parseError ?? "未知错误"] };
            let size = 0;
            try {
                size = fs.statSync(full).size;
            }
            catch {
                /* 忽略 */
            }
            return {
                file: f,
                path: full,
                size,
                plan_id: plan?.plan_id ?? null,
                summary: plan?.summary ?? null,
                plan_status: plan?.plan_status ?? null,
                created_at: plan?.created_at ?? null,
                updated_at: plan?.updated_at ?? null,
                tasks: Array.isArray(plan?.tasks) ? plan.tasks.length : 0,
                valid: v.ok,
                errors: v.errors,
            };
        });
        return { total: rows.length, dir: PLANS_DIR, rows };
    });
    const runPlanImport = async (body, reply) => {
        const b = body ?? {};
        let text = String(b.content ?? "").trim();
        let srcLabel = "粘贴内容";
        if (!text) {
            const p = String(b.path ?? "").trim();
            if (!p)
                return reply.code(400).send({ ok: false, error: "请粘贴计划 JSON，或填写 plans 目录内的计划文件名" });
            // 安全：只允许读 plans 目录内的文件，防任意文件读取
            const full = path.isAbsolute(p) ? p : path.join(PLANS_DIR, p);
            const normFull = full.replace(/\\/g, "/").toLowerCase();
            const normDir = PLANS_DIR.replace(/\\/g, "/").toLowerCase();
            if (!normFull.startsWith(normDir)) {
                return reply.code(400).send({ ok: false, error: "出于安全考虑，只允许导入 plans 目录内的计划文件" });
            }
            try {
                text = fs.readFileSync(full, "utf8");
                srcLabel = path.basename(full);
            }
            catch (e) {
                return reply.code(400).send({ ok: false, error: `读取计划文件失败：${e instanceof Error ? e.message : String(e)}` });
            }
        }
        let plan;
        try {
            plan = JSON.parse(text);
        }
        catch (e) {
            return reply.code(400).send({ ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` });
        }
        const v = checkPlanShape(plan);
        if (!v.ok)
            return reply.code(400).send({ ok: false, error: "计划校验未通过", errors: v.errors });
        const planId = String(plan.plan_id);
        // v1.1 一致性：plan_status=completed 的计划，其任务直接以 done 落库
        const forceDone = String(plan.plan_status) === "completed";
        // 幂等：扫描已有 task 记忆的 [plan:][taskid:] 标记（不限定位置，兼容两种前缀排布）
        const seen = new Set();
        for (const r of queryByType(db, "task", { limit: 1000, status: "active" })) {
            const m = r.content.match(/\[plan:([^\]]+)\]\[taskid:([^\]]+)\]/);
            if (m)
                seen.add(`${m[1]}::${m[2]}`);
        }
        let inserted = 0;
        let skipped = 0;
        const failures = [];
        // 预演（dryRun）：只报告将写入/跳过的数量，不落库（供前端「校验」按钮）
        if (b.dryRun) {
            const allTasks = plan.tasks;
            const willImport = allTasks.filter((t) => !seen.has(`${planId}::${String(t.id)}`)).length;
            return {
                ok: true,
                dryRun: true,
                plan_id: planId,
                plan_status: plan.plan_status,
                source: srcLabel,
                tasks: allTasks.length,
                willImport,
                skipped: allTasks.length - willImport,
                forcedDone: forceDone,
            };
        }
        for (const t of plan.tasks) {
            const tid = String(t.id);
            if (seen.has(`${planId}::${tid}`)) {
                skipped++;
                continue;
            }
            const statusRaw = String(t.status ?? "pending");
            const status = forceDone ? "done" : TASK_BUCKETS.includes(statusRaw) ? statusRaw : "pending";
            const assignee = String(t.assignee ?? t.owner ?? "unassigned").trim() || "unassigned";
            const deps = Array.isArray(t.depends)
                ? t.depends.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
                : [];
            const title = String(t.title ?? t.summary ?? t.name ?? "").trim();
            const body = String(t.description ?? "").trim();
            const depTag = deps.length ? `[depends:${deps.join(",")}]` : "";
            const content = `[task][assignee:${assignee}][status:${status}][plan:${planId}][taskid:${tid}]${depTag} ${title}${body ? "\n\n" + body : ""}`;
            try {
                let embedding = null;
                try {
                    const [vec] = await (await getEmbedder()).embedTexts([content]);
                    embedding = vec ?? null;
                }
                catch {
                    embedding = null;
                }
                const row = writeMemory(db, {
                    content,
                    type: "task",
                    agent: "human:dashboard",
                    agent_fpath: null,
                    project: String(plan?.context?.project ?? "global").trim() || "global",
                    embedding,
                    confidence: 0.8,
                });
                logUsage(db, { memory_id: row.id, event: "write", reader_agent: "human:dashboard", writer_agent: "human:dashboard", project: row.project });
                inserted++;
            }
            catch (e) {
                failures.push(`任务 ${tid} 写入失败：${e instanceof Error ? e.message : String(e)}`);
            }
        }
        logDaemon(db, {
            task: "plan-import",
            op: "import",
            operator: "human:dashboard",
            detail: `导入计划 ${planId}（${srcLabel}）：新增 ${inserted} / 跳过 ${skipped} / 失败 ${failures.length}`,
        });
        return {
            ok: true,
            plan_id: planId,
            plan_status: plan.plan_status,
            source: srcLabel,
            forcedDone: forceDone,
            inserted,
            skipped,
            failed: failures.length,
            errors: failures,
        };
    };
    // 导入计划：受限模式下禁用（用户不可自行导入任意计划）
    app.post("/api/plans/import", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "planImport");
        return runPlanImport(req.body ?? {}, reply);
    });
    // 应用系统计划：仅接受 plans 目录内的文件（拒绝任意 JSON 粘贴），供看板「系统计划」卡片调用
    app.post("/api/plans/apply", async (req, reply) => {
        const b = req.body ?? {};
        const file = String(b.file ?? b.path ?? "").trim();
        if (!file)
            return reply.code(400).send({ ok: false, error: "请指定系统计划文件" });
        return runPlanImport({ path: file, dryRun: b.dryRun }, reply);
    });
    // —— 规则强制注入到智能体约束文件（保证新会话必载） ——
    app.get("/api/rules/sync-targets", async () => ({ targets: getSyncTargets() }));
    app.post("/api/rules/sync", async (req, reply) => {
        try {
            const rs = syncRules(db, { target: req.body?.target });
            for (const r of rs) {
                if (r.ok) {
                    logDaemon(db, { task: "sync-rules", op: r.added ? "injected" : "resynced", operator: "human:dashboard", detail: `规则注入 ${r.target}：${r.rules} 条（跳过 ${r.skipped}）${r.backedUp ? "，已备份" : ""}` });
                }
            }
            return { ok: true, results: rs };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e) });
        }
    });
    // —— 项目级规则注入：写 <dir>/AGENTS.md，覆盖无全局明文入口的桌面智能体 ——
    app.get("/api/rules/project-candidates", async () => {
        const h = os.homedir();
        const seen = new Set();
        const out = [];
        const add = (d) => {
            const abs = path.resolve(d);
            if (!fs.existsSync(abs) || seen.has(abs))
                return;
            seen.add(abs);
            out.push({ dir: abs, name: path.basename(abs), hasAgents: fs.existsSync(path.join(abs, "AGENTS.md")) });
        };
        for (const base of [path.join(h, "Desktop"), path.join(h, "WorkBuddy"), path.join(h, "Documents")]) {
            if (!fs.existsSync(base))
                continue;
            for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
                if (ent.isDirectory() && !ent.name.startsWith("."))
                    add(path.join(base, ent.name));
            }
        }
        return { projects: out };
    });
    app.post("/api/rules/project-sync", async (req, reply) => {
        const dir = (req.body?.dir ?? "").trim();
        if (!dir)
            return reply.code(400).send({ ok: false, error: "缺少项目目录 dir" });
        try {
            const r = syncProjectRules(db, dir);
            if (r.ok) {
                logDaemon(db, { task: "sync-rules", op: r.added ? "injected-project" : "resynced-project", operator: "human:dashboard", detail: `项目级规则注入 ${r.file}：${r.rules} 条（跳过 ${r.skipped}）${r.backedUp ? "，已备份" : ""}` });
            }
            return { ok: true, result: r };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e) });
        }
    });
    app.get("/api/all", async (req) => {
        const limit = Math.min(Math.max(Number(req.query.limit ?? 500) || 500, 1), 2000);
        const status = (req.query.status ?? "").trim();
        const where = status ? `WHERE status=?` : "";
        const rows = db
            .prepare(`SELECT id, content, type, agent, agent_fpath, project, status, confidence, eff_confidence, conflict_with, superseded_by, derived_from, hit_count, created_at
           FROM memories ${where} ORDER BY julianday(created_at) DESC, id DESC LIMIT ?`)
            .all(...(status ? [status, limit] : [limit])).map((r) => {
            const row = {
            id: r.id,
            content: r.content,
            type: r.type,
            agent: r.agent,
            agent_fpath: r.agent_fpath,
            project: r.project,
            status: r.status,
            confidence: r.confidence,
            eff: r.eff_confidence ?? r.confidence,
            conflict_with: r.conflict_with,
            superseded_by: r.superseded_by,
            derived_from: r.derived_from,
            hits: r.hit_count,
            created_at: r.created_at,
            };
            // ★ WYSIWYG（format.js 单一真源）：AI 侧三通道视图与可见性判据，只读派生不落库。
            //   /api/all 每行附带 ai.*（用户所见即 AI 所得）+ ai_visible（检索层过滤原因）
            row.ai = aiViews({ ...r, eff: row.eff });
            row.ai_visible = aiVisible(row);
            return row;
        });
        return { total: rows.length, rows };
    });
    // —— 工具连接：扫描本机已装 AI Agent（真实探测）+ 合并"最近连接心跳"（server 被拉起时 MEMORY_AGENT 留痕，可精确到谁真连过）——
    app.get("/api/scan-agents", async () => {
        const scan = scanAgents();
        // 最近连接心跳：近 10 分钟内 op=connect 的 memoryos server 实例，按 payload.agent 归类
        const beats = db.prepare(`SELECT id, payload, operator FROM memory_events WHERE op='connect' AND created_at >= datetime('now','-10 minutes') ORDER BY id DESC`).all();
        const beatAgents = {};
        for (const b of beats) {
            try {
                const p = JSON.parse(b.payload ?? "{}");
                const a = p.agent || b.operator.replace(/^agent:/, "");
                if (a && a !== "unknown" && !beatAgents[a])
                    beatAgents[a] = b.id; // 只记每人最近一次
            }
            catch { /* ignore */ }
        }
        const agents = scan.agents.map((a) => ({
            ...a,
            // 探测 true → 已连接；探测 false 但有心跳 → 已连接（最近连接）；否则未连接
            connected: a.connected || !!beatAgents[a.id],
            heartbeat: beatAgents[a.id] ? true : false,
        }));
        const connected = agents.filter((a) => a.connected).length;
        return { agents, total: agents.length, connected };
    });
    /* ★ 批次⑦B（2026-09-23）：手动登记清单外的新智能体（扫描兜底）。
     * 落盘 %APPDATA%\MemoryOS\agents.custom.json，每次 /api/scan-agents 合并；
     * 只写本机注册表，不碰任务/采集/卡片（非 RESTRICTED 收敛类）。 */
    app.post("/api/scan-agents/custom", async (req, reply) => {
        const name = String(req.body?.name ?? "").trim();
        if (!name)
            return reply.code(400).send({ ok: false, error: "name 不能为空" });
        const entry = {
            name: name.slice(0, 80),
            path: String(req.body?.path ?? "").trim().slice(0, 500) || null,
            configDir: String(req.body?.configDir ?? "").trim().slice(0, 500) || null,
            addedAt: new Date().toISOString(),
        };
        try {
            const list = loadCustomAgents();
            if (list.some((x) => x.name === entry.name))
                return reply.code(409).send({ ok: false, error: `「${entry.name}」已登记过` });
            list.push(entry);
            saveCustomAgents(list);
            return { ok: true, entry, total: list.length };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e?.message ?? e) });
        }
    });
    app.delete("/api/scan-agents/custom", async (req, reply) => {
        const name = String(req.body?.name ?? "").trim();
        if (!name)
            return reply.code(400).send({ ok: false, error: "name 不能为空" });
        try {
            const list = loadCustomAgents();
            const next = list.filter((x) => x.name !== name);
            if (next.length === list.length)
                return reply.code(404).send({ ok: false, error: `未登记「${name}」` });
            saveCustomAgents(next);
            return { ok: true, remaining: next.length };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e?.message ?? e) });
        }
    });
    // —— A2A 协议层：Agent Card 端点（互操作层「智能体对等协作」的自描述卡片）。
    //   返回本 MemoryOS 服务自身 + 各已连接 agent 的能力卡片（能力=其工具面），
    //   带确定性签名（SHA-256 over 规范 JSON），供对端做签名验证（协议层·Agent Card 签名验证）。
    app.get("/api/agents/cards", async () => {
        const crypto = await import("node:crypto");
        const scan = scanAgents();
        // 本服务的工具面（MCP server memory-hub 的工具清单）
        let toolCount = 0;
        try {
            const rows = db.prepare(`SELECT DISTINCT tool FROM exec_audit ORDER BY tool`).all();
            toolCount = rows.length;
        }
        catch { /* 无执行审计时保持 0 */ }
        const cards = scan.agents.map((a) => ({
            protocol: "A2A",
            agent: a.id,
            name: a.name,
            type: a.type,
            connected: a.connected,
            capabilities: ["memory-rpc", "task-delegation", "shared-memory"],
            transport: "stdio-mcp",
            mcpServer: "memory-hub",
        }));
        // 签名：对卡片集合的规范 JSON 求 SHA-256（确定性；对端可复算验证一致性）
        const canonical = JSON.stringify(cards);
        const signature = crypto.createHash("sha256").update(canonical).digest("hex");
        return {
            self: {
                protocol: "A2A", agent: "memoryos", name: "MemoryOS 共享记忆中心",
                mcpServer: "memory-hub",
                capabilities: ["shared-memory", "task-coordination", "gate-verification", "short-lived-credentials"],
                toolCount,
            },
            cards,
            signature,
            sigOver: "SHA-256 of canonical JSON(cards)",
        };
    });
    // —— 接入向导：查某 agent 的 connect guide（可否自动写/手动步骤/配置模板）——
    app.get("/api/agent/:id/connect-guide", async (req, reply) => {
        const s = scanAgents();
        const a = s.agents.find((x) => x.id === req.params.id);
        if (!a)
            return reply.code(404).send({ ok: false, error: `agent '${req.params.id}' 未扫描到` });
        const g = connectGuideFor(a);
        return { ok: true, guide: g };
    });
    // —— 接入向导：一键自动写配置（仅 canAutoWrite；带备份）。dry_run=1 只预览不落盘 ——
    app.post("/api/agent/:id/connect", async (req, reply) => {
        const s = scanAgents();
        const a = s.agents.find((x) => x.id === req.params.id);
        if (!a)
            return reply.code(404).send({ ok: false, error: `agent '${req.params.id}' 未扫描到` });
        const dryRun = req.query.dry_run === "1" || req.body?.dryRun === true;
        const r = applyConnectWrite(a, { dryRun });
        if (!r.ok)
            return reply.code(400).send({ ok: false, error: r.error });
        return { ok: true, backupPath: r.backupPath, dryRun };
    });
}
