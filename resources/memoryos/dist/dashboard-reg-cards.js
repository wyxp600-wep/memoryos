/** T8（P2-3）：buildApp 路由域拆分 —— cards 域。
 * handler 自 dashboard.js 原行 1332-2396 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { logUsage, logDaemon, writeMemory, listWorkingMemory, setWorkingMemory, clearWorkingMemory, readMemory, readConfig, writeConfig, SECTORS, SECTOR_KEYS } from "./db.js";
import { getEmbedder, cosine, bufToVec } from "./embed.js";
import { randomBytes } from "node:crypto";
import { TASK_NORMALIZE } from "./dashboard-task-util.js";
export function registerCards(app, ctx) {
    const { db, restricted, RESTRICTED } = ctx;
    // ═══════════════════════════════════════════════════════════════════════════
    // ★ P3 卡片看板 + 知识图谱 + 记忆模块 API（第四轮评审 H1-H6 / M1-M8 合入）
    // ═══════════════════════════════════════════════════════════════════════════
    /** 10 态状态机（Hermes + A2A + 现有七态融合）；迁移白名单与 plan.schema.json status_transitions 对齐 */
    const CARD_STATES = ["triage", "todo", "ready", "running", "review", "done", "failed", "cancelled", "blocked", "archived"];
    const CARD_TRANSITIONS = {
        triage: ["todo", "cancelled"],
        todo: ["ready", "cancelled", "blocked"],
        ready: ["running", "cancelled"],
        running: ["review", "failed", "blocked"],
        review: ["done", "failed"],
        blocked: ["todo", "ready", "running", "cancelled"],
        failed: ["blocked", "todo", "cancelled"],
        done: ["archived"],
        cancelled: [],
        archived: [],
    };
    const CARD_LINK_KINDS = ["depends", "blocks", "relates", "spawned_by", "duplicates"];
    /** M6：卡片 kind → sector 映射（cards/:id/to-memory 用） */
    const CARD_TO_SECTOR = {
        task: "social",
        note: "semantic",
        message: "meta",
        artifact: "procedural",
        memory: "episodic",
    };
    function cardRowOf(r) {
        return {
            id: Number(r.id), board: r.board, kind: r.kind, title: r.title, body: r.body, status: r.status,
            assignee: r.assignee, lane: r.lane, priority: Number(r.priority ?? 0), failure_count: Number(r.failure_count ?? 0),
            claim_lock: r.claim_lock, lease_expires_at: r.lease_expires_at, heartbeat_at: r.heartbeat_at,
            workspace: r.workspace, workspace_kind: r.workspace_kind, ref_kind: r.ref_kind, ref_id: r.ref_id,
            meta: r.meta, created_at: r.created_at, updated_at: r.updated_at,
        };
    }
    function readCard(id) {
        const r = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(id);
        return r ? cardRowOf(r) : null;
    }
    function readCardMeta(c) {
        try {
            return c.meta ? JSON.parse(c.meta) : {};
        }
        catch {
            return {};
        }
    }
    function writeCardEvent(cardId, actor, action, fromStatus, toStatus, detail) {
        db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail)
       VALUES (?,?,?,?,?,?)`).run(cardId, actor, action, fromStatus ?? null, toStatus ?? null, detail ?? null);
    }
    /** ★ 2026-09-15：卡片状态 → 关联 task 记忆状态头回写（task_assign 建的卡 ref_kind='memory'，dispatch 关联）。
     *  卡片流转会同步 memories 里对应 type='task' 的内容头 [status:]，保持「地图卡 ↔ MCP 任务」双向一致。 */
    function syncCardToTask(cardId) {
        try {
            // 定位关联 task 记忆：优先 ref_kind='memory'，其次 card_memory dispatch 关联
            const card = readCard(cardId);
            if (!card)
                return;
            const memRow = (card.ref_kind === "memory" && card.ref_id
                ? db.prepare(`SELECT id FROM memories WHERE id=?`).get(card.ref_id)
                : undefined) ??
                db.prepare(`SELECT memory_id id FROM card_memory WHERE card_id=? AND relation='dispatch' LIMIT 1`).get(cardId);
            if (!memRow)
                return;
            const mem = db.prepare(`SELECT id, content FROM memories WHERE id=? AND type='task' AND status IN ('active','trial')`).get(memRow.id);
            if (!mem)
                return;
            const st = mem.content.match(/\[status:([^\]]+)\]/);
            if (!st)
                return;
            // 卡片状态 → 任务状态头映射
            const map = { ready: "pending", running: "in_progress", done: "done", failed: "failed", blocked: "blocked", review: "review", cancelled: "cancelled", archived: "cancelled" };
            const toSt = map[card.status];
            if (!toSt || st[1] === toSt)
                return;
            const newContent = mem.content.replace(`[status:${st[1]}]`, `[status:${toSt}]`);
            db.prepare(`UPDATE memories SET content=? WHERE id=?`).run(newContent, mem.id);
        }
        catch {
            /* 回写失败不阻断卡片流程 */
        }
    }
    /** 请求中的自我声明身份（单机单用户，README 已声明不防恶意本机调用，R4-6） */
    function asOf(req) {
        return String(req.query.as ?? "").trim() || "unassigned";
    }
    /** 卡片全部 depends 入边是否 done（M3：只认 depends） */
    function cardDependsDone(cardId) {
        const deps = db
            .prepare(`SELECT dst_id FROM links WHERE src_kind='card' AND src_id=? AND kind='depends' AND dst_id IS NOT NULL`)
            .all(cardId);
        if (!deps.length)
            return true;
        for (const d of deps) {
            const s = db.prepare(`SELECT status FROM cards WHERE id=?`).get(d.dst_id);
            if (!s || s.status !== "done")
                return false;
        }
        return true;
    }
    /** depends 图成环检测（DFS；从 src 沿 depends 向后遍历是否可达 dst） */
    function dependsPathExists(fromCard, toCard, seen = new Set()) {
        if (fromCard === toCard)
            return true;
        if (seen.has(fromCard))
            return false;
        seen.add(fromCard);
        const next = db
            .prepare(`SELECT dst_id FROM links WHERE src_kind='card' AND src_id=? AND kind='depends' AND dst_id IS NOT NULL`)
            .all(fromCard);
        return next.some((n) => dependsPathExists(n.dst_id, toCard, seen));
    }
    // —— 记忆类别（单一信源：前端筛选/着色/详情徽标）——
    app.get("/api/sectors", async () => {
        const rows = db.prepare(`SELECT sector, COUNT(*) c FROM memories GROUP BY sector`).all();
        const counts = new Map(rows.map((r) => [r.sector, r.c]));
        return {
            sectors: SECTOR_KEYS.map((k) => ({
                sector: k,
                cn: SECTORS[k]?.cn ?? k,
                desc: SECTORS[k]?.desc ?? "",
                lambda: SECTORS[k]?.lambda ?? 0,
                w: SECTORS[k]?.w ?? 1,
                count: counts.get(k) ?? 0,
            })),
        };
    });
    // —— H5 引用上报：last_seen_at + hit_count（V-H5：search 命中 1 分钟内可见）——
    app.post("/api/memory/hit", async (req, reply) => {
        const raw = req.body?.ids;
        const ids = Array.isArray(raw) ? [...new Set(raw.map(Number).filter((n) => Number.isFinite(n) && n > 0))] : [];
        if (!ids.length)
            return reply.code(400).send({ ok: false, error: "ids 不能为空" });
        const now = new Date().toISOString();
        const upd = db.prepare(`UPDATE memories SET last_seen_at=?, hit_count=hit_count+1 WHERE id=?`);
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const id of ids)
                upd.run(now, id);
            db.exec("COMMIT");
        }
        catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
        return { ok: true, updated: ids.length };
    });
    // —— R5-8：secret 查看审计（本机前端详情页 allow_secret 查看时上报；不记内容）——
    app.post("/api/memory/:id/secret-view", async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "非法 id" });
        const row = readMemory(db, id);
        if (!row)
            return reply.code(404).send({ ok: false, error: "记忆不存在" });
        if (String(row.sensitivity ?? "normal") !== "secret")
            return { ok: true, noted: false }; // 非 secret 无需审计
        logUsage(db, {
            memory_id: id,
            event: "secret_view",
            reader_agent: String(req.query.as ?? "human:dashboard"),
            writer_agent: row.agent,
            project: row.project,
        });
        return { ok: true, noted: true };
    });
    // —— M7：计划 JSON → 卡片（同源幂等 + 状态分策略重应用）——
    app.post("/api/cards/apply-plan", async (req, reply) => {
        const plan = req.body?.plan;
        if (!plan || typeof plan !== "object" || !Array.isArray(plan.tasks)) {
            return reply.code(400).send({ ok: false, error: "缺少 plan.tasks 数组" });
        }
        const planId = String(plan.plan_id ?? plan.id ?? `plan-${Date.now()}`);
        const covered = ["triage", "todo", "ready"];
        const now = new Date().toISOString();
        let created = 0, overwritten = 0, staleMarked = 0, skipped = 0;
        const rows = db.prepare(`SELECT id, meta, status FROM cards WHERE meta LIKE '%"plan_id"%'`).all();
        const byKey = new Map();
        for (const r of rows) {
            try {
                const m = JSON.parse(r.meta ?? "{}");
                if (m.plan_id === planId && m.task_id != null)
                    byKey.set(`${planId}::${m.task_id}`, { id: r.id, status: r.status });
            }
            catch { /* meta 非 JSON 跳过 */ }
        }
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const t of plan.tasks) {
                const tid = String(t.id ?? t.task_id ?? "");
                if (!tid) {
                    skipped++;
                    continue;
                }
                const key = `${planId}::${tid}`;
                const title = String(t.title ?? "").trim() || `任务 ${tid}`;
                const priority = Number(t.priority ?? t.p1 ?? 0) || 0;
                const body = String(t.body ?? t.description ?? "").trim();
                const exist = byKey.get(key);
                if (!exist) {
                    const ins = db.prepare(`INSERT INTO cards(board, kind, title, body, status, priority, meta) VALUES ('default','task',?,?,'triage',?,?)`).run(title, body, priority, JSON.stringify({ plan_id: planId, task_id: tid }));
                    db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,'dispatcher','apply_plan',NULL,'triage',?)`).run(Number(ins.lastInsertRowid), `计划 ${planId} 建卡`);
                    created++;
                    continue;
                }
                if (covered.includes(exist.status)) {
                    db.prepare(`UPDATE cards SET title=?, body=?, priority=?, updated_at=? WHERE id=?`).run(title, body, priority, now, exist.id);
                    db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,'dispatcher','apply_plan',?,?,'计划更新原位覆盖')`).run(exist.id, exist.status, exist.status);
                    overwritten++;
                }
                else {
                    // 进行中/已完成：不覆盖，评论 + stale_plan
                    db.prepare(`UPDATE cards SET meta=?, updated_at=? WHERE id=?`).run(JSON.stringify({ ...JSON.parse(rows.find((r) => r.id === exist.id)?.meta ?? "{}"), plan_id: planId, task_id: tid, stale_plan: true }), now, exist.id);
                    db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,'dispatcher','plan_changed',?,?,'计划已变更，卡片保留当前状态')`).run(exist.id, exist.status, exist.status);
                    db.prepare(`INSERT INTO card_comments(card_id, author, body, created_at) VALUES (?,'dispatcher','计划已变更（同源计划重应用），当前状态保留；如需执行新计划请重置状态。',?)`).run(exist.id, now);
                    staleMarked++;
                }
            }
            db.exec("COMMIT");
        }
        catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
        logDaemon(db, { task: "cards", op: "apply-plan", operator: "human:dashboard", detail: `计划 ${planId}：建 ${created} / 覆盖 ${overwritten} / stale ${staleMarked} / 跳过 ${skipped}` });
        return { ok: true, plan_id: planId, created, overwritten, staleMarked, skipped };
    });
    // —— H2 working 记忆（会话级独立表）——
    app.get("/api/working", async (req) => {
        const session = String(req.query.session ?? "").trim();
        if (!session)
            return { ok: true, items: [] };
        return { ok: true, items: listWorkingMemory(db, session) };
    });
    app.post("/api/working", async (req, reply) => {
        const b = req.body ?? {};
        const session = String(b.session ?? "").trim();
        const key = String(b.key ?? "").trim();
        const content = String(b.content ?? "").trim();
        if (!session || !key || !content)
            return reply.code(400).send({ ok: false, error: "session/key/content 必填" });
        setWorkingMemory(db, session, key, content, String(b.kind ?? "note").trim() || "note");
        return { ok: true };
    });
    app.delete("/api/working", async (req) => {
        const session = String(req.query.session ?? "").trim();
        if (!session)
            return { ok: false, removed: 0 };
        const key = String(req.query.key ?? "").trim();
        const removed = key ? clearWorkingMemory(db, session, key) : clearWorkingMemory(db, session);
        return { ok: true, removed };
    });
    // —— H6 前瞻记忆 due：cron 到期命中 + pattern 匹配会话文本（llm 默认关）。双消费：返回提醒 + auto 建卡 ——
    app.get("/api/prospective/due", async (req) => {
        const text = String(req.query.text ?? "").trim();
        const autoCard = String(req.query.auto_card ?? "1") !== "0";
        const now = new Date().toISOString();
        const rows = db
            .prepare(`SELECT ${BASE_CARD_QUERY_FALLBACK()} FROM memories
         WHERE sector='prospective' AND status='active'
           AND (valid_until IS NULL OR julianday(valid_until) > julianday('now'))
           AND (trigger_kind='cron' OR (trigger_kind='pattern' AND ? <> ''))`)
            .all(text);
        const due = [];
        const created = [];
        for (const r of rows) {
            const kind = String(r.trigger_kind ?? "pattern");
            let hit = false;
            if (kind === "cron") {
                // cron：valid_until 到期即命中（julianday 统一格式，兼容 ISO/空格两种写入）
                hit = !r.valid_until || jdOf(String(r.valid_until)) <= jdNow();
            }
            else if (kind === "pattern" && text) {
                const cond = String(r.trigger_cond ?? "");
                try {
                    hit = new RegExp(cond, "i").test(text);
                }
                catch {
                    hit = text.includes(cond);
                }
            }
            if (!hit)
                continue;
            // 防重放：已有 from_prospective 卡则不重复建
            if (autoCard) {
                const dup = db
                    .prepare(`SELECT id FROM cards WHERE kind='task' AND meta LIKE ? LIMIT 1`)
                    .get(`%"from_prospective":${r.id}%`);
                if (!dup) {
                    const ins = db
                        .prepare(`INSERT INTO cards(board,kind,title,status,meta) VALUES ('default','task',?,'triage',?)`)
                        .run(String(r.trigger_action ?? r.content ?? "前瞻提醒").slice(0, 200), JSON.stringify({ from_prospective: r.id }));
                    writeCardEvent(Number(ins.lastInsertRowid), "dispatcher", "create", null, "triage", `前瞻命中自动建卡 #${r.id}`);
                    created.push({ card_id: Number(ins.lastInsertRowid), memory_id: r.id });
                }
            }
            due.push({ id: r.id, content: r.content, trigger_action: r.trigger_action, trigger_kind: kind, valid_until: r.valid_until });
        }
        return { ok: true, due, auto_created: created };
    });
    /** 兜底列选择（P3 内联）：与 memories 全部列一致但显式列出，避免 * 依赖列顺序 */
    function BASE_CARD_QUERY_FALLBACK() {
        return "id, content, type, agent, agent_fpath, project, status, confidence, eff_confidence, conflict_with, superseded_by, derived_from, hit_count, last_hit_at, created_at, sector, form, salience, decay_lambda, last_seen_at, valid_from, valid_until, trigger_cond, trigger_kind, trigger_action, valence, arousal, source_ref, sensitivity, pinned";
    }
    /** julianday 解析（兼容 ISO 'T' 与 SQLite 空格两种时间格式）；坏值兜底 0 */
    const jdOf = (s) => {
        const r = db.prepare(`SELECT julianday(?) j`).get(s);
        return typeof r?.j === "number" && Number.isFinite(r.j) ? r.j : 0;
    };
    const jdNow = () => db.prepare(`SELECT julianday('now') j`).get().j;
    // —— M4 注入策略核对（≤20 条/4K token；semantic/episodic 各 ≤5，user/procedural 各 ≤3，prospective ≤3，affective ≤2，meta ≤2）——
    app.post("/api/inject", async () => {
        const budget = 20;
        const topBySector = (sector, n) => db
            .prepare(`SELECT id, content FROM memories WHERE sector=? AND status='active' AND sensitivity != 'secret'
           ORDER BY pinned DESC, COALESCE(last_seen_at, created_at) DESC, hit_count DESC LIMIT ?`)
            .all(sector, n).map((r) => ({ id: Number(r.id), content: r.content }));
        const sections = {
            user: topBySector("user", 3),
            procedural: topBySector("procedural", 3),
            semantic: topBySector("semantic", 5),
            episodic: topBySector("episodic", 5),
            prospective: topBySector("prospective", 3),
            affective: topBySector("affective", 2),
        };
        const total = Object.values(sections).reduce((s, a) => s + a.length, 0);
        return { ok: true, budget, total, sections };
    });
    // —— 卡片列表 / 新建 ——
    app.get("/api/cards", async (req) => {
        const where = [];
        const params = [];
        if (req.query.board) {
            where.push("board=?");
            params.push(req.query.board);
        }
        if (req.query.status) {
            where.push("status=?");
            params.push(req.query.status);
        }
        if (req.query.assignee) {
            where.push("assignee=?");
            params.push(req.query.assignee);
        }
        if (req.query.lane) {
            where.push("lane=?");
            params.push(req.query.lane);
        }
        // ★ P1-7：默认不返回终态卡（archived/cancelled）。实测 76 张卡中 46 张为终态，
        //   原实现无默认过滤 → 看板与统计被归档噪声填满。显式 ?status= 或 ?include_terminal=1 可绕过。
        if (!req.query.status && String(req.query.include_terminal ?? "") !== "1")
            where.push(`status NOT IN ('archived','cancelled')`);
        const rows = (where.length
            ? db.prepare(`SELECT * FROM cards WHERE ${where.join(" AND ")} ORDER BY priority DESC, id DESC`).all(...params)
            : db.prepare(`SELECT * FROM cards ORDER BY priority DESC, id DESC`).all());
        const list = rows.map(cardRowOf);
        const buckets = {};
        for (const s of CARD_STATES)
            buckets[s] = [];
        for (const c of list)
            if (buckets[c.status])
                buckets[c.status].push(c);
        return { total: list.length, buckets, lanes: [...new Set(list.map((c) => c.lane).filter(Boolean))] };
    });
    app.post("/api/cards", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardCreate");
        const b = req.body ?? {};
        const title = String(b.title ?? "").trim();
        if (!title)
            return reply.code(400).send({ ok: false, error: "卡片标题不能为空" });
        const kind = String(b.kind ?? "task").trim() || "task";
        const status = CARD_STATES.includes(String(b.status ?? "")) ? String(b.status) : "triage";
        const ins = db
            .prepare(`INSERT INTO cards(board,kind,title,body,status,assignee,priority,meta)
           VALUES (?,?,?,?,?,?,?,?)`)
            .run(String(b.board ?? "default").trim() || "default", kind, title, String(b.body ?? "").trim() || null, status, String(b.assignee ?? "").trim() || null, Math.max(0, Math.floor(Number(b.priority ?? 0) || 0)), b.meta ? JSON.stringify(b.meta) : null);
        const id = Number(ins.lastInsertRowid);
        writeCardEvent(id, "human:dashboard", "create", null, status, title.slice(0, 80));
        return { ok: true, id, status, kind };
    });
    // —— 卡片详情 / 更新 / 删除 ——
    app.get("/api/cards/:id", async (req, reply) => {
        const c = readCard(Number(req.params.id));
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const linksOut = db
            .prepare(`SELECT dst_kind, dst_id, dst_title, kind FROM links WHERE src_kind='card' AND src_id=?`)
            .all(c.id);
        const memRows = db
            .prepare(`SELECT memory_id, relation FROM card_memory WHERE card_id=?`)
            .all(c.id);
        return { ok: true, card: { ...c, meta: readCardMeta(c), links_out: linksOut, memories: memRows } };
    });
    app.put("/api/cards/:id", async (req, reply) => {
        const c = readCard(Number(req.params.id));
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const b = req.body ?? {};
        const title = b.title !== undefined ? String(b.title).trim() : null;
        if (title === "")
            return reply.code(400).send({ ok: false, error: "标题不能为空" });
        db.prepare(`UPDATE cards SET title=COALESCE(?,title), body=COALESCE(?,body), priority=COALESCE(?,priority),
        lane=COALESCE(?,lane), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(title, b.body !== undefined ? String(b.body) : null, b.priority !== undefined ? Math.max(0, Number(b.priority) || 0) : null, b.lane !== undefined ? String(b.lane) : null, c.id);
        writeCardEvent(c.id, "human:dashboard", "update", null, null, "卡片信息更新");
        return { ok: true, id: c.id };
    });
    app.delete("/api/cards/:id", async (req, reply) => {
        const c = readCard(Number(req.params.id));
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        db.prepare(`DELETE FROM card_memory WHERE card_id=?`).run(c.id);
        db.prepare(`DELETE FROM links WHERE (src_kind='card' AND src_id=?) OR (dst_kind='card' AND dst_id=?)`).run(c.id, c.id);
        db.prepare(`DELETE FROM card_events WHERE card_id=?`).run(c.id);
        db.prepare(`DELETE FROM card_comments WHERE card_id=?`).run(c.id);
        db.prepare(`DELETE FROM cards WHERE id=?`).run(c.id);
        return { ok: true, removed: c.id };
    });
    // —— CAS 认领（H3 ①）——
    app.post("/api/cards/:id/claim", async (req, reply) => {
        const id = Number(req.params.id);
        const actor = asOf(req);
        const lock = randomBytes(12).toString("hex");
        const info = db
            .prepare(`UPDATE cards SET status='running', assignee=?, claim_lock=?,
           lease_expires_at=datetime('now','+30 minutes'), heartbeat_at=datetime('now'), updated_at=datetime('now')
         WHERE id=? AND status='ready' AND claim_lock IS NULL`)
            .run(actor, lock, id);
        if (Number(info.changes) === 0)
            return reply.code(409).send({ ok: false, error: "认领失败：卡片不在 ready 或已被认领" });
        writeCardEvent(id, actor, "claim", "ready", "running", `CAS 认领（lock=${lock.slice(0, 8)}…）`);
        syncCardToTask(id); // ★ 认领 → 关联 task 回写 in_progress
        return { ok: true, id, assignee: actor, lock };
    });
    // —— 状态流转（H3 ②：WHERE status=expected_from 前置校验 + 白名单）——
    app.post("/api/cards/:id/status", async (req, reply) => {
        const id = Number(req.params.id);
        const b = req.body ?? {};
        const to = String(b.status ?? "").trim();
        const expectedFrom = String(b.expected_from ?? "").trim() || undefined;
        const actor = String(b.as ?? "").trim() || asOf(req);
        if (!CARD_STATES.includes(to))
            return reply.code(400).send({ ok: false, error: `非法状态 ${to}` });
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (!CARD_TRANSITIONS[c.status]?.includes(to)) {
            return reply.code(409).send({ ok: false, error: `非法迁移 ${c.status} → ${to}` });
        }
        if (c.status === "running" && c.assignee && c.assignee !== "unassigned" && !actor.startsWith("human") && actor !== c.assignee) {
            return reply.code(403).send({ ok: false, error: "非认领者无权流转" });
        }
        const where = expectedFrom ? ` AND status=?` : "";
        const params = expectedFrom ? [expectedFrom] : [];
        const info = db
            .prepare(`UPDATE cards SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?${where}`)
            .run(to, id, ...params);
        if (Number(info.changes) === 0) {
            return reply.code(409).send({ ok: false, error: `状态前置不符（期望 ${expectedFrom}），可能已被其他操作改写` });
        }
        writeCardEvent(id, actor, "status_changed", c.status, to);
        if (to === "done")
            db.prepare(`UPDATE cards SET claim_lock=NULL WHERE id=?`).run(id);
        if (to === "failed")
            db.prepare(`UPDATE cards SET failure_count=failure_count+1 WHERE id=?`).run(id);
        syncCardToTask(id); // ★ 2026-09-15：卡片状态回写关联 task 记忆状态头
        return { ok: true, id, from: c.status, to };
    });
    // —— M2 验收：review → done（meta.acceptance 存在时必须走此端点）——
    app.post("/api/cards/:id/accept", async (req, reply) => {
        const id = Number(req.params.id);
        const actor = String(req.body?.as ?? "").trim() || "human:dashboard";
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (c.status !== "review")
            return reply.code(409).send({ ok: false, error: "仅 review 状态可验收" });
        db.prepare(`UPDATE cards SET status='done', updated_at=datetime('now') WHERE id=? AND status='review'`).run(id);
        writeCardEvent(id, actor, "accept", "review", "done", "验收通过");
        syncCardToTask(id); // ★ 验收 → 关联 task 回写 done
        return { ok: true, id };
    });
    // —— M1 refine：LLM 生成 steps/acceptance 建议（以评论返回，用户确认后写 meta）——
    app.post("/api/cards/:id/refine", async (req, reply) => {
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        // P3 先落骨架评论（LLM 精炼接入放 P4）；前端展示"待细化"引导
        db.prepare(`INSERT INTO card_comments(card_id, author, body) VALUES (?,?,?)`).run(id, "dispatcher", `[refine] 卡片待细化：请补充 steps / acceptance_criteria 后写回 meta（P4 接入 LLM 建议）`);
        writeCardEvent(id, "dispatcher", "auto_refine", null, null, "触发细化建议");
        return { ok: true, id, hint: "已写细化提示评论（LLM 建议待 P4）" };
    });
    // —— 评论（Agent 间协议；H4/R5-3：secret 内容扫描拒绝）——
    app.post("/api/cards/:id/comment", async (req, reply) => {
        const id = Number(req.params.id);
        const b = req.body ?? {};
        const body = String(b.body ?? "").trim();
        if (!body)
            return reply.code(400).send({ ok: false, error: "评论不能为空" });
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const author = String(b.author ?? "").trim() || "human:dashboard";
        const secretPat = /(secret|密码|passwd|token|api[_-]?key|私密)/i;
        if (secretPat.test(body) && !author.startsWith("human")) {
            return reply.code(403).send({ ok: false, error: "评论疑似含敏感信息，仅 human 可强制写入" });
        }
        db.prepare(`INSERT INTO card_comments(card_id, author, body, ref_card_ids) VALUES (?,?,?,?)`).run(id, author, body, Array.isArray(b.ref_card_ids) ? JSON.stringify(b.ref_card_ids) : null);
        writeCardEvent(id, author, "comment", null, null, body.slice(0, 80));
        return { ok: true, id };
    });
    app.get("/api/cards/:id/comments", async (req, reply) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "非法 id" });
        const rows = db.prepare(`SELECT id, author, body, created_at FROM card_comments WHERE card_id=? ORDER BY id ASC`).all(id);
        return { ok: true, comments: rows };
    });
    app.get("/api/cards/:id/events", async (req, reply) => {
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const since = String(req.query.since ?? "").trim();
        const rows = (since
            ? db.prepare(`SELECT * FROM card_events WHERE card_id=? AND created_at>? ORDER BY id`).all(id, since)
            : db.prepare(`SELECT * FROM card_events WHERE card_id=? ORDER BY id`).all(id));
        const comments = db
            .prepare(`SELECT * FROM card_comments WHERE card_id=? ORDER BY id`)
            .all(id);
        return { ok: true, events: rows, comments, latest: rows.length ? rows[rows.length - 1].created_at : null };
    });
    // —— H1 卡片互链：写统一 links 表 + depends 成环校验 ——
    app.post("/api/cards/:id/links", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardLink");
        const id = Number(req.params.id);
        const b = req.body ?? {};
        const dst = Number(b.dst_card_id);
        const kind = String(b.kind ?? "depends").trim();
        if (!CARD_LINK_KINDS.includes(kind))
            return reply.code(400).send({ ok: false, error: `非法关系 ${kind}` });
        const c = readCard(id);
        const d = readCard(dst);
        if (!c || !d)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        // blocks → 反向 depends（M3）
        const finalKind = kind === "blocks" ? "depends" : kind;
        if (finalKind === "depends") {
            if (dependsPathExists(dst, id))
                return reply.code(409).send({ ok: false, error: "成环：dst 已依赖本卡" });
            const dir = finalKind === "depends" ? [id, dst] : [dst, id];
            db.prepare(`INSERT OR IGNORE INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,kind)
           VALUES (NULL,'card',?,'card',?,'depends')`).run(dir[0], dir[1]);
            writeCardEvent(id, "human:dashboard", "link", null, null, `depends → #${dst}`);
        }
        else {
            db.prepare(`INSERT OR IGNORE INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,kind)
           VALUES (NULL,'card',?,'card',?,?)`).run(id, dst, finalKind);
            writeCardEvent(id, "human:dashboard", "link", null, null, `${finalKind} → #${dst}`);
        }
        return { ok: true, from: id, to: dst, kind: finalKind };
    });
    app.delete("/api/cards/:id/links", async (req, reply) => {
        const id = Number(req.params.id);
        const dst = Number(req.query.dst_card_id);
        const kind = String(req.query.kind ?? "depends").trim();
        db.prepare(`DELETE FROM links WHERE src_kind='card' AND src_id=? AND dst_kind='card' AND dst_id=? AND kind=?`).run(id, dst, kind);
        return { ok: true };
    });
    // —— 卡片 ↔ 记忆 关联 ——
    app.post("/api/cards/:id/memory", async (req, reply) => {
        const id = Number(req.params.id);
        const b = req.body ?? {};
        const memoryId = Number(b.memory_id);
        const relation = String(b.relation ?? "context").trim() || "context";
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (!db.prepare(`SELECT id FROM memories WHERE id=?`).get(memoryId))
            return reply.code(404).send({ ok: false, error: "记忆不存在" });
        db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,?)`).run(id, memoryId, relation);
        return { ok: true, card_id: id, memory_id: memoryId, relation };
    });
    app.delete("/api/cards/:id/memory", async (req, reply) => {
        const id = Number(req.params.id);
        const memoryId = Number(req.query.memory_id);
        db.prepare(`DELETE FROM card_memory WHERE card_id=? AND memory_id=?`).run(id, memoryId);
        return { ok: true };
    });
    // —— 心跳续租（R6-4：不写 events）——
    app.post("/api/cards/:id/heartbeat", async (req, reply) => {
        const id = Number(req.params.id);
        const actor = String(req.body?.as ?? "").trim();
        const info = db
            .prepare(`UPDATE cards SET heartbeat_at=datetime('now'), lease_expires_at=datetime('now','+30 minutes') WHERE id=? AND assignee=?`)
            .run(id, actor);
        if (Number(info.changes) === 0)
            return reply.code(409).send({ ok: false, error: "心跳失败：非认领者或无此卡" });
        return { ok: true, id };
    });
    // —— M6 卡片 → 记忆（sector 映射表）——
    app.post("/api/cards/:id/to-memory", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardToMemory");
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const sector = CARD_TO_SECTOR[c.kind] ?? (c.kind === "question" ? "semantic" : "social");
        const row = writeMemory(db, {
            content: `${c.title}${c.body ? "\n\n" + c.body : ""}`,
            type: "task",
            agent: "human:dashboard",
            agent_fpath: null,
            project: String(req.body?.project ?? "global").trim() || "global",
            sector,
            source_ref: `card:${c.id}`,
            confidence: 0.7,
        });
        db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'output')`).run(c.id, row.id);
        return { ok: true, memory_id: row.id, sector };
    });
    // —— 万物卡片化：记忆 → 卡片 / 笔记 → 卡片 / 历史 task 导入 ——
    app.post("/api/cards/from-memory/:id", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardCreate");
        const memoryId = Number(req.params.id);
        const m = db.prepare(`SELECT id, content, sector FROM memories WHERE id=?`).get(memoryId);
        if (!m)
            return reply.code(404).send({ ok: false, error: "记忆不存在" });
        const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(memoryId);
        if (dup)
            return { ok: true, id: dup.id, existed: true };
        const ins = db.prepare(`INSERT INTO cards(board,kind,title,status,ref_kind,ref_id,meta) VALUES ('default','memory',?,'triage','memory',?,?)`)
            .run(m.content.slice(0, 120), memoryId, JSON.stringify({ from_sector: m.sector ?? "episodic" }));
        const id = Number(ins.lastInsertRowid);
        db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'reference')`).run(id, memoryId);
        writeCardEvent(id, "human:dashboard", "create", null, "triage", `由记忆 #${memoryId} 转化`);
        return { ok: true, id, existed: false };
    });
    app.post("/api/cards/from-note/:id", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardCreate");
        const noteId = Number(req.params.id);
        const n = db.prepare(`SELECT id, title, body FROM notes WHERE id=?`).get(noteId);
        if (!n)
            return reply.code(404).send({ ok: false, error: "笔记不存在" });
        const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='note' AND ref_id=?`).get(noteId);
        if (dup)
            return { ok: true, id: dup.id, existed: true };
        const ins = db.prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id) VALUES ('default','note',?,?,'triage','note',?)`)
            .run(n.title, (n.body ?? "").slice(0, 2000) || null, noteId);
        const id = Number(ins.lastInsertRowid);
        writeCardEvent(id, "human:dashboard", "create", null, "triage", `由笔记 #${noteId} 转化`);
        return { ok: true, id, existed: false };
    });
    app.post("/api/cards/import-legacy", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardCreate");
        const tasks = db
            .prepare(`SELECT id, content, created_at FROM memories WHERE type='task' AND status IN ('active','trial') ORDER BY id`)
            .all();
        let created = 0;
        let skipped = 0;
        const ins = db.prepare(`INSERT INTO cards(board,kind,title,status,ref_kind,ref_id,meta,created_at) VALUES ('default','task',?,'todo','memory',?,?,?)`);
        for (const t of tasks) {
            const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(t.id);
            if (dup) {
                skipped++;
                continue;
            }
            // R1-5：剥离约定头
            const title = t.content.replace(/^\[task\]\[[^\]]*\]*\[[^\]]*\]\[[^\]]*\]\s*/g, "").split("\n")[0].slice(0, 120) || `task #${t.id}`;
            ins.run(title, t.id, JSON.stringify({ legacy: true }), t.created_at);
            created++;
        }
        return { ok: true, scanned: tasks.length, created, skipped };
    });
    // —— ★ 2026-09-14 补齐：任务地图数据源 / 位置持久化 / 归档策略 / 卡片↔MCP 任务（前端 9/13 重构先行，后端补齐）——
    // 取全部 active 非 secret 记忆向量（跨 project；卡片无语义归属，需匹配全库）
    const getAllActiveVecs = () => {
        const rows = db
            .prepare(`SELECT mv.memory_id, mv.embedding FROM memory_vectors mv JOIN memories m ON m.id=mv.memory_id
                WHERE m.status='active' AND m.sensitivity != 'secret' AND m.embedding_stale=0`)
            .all();
        return rows.map((r) => ({ id: Number(r.memory_id), vec: bufToVec(r.embedding) }));
    };
    // 任务地图：nodes + links（卡片互链 + card_memory 关联 + aux 辅助卡挂载边）。前端消费字段见任务地图 drawTaskMap。
    app.get("/api/cards/graph", async (req) => {
        const nodes = db.prepare(`SELECT id, board, kind, title, body, status, assignee, priority, meta, ref_kind, ref_id, created_at FROM cards ORDER BY priority DESC, id`).all().map(cardRowOf).map((c) => ({
            id: c.id, board: c.board, kind: c.kind, title: c.title, body: c.body, status: c.status, assignee: c.assignee,
            priority: Number(c.priority ?? 0), meta: readCardMeta(c), ref_kind: c.ref_kind, ref_id: c.ref_id,
            created_at: c.created_at,
        }));
        const cardIds = new Set(nodes.map((n) => n.id));
        // 卡片单向链：depends/blocks/relates/spawned_by/duplicates + kind='aux_*' 辅助挂载边
        const cardLinks = db.prepare(`SELECT src_id, dst_id, kind, context FROM links WHERE src_kind='card' AND dst_kind='card' AND dst_id IS NOT NULL`).all();
        // card_memory 关联 → aux 记忆节点（kind='aux_memory'，前端作为辅助卡挂载，不参与任务分层）
        const memRows = db.prepare(`SELECT cm.card_id, cm.memory_id, cm.relation, m.content, m.sensitivity FROM card_memory cm LEFT JOIN memories m ON m.id=cm.memory_id WHERE m.sensitivity != 'secret'`).all();
        const links = [...cardLinks];
        for (const m of memRows) {
            if (!cardIds.has(m.card_id))
                continue;
            // ★ 记忆子卡用负整数占位 id（卡片 id 恒为正，负 id 天然不冲突；前端 Number 索引可正常工作）
            const memId = -(1000000 + m.memory_id);
            nodes.push({ id: memId, board: "default", kind: "aux_memory", title: (m.content ?? `记忆#${m.memory_id}`).replace(/\s+/g, " ").slice(0, 60), body: null, status: "", assignee: null, priority: 0, meta: {}, ref_kind: null, ref_id: null, created_at: "" });
            links.push({ src_id: m.card_id, dst_id: memId, kind: "aux_memory", context: m.relation });
        }
        // ★ 2026-09-14 v2：自动关联（仅展示不落库；?auto=0 关闭）。升级为语义路：
        //   · 连线：任务卡两两「标题+正文」嵌入向量余弦相似 → relates_auto 虚线（语义近似，非词枚举）
        //   · 子卡：任务卡「标题+正文」向量 vs 记忆库 active 记忆向量余弦 → 相似记忆 aux_memory 子卡
        //   记忆向量直接取（免重算）；卡向量实时 embed（卡量少可承受）。embedding 失败 → 静默降级（不连线不补卡）。
        if (String(req.query.auto ?? "0") !== "0") {
            const tasks = nodes.filter((n) => !(String(n.kind).startsWith("aux_")));
            try {
                const embedder = await getEmbedder();
                // 任务卡文本 = 标题 + 正文（截 600 字，够表达语义；卡无向量）
                const cardText = new Map();
                tasks.forEach((n) => cardText.set(n.id, `${n.title}\n${String(n.body ?? "").slice(0, 600)}`.trim()));
                const textList = tasks.map((n) => cardText.get(n.id) ?? "");
                const cardVecs = await embedder.embedTexts(textList); // 每卡 1 vec，顺序对应 tasks
                if (cardVecs[0] && cardVecs[0].length) {
                    const vecByCard = new Map();
                    tasks.forEach((n, i) => vecByCard.set(n.id, cardVecs[i]));
                    // ① 连线：任务卡两两余弦 ≥0.55 → relates_auto 虚线
                    const CONNECT_SIM = 0.55;
                    const autoSeen = new Set();
                    for (let i = 0; i < tasks.length; i++) {
                        for (let j = i + 1; j < tasks.length; j++) {
                            const ia = tasks[i].id, ib = tasks[j].id;
                            const s = cosine(vecByCard.get(ia), vecByCard.get(ib));
                            if (s < CONNECT_SIM)
                                continue;
                            const key = Math.min(ia, ib) + ">" + Math.max(ia, ib);
                            if (autoSeen.has(key))
                                continue;
                            autoSeen.add(key);
                            links.push({ src_id: ia, dst_id: ib, kind: "relates_auto", context: `语义相似 ${s.toFixed(2)}`, auto: true });
                        }
                    }
                    // ② 子卡：任务卡向量 vs 记忆库 active 记忆向量 → 相似记忆 aux_memory
                    const SUB_SIM = 0.5;
                    const memById = new Map(getAllActiveVecs().map((v) => [v.id, v.vec]));
                    const seenMemNodes = new Set(nodes.map((n) => String(n.id)));
                    const memByCard = new Set(memRows.map((m) => m.card_id + ":" + m.memory_id));
                    const memContent = new Map(); // 需要时再补拉 content（仅命中者）
                    const fetchMem = (ids) => {
                        if (!ids.length)
                            return;
                        const ph = ids.map(() => "?").join(",");
                        db.prepare(`SELECT id, content FROM memories WHERE id IN (${ph})`).all(...ids).forEach((r) => memContent.set(r.id, r.content));
                    };
                    const pending = [];
                    for (const card of tasks) {
                        const cv = vecByCard.get(card.id);
                        const scored = [...memById.entries()]
                            .map(([mid, mv]) => ({ mid, s: cosine(cv, mv) }))
                            .filter((x) => x.s >= SUB_SIM)
                            .sort((a, b) => b.s - a.s)
                            .slice(0, 3); // 每卡最多 3 个语义相似子卡
                        for (const hit of scored) {
                            const memId = -(1000000 + hit.mid);
                            if (memByCard.has(card.id + ":" + hit.mid))
                                continue;
                            if (!seenMemNodes.has(String(memId))) {
                                pending.push(hit.mid);
                                seenMemNodes.add(String(memId));
                                nodes.push({ id: memId, board: "default", kind: "aux_memory", title: "", body: null, status: "", assignee: null, priority: 0, meta: {}, ref_kind: null, ref_id: null, created_at: "" });
                            }
                            links.push({ src_id: card.id, dst_id: memId, kind: "aux_memory", context: `语义匹配 · ${hit.s.toFixed(2)}`, auto: true });
                        }
                    }
                    // 补拉命中的记忆正文 → 填子卡 title
                    fetchMem(pending);
                    nodes.forEach((n) => {
                        if (typeof n.id === "number" && n.id < 0 && String(n.kind).startsWith("aux_")) {
                            const mid = (-n.id) - 1000000;
                            const c = memContent.get(mid) ?? "";
                            n.title = c.replace(/\s+/g, " ").slice(0, 80) || `记忆#${mid}`;
                        }
                    });
                }
            }
            catch {
                // embedding 不可用 → 静默跳过自动关联（不崩溃）
            }
        }
        // 序列化统一转字符串（数字卡片 id 与 "mem-N" 字符串 id 均可；前端 Number() 容错数字）
        const serializable = (v) => String(v);
        // ★ 2026-09-15（看板 58→25 根治）：状态语义归一。给每个节点补 bucket：
        //   active（ready/todo/running=真实未完成）/ done / terminal（archived/cancelled/failed=已终结）
        //   aux 子卡无任务状态 → bucket=null。前端未完成计数只取 bucket==='active'，终结态不再混入。
        const TERMINAL = new Set(["archived", "cancelled", "failed"]);
        const nodesWithBucket = nodes.map((n) => {
            const kind = String(n.kind ?? "");
            const bucket = kind.startsWith("aux_") || kind === "aux" ? null
                : n.status === "done" ? "done"
                    : TERMINAL.has(String(n.status)) ? "terminal"
                        : "active";
            return { ...n, bucket };
        });
        return {
            ok: true,
            auto: String(req.query.auto ?? "0") !== "0",
            nodes: nodesWithBucket.map((n) => ({ ...n, id: serializable(n.id) })),
            links: links.map((l) => ({ ...l, src_id: serializable(l.src_id), dst_id: serializable(l.dst_id) })),
        };
    });
    // 拖拽位置持久化：meta.map_pos[view]（h 横屏 / v 竖屏），返回 {ok}
    app.post("/api/cards/:id/position", async (req, reply) => {
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const view = String(req.body?.view ?? "h").trim().slice(0, 8) || "h";
        const x = Math.round(Number(req.body?.x) || 0);
        const y = Math.round(Number(req.body?.y) || 0);
        const meta = readCardMeta(c);
        const mapPos = (meta.map_pos && typeof meta.map_pos === "object" ? meta.map_pos : {});
        mapPos[view] = { x, y };
        meta.map_pos = mapPos;
        db.prepare(`UPDATE cards SET meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(JSON.stringify(meta), id);
        return { ok: true, id, view, x, y };
    });
    // 重置所有手动位置：清空全部卡片的 meta.map_pos
    app.delete("/api/cards/positions", async (req) => {
        const rows = db.prepare(`SELECT id, meta FROM cards`).all();
        const upd = db.prepare(`UPDATE cards SET meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`);
        let cleared = 0;
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const r of rows) {
                let meta = {};
                try {
                    meta = r.meta ? JSON.parse(r.meta) : {};
                }
                catch { /* 坏 JSON 忽略 */ }
                if (!meta.map_pos)
                    continue;
                delete meta.map_pos;
                upd.run(JSON.stringify(meta), r.id);
                cleared++;
            }
            db.exec("COMMIT");
        }
        catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
        return { ok: true, cleared };
    });
    // 归档策略：GET 读模式，POST {mode:'auto'|'manual'} 切换 / {now:true} 立即归档（done 超阈值 → archived）。
    // 策略存 config 表（cards.archive_mode / cards.archive_days），与桌面托盘/daemon 共用持久 key。
    app.get("/api/cards/archive", async () => {
        const mode = String(readConfig(db, "cards.archive_mode", "auto") ?? "auto");
        const days = Number(readConfig(db, "cards.archive_days", 7) ?? 7);
        return { ok: true, mode: mode === "manual" ? "manual" : "auto", days };
    });
    app.post("/api/cards/archive", async (req, reply) => {
        const b = req.body ?? {};
        if (b.mode !== undefined) {
            const mode = String(b.mode).trim();
            if (mode !== "auto" && mode !== "manual")
                return reply.code(400).send({ ok: false, error: "mode 仅支持 auto/manual" });
            writeConfig(db, "cards.archive_mode", mode);
            return { ok: true, mode };
        }
        if (b.days !== undefined) {
            const days = Math.max(1, Math.floor(Number(b.days) || 7));
            writeConfig(db, "cards.archive_days", days);
            return { ok: true, days };
        }
        // now:true 立即归档：done 且完成时间（updated_at）超阈值 → archived（写事件留痕）
        const days = Number(readConfig(db, "cards.archive_days", 7) ?? 7);
        const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
        const done = db.prepare(`SELECT id FROM cards WHERE status='done' AND COALESCE(updated_at, created_at) < ?`).all(cutoff);
        const upd = db.prepare(`UPDATE cards SET status='archived', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='done'`);
        let archived = 0;
        db.exec("BEGIN IMMEDIATE");
        try {
            for (const c of done) {
                const info = upd.run(c.id);
                if (Number(info.changes)) {
                    writeCardEvent(c.id, "human:dashboard", "archive", "done", "archived", `手工归档（阈值 ${days} 天）`);
                    archived++;
                }
            }
            db.exec("COMMIT");
        }
        catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
        return { ok: true, run: { archived, cutoffDays: days }, mode: String(readConfig(db, "cards.archive_mode", "auto")) };
    });
    // 卡片 ↔ MCP 任务：把卡片状态/标题回写到绑定的 task 记忆头（ref_kind='memory' 且 ref_id 有效）。
    // 幂等：状态已一致 → {noop:true}；否则重写 content 头 → {from,to,memory_id}。返回结构见前端 pushMcpBtn。
    app.post("/api/cards/:id/push-to-task", async (req, reply) => {
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (c.ref_kind !== "memory" || !c.ref_id)
            return reply.code(400).send({ ok: false, error: "卡片未绑定 MCP 任务" });
        const memoryId = Number(c.ref_id);
        const m = db.prepare(`SELECT id, content FROM memories WHERE id=?`).get(memoryId);
        if (!m)
            return reply.code(404).send({ ok: false, error: "绑定任务记忆不存在" });
        // 卡片状态 → task 七态（迁移矩阵；与看板状态机一致）
        const TASK_MAP = { triage: "pending", todo: "pending", ready: "pending", running: "in_progress", review: "review", done: "done", failed: "failed", blocked: "blocked", cancelled: "cancelled" };
        const toStatus = TASK_MAP[c.status] ?? c.status;
        const toAssignee = c.assignee ?? "";
        // 解析现有 content 头
        const am = m.content.match(/\[assignee:([^\]]*)\]/);
        const sm = m.content.match(/\[status:([^\]]*)\]/);
        const curStatus = sm ? sm[1] : null;
        const curAssignee = am ? am[1] : "";
        // 归一旧头状态方便比对
        const normFrom = curStatus ? (TASK_NORMALIZE[curStatus] ?? curStatus) : null;
        const noop = normFrom === toStatus && curAssignee === toAssignee;
        if (!noop) {
            const head = `[task][assignee:${toAssignee}][status:${toStatus}]`;
            // ★ 修正（2026-09-14 实证）：一次replace误二次replace导致头重复追加。
            //   若已有完整头 → 原位替换；否则整体前置新头（保留原正文/依赖段）。
            let newContent;
            if (/^\[task\]\[assignee:[^\]]*\]\[status:[^\]]*\]/.test(m.content)) {
                newContent = m.content.replace(/^\[task\]\[assignee:[^\]]*\]\[status:[^\]]*\]/, head);
            }
            else {
                newContent = `${head} ${m.content}`;
            }
            db.prepare(`UPDATE memories SET content=?, status=? WHERE id=?`).run(newContent, "active", memoryId);
        }
        return { ok: true, noop, from: curStatus ?? null, to: toStatus, memory_id: memoryId };
    });
    // —— 卡片上下文（★ 2026-09-14 v2：给智能体消费的完整语义上下文）——
    // 返回本卡详情 + 手动绑定的记忆全文 + 语义最相似记忆全文 + 关联卡片标题。
    // 目的：自动关联仅存在于 dashboard 视图层（不落库），MCP/agent 读不到；
    //   此端点是它们获取「本卡该知道什么」的入口 —— 把动态记忆匹配固化到可调用 API。
    app.get("/api/cards/:id/context", async (req, reply) => {
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const meta = readCardMeta(c);
        // 手动绑定记忆（card_memory）+ 绑定任务记忆（ref）
        const boundRows = db.prepare(`SELECT cm.memory_id, cm.relation FROM card_memory cm WHERE cm.card_id=?`).all(id);
        const related = new Map();
        boundRows.forEach((b) => related.set(b.memory_id, b.relation));
        if (c.ref_kind === "memory" && c.ref_id)
            related.set(Number(c.ref_id), "task-ref");
        // 发文链接（卡片互链）
        const outLinks = db.prepare(`SELECT dst_id, kind FROM links WHERE src_kind='card' AND src_id=? AND dst_kind='card' AND dst_id IS NOT NULL`).all(id);
        // 语义最相似记忆（取本卡向量 vs 记忆向量）
        const similar = [];
        try {
            const embedder = await getEmbedder();
            const text = `${c.title}\n${c.body ?? ""}`.trim();
            const [cv] = await embedder.embedTexts([text]);
            if (cv && cv.length) {
                const memvec = getAllActiveVecs().filter((v) => !related.has(v.id));
                const scored = memvec.map((v) => ({ memory_id: v.id, sim: cosine(cv, v.vec) })).filter((x) => x.sim >= 0.5).sort((a, b) => b.sim - a.sim).slice(0, 5);
                // 去重：排除已手动绑定的
                scored.forEach((s) => similar.push(s));
            }
        }
        catch {
            // embedding 不可用 → 仅返回手动绑定
        }
        const ids = [...related.keys(), ...similar.map((s) => s.memory_id)];
        const memFull = new Map();
        if (ids.length) {
            const ph = ids.map(() => "?").join(",");
            db.prepare(`SELECT id, content, type, confidence, created_at FROM memories WHERE id IN (${ph}) AND sensitivity != 'secret'`).all(...ids).forEach((r) => memFull.set(r.id, { content: r.content, type: r.type, confidence: r.confidence, created_at: r.created_at }));
        }
        // 关联卡标题
        const linkedCards = new Map();
        if (outLinks.length) {
            const ph = outLinks.map(() => "?").join(",");
            db.prepare(`SELECT id, title FROM cards WHERE id IN (${ph})`).all(...outLinks.map((l) => l.dst_id)).forEach((r) => linkedCards.set(r.id, r.title));
        }
        return {
            ok: true,
            card: { id: c.id, kind: c.kind, title: c.title, body: c.body, status: c.status, assignee: c.assignee, priority: c.priority, ref_kind: c.ref_kind, ref_id: c.ref_id, meta },
            bound_memories: [...related.entries()].map(([mid, relation]) => ({ memory_id: mid, relation, ...memFull.get(mid) })).filter((m) => m.content),
            similar_memories: similar.map((s) => ({ memory_id: s.memory_id, sim: s.sim, ...memFull.get(s.memory_id) })).filter((m) => m.content),
            linked_cards: [...outLinks.map((l) => ({ dst_id: l.dst_id, kind: l.kind, title: linkedCards.get(l.dst_id) ?? "" }))],
        };
    });
    // —— Dispatcher（H3 租约回收 / M1 triage 超时 / M3 依赖提升 / 熔断 / H6 前瞻联动）——
    app.post("/api/dispatch", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardDispatch");
        const out = { leased_back: 0, promoted: [], blocked: [], auto_refined: [], prospective_cards: [] };
        const now = new Date().toISOString();
        db.exec("BEGIN IMMEDIATE");
        try {
            // ① 租约回收（H3）：过期 running → ready，清 assignee/claim_lock，事件 lease_expired
            const expired = db
                .prepare(`SELECT id, assignee FROM cards WHERE status='running' AND lease_expires_at < ?`)
                .all(now);
            for (const e of expired) {
                db.prepare(`UPDATE cards SET status='ready', assignee=NULL, claim_lock=NULL, updated_at=? WHERE id=?`).run(now, e.id);
                writeCardEvent(e.id, "dispatcher", "lease_expired", "running", "ready", `租约过期（原 ${e.assignee ?? "?"}），产物请从评论交接`);
                out.leased_back++;
            }
            // ② triage 超时（M1）：>24h 未动 → todo
            const stale = db
                .prepare(`SELECT id FROM cards WHERE status='triage' AND created_at < datetime('now','-24 hours')`)
                .all();
            for (const s of stale) {
                db.prepare(`UPDATE cards SET status='todo', updated_at=? WHERE id=?`).run(now, s.id);
                writeCardEvent(s.id, "dispatcher", "auto_refine", "triage", "todo", "24h 未动自动提升");
                out.auto_refined.push(s.id);
            }
            // ③ 依赖提升（M3）：todo 且 depends 全 done → ready
            const todos = db.prepare(`SELECT id FROM cards WHERE status='todo'`).all();
            for (const t of todos) {
                if (cardDependsDone(t.id)) {
                    db.prepare(`UPDATE cards SET status='ready', updated_at=? WHERE id=?`).run(now, t.id);
                    writeCardEvent(t.id, "dispatcher", "auto_ready", "todo", "ready", "依赖已满足");
                    out.promoted.push(t.id);
                }
            }
            // ④ 熔断：failure_count>=2 且 failed → blocked
            const failed = db.prepare(`SELECT id FROM cards WHERE status='failed' AND failure_count>=2`).all();
            for (const f of failed) {
                db.prepare(`UPDATE cards SET status='blocked', updated_at=? WHERE id=?`).run(now, f.id);
                writeCardEvent(f.id, "dispatcher", "circuit_break", "failed", "blocked", "连续失败≥2 熔断");
                out.blocked.push(f.id);
            }
            // ⑤ 前瞻联动（H6）：cron 到期 → 自动建卡（防重放由 due 内部处理）
            const dueRes = await (async () => {
                const rows = db
                    .prepare(`SELECT id, content, trigger_action, trigger_kind, valid_until FROM memories
             WHERE sector='prospective' AND status='active' AND trigger_kind='cron'
               AND valid_until IS NOT NULL AND julianday(valid_until) <= julianday('now')`)
                    .all();
                const created = [];
                for (const r of rows) {
                    const dup = db.prepare(`SELECT id FROM cards WHERE meta LIKE ? LIMIT 1`).get(`%"from_prospective":${r.id}%`);
                    if (dup)
                        continue;
                    const ins = db
                        .prepare(`INSERT INTO cards(board,kind,title,status,meta) VALUES ('default','task',?,'triage',?)`)
                        .run(String(r.trigger_action ?? r.content ?? "前瞻提醒").slice(0, 200), JSON.stringify({ from_prospective: r.id }));
                    const cid = Number(ins.lastInsertRowid);
                    writeCardEvent(cid, "dispatcher", "create", null, "triage", `前瞻 cron 命中 #${r.id}`);
                    created.push(cid);
                }
                return created;
            })();
            out.prospective_cards = dueRes;
            db.exec("COMMIT");
        }
        catch (e) {
            db.exec("ROLLBACK");
            throw e;
        }
        return { ok: true, ...out };
    });
}
