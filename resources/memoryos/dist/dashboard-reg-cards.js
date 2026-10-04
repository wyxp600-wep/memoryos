/** T8（P2-3）：buildApp 路由域拆分 —— cards 域。
 * handler 自 dashboard.js 原行 1332-2396 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { logUsage, logDaemon, writeMemory, listWorkingMemory, setWorkingMemory, clearWorkingMemory, readMemory, readConfig, writeConfig, SECTORS, SECTOR_KEYS, updateMemory, setCardEvtPusher, createDispatch, settleDispatch, releaseDispatch } from "./db.js";
import { getEmbedder, cosine, bufToVec } from "./embed.js";
import { randomBytes } from "node:crypto";
import { TASK_NORMALIZE, CARD_TO_TASK } from "./task-status-map.js";
import { scanAgents } from "./scan.js"; // 节点画布：智能体卡载体在位探测（agent_key 对账）
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
    const CARD_LINK_KINDS = ["depends", "blocks", "relates", "spawned_by", "duplicates", "handoff"]; // ★ P4：handoff=交接文档挂边（任务卡→交接卡，图上派生视觉边）
    /** M6：卡片 kind → sector 映射（cards/:id/to-memory 用） */
    const CARD_TO_SECTOR = {
        task: "social",
        note: "semantic",
        message: "meta",
        artifact: "procedural",
        memory: "episodic",
    };
    /* ★ 实时看板：卡片事件总线。所有变更都经过 writeCardEvent → 推给 /api/cards/stream 的 SSE 订阅者。
     *  订阅者是 SSE 写函数，写失败（连接已断）即摘除。心跳防断连由 SSE 路由侧负责。 */
    const cardSubs = new Set();
    // ★ 修 #13（2026-09-19）：auto 模式卡向量缓存（key=卡id+标题+正文前600字）—— 原每次请求全量重嵌，
    //   把嵌入 API 打成 O(n)/请求；未变更的卡直接复用上次向量。超 2000 条整体清空防膨胀（宁重嵌不涨内存）。
    const cardVecCache = new Map();
    function pushCardEvt(evt) {
        const payload = `event: card\ndata: ${JSON.stringify(evt)}\n\n`;
        for (const sub of [...cardSubs]) {
            try { sub(payload); } catch { cardSubs.delete(sub); }
        }
    }
    setCardEvtPusher(pushCardEvt); // ★ 2026-09-25 方案A：db.js convergeLinkedCards（记忆终态→卡片收敛）同进程写 card_events 时即时推 SSE
    /* ★ 跨进程事件补流（2026-09-18）：MCP server / daemon 等独立进程直写 card_events
     *  （task_claim/task_done/task_release、apply-plan、mcp_reopen…），不经过本进程 pushCardEvt。
     *  有订阅者时以 2s 轮询 card_events 增量补推（水位线 lastId）；与进程内即时推送重复无害
     *  （前端 800ms 防抖合并）；无订阅者即停轮询。 */
    let evtWatermark = 0, evtPoller = null;
    function ensureEvtPoller() {
        if (evtPoller)
            return;
        evtWatermark = Number(db.prepare(`SELECT COALESCE(MAX(id),0) m FROM card_events`).get()?.m ?? 0);
        evtPoller = setInterval(() => {
            try {
                // ★ 2026-09-19（弊端 L2）：补流排空（500 条/批 × 最多 5 批/拍）——原单批 100 条，事件速率 >50/s 时水位永久落后
                for (let i = 0; i < 5; i++) {
                    const rows = db.prepare(`SELECT id, card_id, actor, action, from_status, to_status FROM card_events WHERE id > ? ORDER BY id LIMIT 500`).all(evtWatermark);
                    if (!rows.length)
                        break;
                    for (const r of rows) {
                        evtWatermark = Math.max(evtWatermark, Number(r.id));
                        pushCardEvt({ type: r.action, cardId: Number(r.card_id), from: r.from_status ?? null, to: r.to_status ?? null, actor: r.actor, ts: Date.now() });
                    }
                    if (rows.length < 500)
                        break;
                }
            }
            catch { /* 单轮失败下轮重试 */ }
        }, 2000);
        evtPoller.unref?.();
    }
    function stopEvtPoller() {
        if (evtPoller) {
            clearInterval(evtPoller);
            evtPoller = null;
        }
    }
    function cardRowOf(r) {
        return {
            id: Number(r.id), board: r.board, kind: r.kind, title: r.title, body: r.body, status: r.status,
            assignee: r.assignee, lane: r.lane, priority: Number(r.priority ?? 0), failure_count: Number(r.failure_count ?? 0),
            claim_lock: r.claim_lock, lease_expires_at: r.lease_expires_at, heartbeat_at: r.heartbeat_at, lease_notice_at: r.lease_notice_at ?? null, lease_stale_at: r.lease_stale_at ?? null,
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
    /* ★ 修 #9（2026-09-19）：事务内事件先入队、COMMIT 后再推 —— 原 pushCardEvt 在 BEGIN IMMEDIATE
     *  事务（dispatch / archive / apply-plan）里同步直推，一旦 ROLLBACK 前端已收到实际没发生的假事件。
     *  txBegin/txCommit/txRollback 是本模块事务的统一入口；不经过它们的事务不写卡片事件，互不影响。 */
    let txEvtQueue = null;
    function txBegin() { db.exec("BEGIN IMMEDIATE"); txEvtQueue = []; }
    function txCommit() {
        db.exec("COMMIT");
        const q = txEvtQueue;
        txEvtQueue = null;
        for (const e of q) { try { pushCardEvt(e); } catch { /* 订阅者写失败由 pushCardEvt 自行摘除 */ } }
    }
    function txRollback() { db.exec("ROLLBACK"); txEvtQueue = null; }
    function writeCardEvent(cardId, actor, action, fromStatus, toStatus, detail) {
        db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail)
       VALUES (?,?,?,?,?,?)`).run(cardId, actor, action, fromStatus ?? null, toStatus ?? null, detail ?? null);
        const evt = { type: action, cardId: Number(cardId), from: fromStatus ?? null, to: toStatus ?? null, actor, ts: Date.now() };
        if (txEvtQueue) { txEvtQueue.push(evt); return; }
        try { pushCardEvt(evt); } catch { /* 推送失败不影响落库 */ }
    }
    /** ★ 2026-09-15：卡片状态 → 关联 task 记忆状态头回写（task_assign 建的卡 ref_kind='memory'，dispatch 关联）。
     *  卡片流转会同步 memories 里对应 type='task' 的内容头 [status:]，保持「地图卡 ↔ MCP 任务」双向一致。
     *  ★ 一致性②（2026-09-19）：改走 db.updateMemory() 正门 —— 原裸 `UPDATE memories SET content=?` 不递增
     *  version、不同步 FTS/2-gram：① MCP 侧 CAS（WHERE version=?）感知不到本回写，认领会把看板改动覆盖回去
     *  （丢失更新）；② 检索索引脏读（原 128-129 行注释自认的既有坑）。现 CAS 写入一次完成 version+1 + 索引同步；
     *  版本漂移（MCP 侧刚改过头）→ 让位不硬写：卡向头对齐是 C-5 投影口径，30s 任务桥 / 5min 对账兜底，
     *  盲目硬写会与 MCP 打架（后写覆盖前写）。
     *  ★ 修 #10（2026-09-19）：opts.assignee 传入时同步回写头的 [assignee:] 段（看板认领用）——
     *  原来只写 status，看板认领后头里 assignee 恒 ?，后续凭据归属/心跳权限判断全失准。 */
    function syncCardToTask(cardId, opts = {}) {
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
            // 卡片状态 → 任务状态头映射（★ 一致性③：改用权威对照表 task-status-map.js；E-0：review→in_progress / failed→blocked / archived→archived）
            const toSt = CARD_TO_TASK[card.status];
            if (!toSt)
                return;
            const newAssignee = opts.assignee === undefined ? null : String(opts.assignee ?? "");
            for (let attempt = 0; attempt < 2; attempt++) {
                const mem = db.prepare(`SELECT id, content, version FROM memories WHERE id=? AND type='task' AND status IN ('active','trial')`).get(memRow.id);
                if (!mem)
                    return;
                const st = mem.content.match(/\[status:([^\]]+)\]/);
                if (!st)
                    return;
                const curAssignee = mem.content.match(/\[assignee:([^\]]*)\]/)?.[1];
                if (st[1] === toSt && (newAssignee === null || curAssignee === newAssignee))
                    return; // 头已是目标态（含他人刚对齐），无事可做
                let newContent = mem.content.replace(`[status:${st[1]}]`, `[status:${toSt}]`);
                if (newAssignee !== null) {
                    if (/\[assignee:[^\]]*\]/.test(newContent))
                        newContent = newContent.replace(/\[assignee:[^\]]*\]/, `[assignee:${newAssignee}]`);
                    else
                        newContent = newContent.replace(`[status:${toSt}]`, `[assignee:${newAssignee}][status:${toSt}]`); // 头缺 assignee 段（legacy）→ 补进 status 前
                }
                const ok = updateMemory(db, mem.id, { content: newContent, expectedVersion: mem.version }); // ★ 正门 CAS
                if (ok)
                    return; // version+1 + FTS/2-gram 同步已随写入完成
                // 版本漂移：重读一次再试（第二次仍漂移 = MCP 侧正在改写 → 让位，交对账兜底）
            }
            console.error(`[syncCardToTask] 卡片 #${cardId} → 任务头回写让位：任务 #${memRow.id} 版本持续漂移（MCP 侧正在改写），交由对账对齐`);
        }
        catch (e) {
            /* 回写失败不阻断卡片流程 —— 但必须留痕：静默会让"卡已流转、任务头未跟"完全隐身（2026-09-16 A 分区验收口径） */
            console.error(`[syncCardToTask] 卡片 #${cardId} → 任务头回写失败：${e.message}`);
        }
    }
    /** 请求中的自我声明身份（单机单用户，README 已声明不防恶意本机调用，R4-6） */
    function asOf(req) {
        return String(req.query.as ?? "").trim() || "unassigned";
    }
    /** ★ ①（2026-09-24）：agent 名写凭据校验（web 卡面 4 端点闭合 L1/L2 冒名闭环）。
     *  规则：actor 非 kebab（human 前缀/unassigned/?/空等人类或缺省流量）→ null 直接放行，行为零变化；
     *  kebab 名 → 查 agent_credentials 有效写凭据（owner 匹配 / 未吊销 / 未过期 / scope≠read）；
     *  无效且 MEMORYOS_A1_ENFORCE=1（硬模式）→ 返回 403 错误串；软模式 → 放行（与 MCP 侧 A1 口径一致）。 */
    const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
    function actorCredError(actor, credential) {
        const a = String(actor ?? "").trim();
        if (!AGENT_NAME_RE.test(a))
            return null; // 非 kebab：human:dashboard / unassigned / "?" / 空 → 人类或异常流量，原语义不变
        const credRows = credential
            ? db.prepare(`SELECT agent, scope, expires_at, revoked_at FROM agent_credentials WHERE credential=?`).all(String(credential))
            : [];
        const credOk = credRows.some((r) => r.agent === a && !r.revoked_at && !(r.expires_at && r.expires_at <= new Date().toISOString()) && r.scope !== "read"); // 与 MCP isCredentialValid 口径一致
        if (credOk)
            return null;
        if (process.env.MEMORYOS_A1_ENFORCE === "1")
            return `A1 硬模式：agent「${a}」无有效写凭据（MEMORYOS_A1_ENFORCE=1），本操作拒绝；请携带有效 credential 参数或改用 task_* MCP 工具`;
        return null; // 软模式：放行（与 MCP checkWriteCredential 同口径）
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
    /* ★ A1 一键派发收口（对标 orca worker_done）：run 终态回调 —— 卡片 running →
     *   review（成功，交回人工验收）/ failed（失败，failure_count+1），并结算工作证。
     *  幂等三层：① 卡已不在 running（agent 自己 task_done 已收口 / 人工已流转）→ 只补结算不改状态；
     *  ② settleDispatch 自带 WHERE state='active' 守卫，重复结算天然无害；
     *  ③ 全程 try 包裹 —— 收口失败不能反噬 run 终态。 */
    function finalizeCardDispatch(info) {
        const cardId = Number(info?.cardId);
        if (!cardId)
            return { ok: false, reason: "no-card" };
        const c = readCard(cardId);
        if (!c)
            return { ok: false, reason: "card-gone" };
        const actor = String(info.actor || "dispatch-agent");
        const detail = String(info.detail ?? "").slice(0, 160);
        let statusChanged = null;
        // 只收口「本派发自己领的那张卡」（他人中途接管则让位，交对账/人工）
        if (c.status === "running" && (!c.assignee || c.assignee === "unassigned" || c.assignee === actor)) {
            const to = info.ok ? "review" : "failed";
            if (CARD_TRANSITIONS[c.status]?.includes(to)) {
                const g = db
                    .prepare(`UPDATE cards SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='running'`)
                    .run(to, cardId);
                if (Number(g.changes)) {
                    statusChanged = to;
                    writeCardEvent(cardId, actor, "status_changed", "running", to, detail);
                    // 三清（锁 + 租约窗 + 贴条/裁决标记）：run 已终态，残留锁会卡死后续认领
                    db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(cardId);
                    if (to === "failed")
                        db.prepare(`UPDATE cards SET failure_count=failure_count+1 WHERE id=?`).run(cardId);
                    syncCardToTask(cardId); // 头状态回写（review→in_progress / failed→blocked）
                }
            }
        }
        let settled = false;
        if (info.dispatchId) {
            settled = settleDispatch(db, info.dispatchId, info.ok ? "succeeded" : "failed", detail || (info.runId ? `run ${info.runId}` : "dispatch-agent"));
            // ★ 节点画布：派发边随工作证终态翻投影状态（边表永不裁决，只跟随真源）
            try {
                db.prepare(`UPDATE card_edges SET status=? WHERE dispatch_id=? AND kind='dispatch' AND status='active'`)
                    .run(info.ok ? "completed" : "cancelled", info.dispatchId);
            }
            catch (e) { console.error("[cards] 派发边随工作证翻状态失败（容忍：边表异常不反噬收口）", e); }
        }
        else {
            // ★ 卡级派发（无关联任务记忆 → 无工作证）：按源卡翻边，防边永远停在 active
            try {
                db.prepare(`UPDATE card_edges SET status=? WHERE source_id=? AND kind='dispatch' AND status='active'`)
                    .run(info.ok ? "completed" : "cancelled", cardId);
            }
            catch (e) { console.error("[cards] 卡级派发边翻状态失败（容忍：不反噬收口）", e); }
        }
        // ★ P4 交接文档卡：仅成功收口生成（失败不产交接噪音，防 board 无界膨胀；失败教训在 run 日志与任务记忆）。
        //   内容优先级：任务记忆「→ 结论(AGENT)：」段 > run 最终回复 > 收口 detail；
        //   消费规则：下游注入取 dispatch generation 最新的那张（D9）。
        if (info.ok) {
            try {
            //   失败收口不产交接（设计选择：防看板被失败任务淹没；失败教训在 run 日志与任务记忆）
            const memRow = (c.ref_kind === "memory" && c.ref_id
                ? db.prepare(`SELECT id, content FROM memories WHERE id=?`).get(c.ref_id)
                : undefined) ??
                db.prepare(`SELECT m.id id, m.content content FROM card_memory cm JOIN memories m ON m.id=cm.memory_id WHERE cm.card_id=? AND cm.relation='dispatch' LIMIT 1`).get(cardId);
            // 核心结论：任务记忆「→ 结论(AGENT)：」段 > run 最终回复 > 收口 detail
            let core = "";
            if (memRow?.content) {
                const idx = String(memRow.content).lastIndexOf("→ 结论(AGENT)：");
                if (idx >= 0)
                    core = String(memRow.content).slice(idx + "→ 结论(AGENT)：".length).trim().slice(0, 2000);
            }
            if (!core)
                core = String(info.answer ?? "").trim().slice(0, 2400);
            if (!core)
                core = detail;
            // ★ P4 详版交接：结构化分节，下游开局即有完整上下文（总量上限 4000）
            const parts = [`【结论】${core}`];
            if (info.files?.length)
                parts.push(`【改动文件】\n${info.files.map((f) => `- ${f}`).join("\n")}`);
            const dur = Number(info.durationMs) > 0 ? ` · 耗时 ${Math.round(Number(info.durationMs) / 1000)}s` : "";
            parts.push(`【执行信息】run ${info.runId ?? "无"}${info.dispatchId ? ` · 工作证 #${info.dispatchId}` : ""}${dur}${info.channel ? ` · ${info.channel} 通道` : ""}`);
            if (info.logFile)
                parts.push(`【完整日志】${info.logFile}`);
            const body = parts.join("\n").slice(0, 4000);
            if (body) {
                const hIns = db.prepare(`INSERT INTO cards(board,kind,title,body,status,meta) VALUES ('default','handoff',?,?,'done',?)`)
                    .run(`交接文档 · ${String(c.title ?? "").slice(0, 80)}`.slice(0, 120), body,
                        JSON.stringify({ from_card: cardId, run_id: info.runId ?? null, dispatch_id: info.dispatchId ?? null, outcome: info.ok ? "succeeded" : "failed" }));
                db.prepare(`INSERT OR IGNORE INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,kind) VALUES (NULL,'card',?,'card',?,'handoff')`)
                    .run(cardId, Number(hIns.lastInsertRowid));
                writeCardEvent(Number(hIns.lastInsertRowid), info.actor || "dispatch-agent", "create", null, "done", `交接文档生成（run ${info.runId ?? "无"}）`);
            }
            }
            catch (e) { console.error("[cards] 交接文档生成失败（容忍：不反噬收口）", e); }
        }
        return { ok: true, statusChanged, settled };
    }
    ctx.finalizeCardDispatch = finalizeCardDispatch;
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
        txBegin(); // ★ 修 #9：事务内事件入队，COMMIT 后统一推 SSE
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
                    // ★ 修 #14：原直插 card_events 绕过 SSE —— 统一走 writeCardEvent（事务内自动入队）
                    writeCardEvent(Number(ins.lastInsertRowid), "dispatcher", "apply_plan", null, "triage", `计划 ${planId} 建卡`);
                    created++;
                    continue;
                }
                if (covered.includes(exist.status)) {
                    db.prepare(`UPDATE cards SET title=?, body=?, priority=?, updated_at=? WHERE id=?`).run(title, body, priority, now, exist.id);
                    writeCardEvent(exist.id, "dispatcher", "apply_plan", exist.status, exist.status, "计划更新原位覆盖");
                    overwritten++;
                }
                else {
                    // 进行中/已完成：不覆盖，评论 + stale_plan
                    db.prepare(`UPDATE cards SET meta=?, updated_at=? WHERE id=?`).run(JSON.stringify({ ...JSON.parse(rows.find((r) => r.id === exist.id)?.meta ?? "{}"), plan_id: planId, task_id: tid, stale_plan: true }), now, exist.id);
                    writeCardEvent(exist.id, "dispatcher", "plan_changed", exist.status, exist.status, "计划已变更，卡片保留当前状态");
                    db.prepare(`INSERT INTO card_comments(card_id, author, body, created_at) VALUES (?,'dispatcher','计划已变更（同源计划重应用），当前状态保留；如需执行新计划请重置状态。',?)`).run(exist.id, now);
                    staleMarked++;
                }
            }
            txCommit();
        }
        catch (e) {
            txRollback();
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
                // ★ 修 #6（2026-09-19）：原 meta LIKE '%"from_prospective":5%' 是子串匹配，
                //   `"from_prospective":55` 也命中 → #55 存在则 #5 永远建不出卡。改 json_extract 精确比对；
                //   json_valid 守卫防历史脏 meta 让 json_extract 抛 malformed JSON。
                const dup = db
                    .prepare(`SELECT id FROM cards WHERE kind='task'
                   AND json_extract(CASE WHEN json_valid(meta) THEN meta END, '$.from_prospective') = ? LIMIT 1`)
                    .get(r.id);
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
        for (const c of list) {
            // ★ 修 #16（2026-09-19）：非法/历史状态卡不再静默丢出桶（原 total 与 buckets 求和可能不一致）
            //   —— 未知状态原样保留为动态键，total 恒等于各桶长度之和。
            (buckets[c.status] ??= []).push(c);
        }
        return { total: list.length, buckets, lanes: [...new Set(list.map((c) => c.lane).filter(Boolean))] };
    });
    /** ★ 实时看板 SSE：卡片任何变更（经 writeCardEvent 中心点）即时推给前端；25s 心跳防断连。
     *  鉴权走全局 onRequest hook（同源 EventSource 自动带 memoryos_token cookie，与 /api/agent/runs/:id/stream 同体例）。
     *  注：静态路径 /api/cards/stream 优先于 /api/cards/:id 参数匹配（find-my-way 静态优先，同 /api/cards/archive）。 */
    app.get("/api/cards/stream", (req, reply) => {
        reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "connection": "keep-alive",
        });
        const send = (s) => { try { reply.raw.write(s); } catch { /* 连接已断 */ } };
        send(": cards stream\n\n");
        const ping = setInterval(() => send(": ping\n\n"), 25000);
        cardSubs.add(send);
        ensureEvtPoller(); // 有订阅者才跑跨进程事件补流
        req.raw.on("close", () => {
            clearInterval(ping);
            cardSubs.delete(send);
            if (!cardSubs.size)
                stopEvtPoller();
        });
    });
    app.post("/api/cards", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardCreate");
        const b = req.body ?? {};
        const title = String(b.title ?? "").trim();
        if (!title)
            return reply.code(400).send({ ok: false, error: "卡片标题不能为空" });
        // ★ 节点画布（D11 先建卡后选型）：缺省改为中性文档卡；kind 必须在类型注册表内（含自定义类型）
        const kind = String(b.kind ?? "doc").trim() || "doc";
        if (!db.prepare(`SELECT 1 x FROM card_types WHERE type_key=?`).get(kind))
            return reply.code(400).send({ ok: false, error: `未知卡片类型：${kind}` });
        const status = CARD_STATES.includes(String(b.status ?? "")) ? String(b.status) : "triage";
        const ins = db
            .prepare(`INSERT INTO cards(board,kind,title,body,status,assignee,priority,meta)
           VALUES (?,?,?,?,?,?,?,?)`)
            .run(String(b.board ?? "default").trim() || "default", kind, title, String(b.body ?? "").trim() || null, status, String(b.assignee ?? "").trim() || null, Math.max(0, Math.floor(Number(b.priority ?? 0) || 0)), b.meta ? JSON.stringify(b.meta) : null);
        const id = Number(ins.lastInsertRowid);
        if (status === "running") {
            // ★ 2026-09-19（弊端 M2）：手工创建的 running 卡默认发放租约——否则租约回收器看不见它（僵尸泳道）
            const lock = randomBytes(12).toString("hex");
            db.prepare(`UPDATE cards SET claim_lock=?, lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',' +10 minutes'), heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(lock, id);
        }
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
        // ★ 2026-09-19（实操复盘查漏）：删卡先查绑定任务 —— ref_kind/dispatch 关联的任务记忆若仍在
        //   开放态（pending/in_progress/blocked），删卡会留「孤儿任务」继续出现在 task_next 可做集。
        //   非开放态（done/cancelled/merged/archived）或纯笔记/辅助卡不受影响。
        const boundIds = new Set();
        if (c.ref_kind === "memory" && c.ref_id)
            boundIds.add(Number(c.ref_id));
        for (const cm of db.prepare(`SELECT memory_id FROM card_memory WHERE card_id=? AND relation='dispatch'`).all(c.id))
            boundIds.add(Number(cm.memory_id));
        for (const mid of boundIds) {
            // 判定以 [task] 头文本为准（type 字段可能被 dashboard 写入路径静默降级，头才是事实源）
            const m = db.prepare(`SELECT id, content FROM memories WHERE id=? AND status IN ('active','trial')`).get(mid);
            if (!m)
                continue;
            // ★ 修 #11（2026-09-19）：原正则要求头部严格 [task][assignee:..][status:..] 三段序 —— 头部段序
            //   不同/带 deps 段/legacy 缺段就解析失败 → 误判非开放任务照删出孤儿。改 split 松解析（同 reconcile 口径）。
            const content = String(m.content ?? "");
            const st = content.startsWith("[task]") ? (content.split("[status:")[1]?.split("]")[0]?.trim() ?? "") : "";
            if (["pending", "in_progress", "blocked"].includes(st))
                return reply.code(409).send({ ok: false, error: `卡片 #${c.id} 绑定着未闭环任务 #${mid}（status=${st}）：请先 task_release / task_verify / task_supersede 或在记忆侧归档该任务，再删卡；直接删除会产生孤儿任务。` });
        }
        db.prepare(`DELETE FROM card_memory WHERE card_id=?`).run(c.id);
        db.prepare(`DELETE FROM links WHERE (src_kind='card' AND src_id=?) OR (dst_kind='card' AND dst_id=?)`).run(c.id, c.id);
        db.prepare(`DELETE FROM card_edges WHERE source_id=? OR target_id=?`).run(c.id, c.id); // ★ 节点画布：防悬挂边（源/目标指向已删卡）
        db.prepare(`DELETE FROM card_events WHERE card_id=?`).run(c.id);
        db.prepare(`DELETE FROM card_comments WHERE card_id=?`).run(c.id);
        db.prepare(`DELETE FROM cards WHERE id=?`).run(c.id);
        return { ok: true, removed: c.id };
    });
    // —— CAS 认领（H3 ①）——
    app.post("/api/cards/:id/claim", async (req, reply) => {
        const id = Number(req.params.id);
        const actor = asOf(req);
        const credErr = actorCredError(actor, req.query.credential); // ★ ①：kebab agent 名需有效写凭据（硬模式 403）
        if (credErr)
            return reply.code(403).send({ ok: false, error: credErr });
        const lock = randomBytes(12).toString("hex");
        const info = db
            .prepare(`UPDATE cards SET status='running', assignee=?, claim_lock=?,
           lease_expires_at=datetime('now','+10 minutes'), heartbeat_at=datetime('now'), updated_at=datetime('now')
         WHERE id=? AND status='ready' AND claim_lock IS NULL`)
            .run(actor, lock, id);
        if (Number(info.changes) === 0)
            return reply.code(409).send({ ok: false, error: "认领失败：卡片不在 ready 或已被认领" });
        writeCardEvent(id, actor, "claim", "ready", "running", `CAS 认领（lock=${lock.slice(0, 8)}…）`);
        syncCardToTask(id, { assignee: actor }); // ★ 认领 → 关联 task 回写 in_progress + assignee（修 #10）
        return { ok: true, id, assignee: actor, lock };
    });
    // —— ★ A1 一键派发（对标 orca「one authoritative Task attempt」）——
    /* 一条龙：状态准入 → CAS 认领（claim_lock 即 dispatch_key 投影）→ 建工作证 → 起 agent run。
     * 与 /claim 的分工：/claim 是人手动认领；本端点是「把活推给 agent」——多两步（建 dispatch + 起 run），
     * 且起 run 失败整笔回滚（卡回 ready + 工作证释放），不留半开状态。
     * run 终态由 knowledge 域回调 ctx.finalizeCardDispatch 收口（review/failed + settleDispatch）。 */
    app.post("/api/cards/:id/dispatch-agent", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "cardDispatchAgent");
        const id = Number(req.params.id);
        const b = req.body ?? {};
        const agent = String(b.agent ?? "").trim() || "dispatch-agent";
        const credErr = actorCredError(agent, b.credential ?? req.query.credential); // kebab 名硬模式需有效写凭据
        if (credErr)
            return reply.code(403).send({ ok: false, error: credErr });
        if (typeof ctx.startAgentRun !== "function")
            return reply.code(503).send({ ok: false, error: "run 域未就绪（startAgentRun 未注册）" });
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        let from = c.status;
        // todo 且依赖已满足 → 先提升 ready（与 /api/dispatch 调度器同口径），派发少一步手动流转
        if (from === "todo" && cardDependsDone(id)) {
            db.prepare(`UPDATE cards SET status='ready', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='todo'`).run(id);
            writeCardEvent(id, agent, "promote", "todo", "ready", "派发前置：依赖已满足");
            from = "ready";
        }
        if (from !== "ready")
            return reply.code(409).send({ ok: false, error: `卡片状态「${from}」不可派发（需可认领 ready）` });
        if (!cardDependsDone(id))
            return reply.code(409).send({ ok: false, error: "依赖卡片未完成，暂不可派发" });
        // 关联任务记忆（与 syncCardToTask 同口径：ref 优先，其次 card_memory dispatch 关联）
        const memRow = (c.ref_kind === "memory" && c.ref_id
            ? db.prepare(`SELECT id FROM memories WHERE id=?`).get(c.ref_id)
            : undefined) ??
            db.prepare(`SELECT memory_id id FROM card_memory WHERE card_id=? AND relation='dispatch' LIMIT 1`).get(id);
        const taskId = memRow ? Number(memRow.id) : null;
        const lock = randomBytes(12).toString("hex");
        let dsp = null;
        let dispatchEdgeId = null; // 节点画布：本次派发写下的边（连线派发时返回给前端）
        const agentCardId = Number(b.agent_card_id) || 0; // 节点画布：目标智能体卡（0=未指定；tx 内校验存在性）
        txBegin(); // 认领 + 建工作证一笔事务：任一步失败整笔回滚（事件先入队、COMMIT 后推）
        try {
            const info = db
                .prepare(`UPDATE cards SET status='running', assignee=?, claim_lock=?,
               lease_expires_at=datetime('now','+10 minutes'), heartbeat_at=datetime('now'), updated_at=datetime('now')
             WHERE id=? AND status='ready' AND claim_lock IS NULL`)
                .run(agent, lock, id);
            if (Number(info.changes) === 0)
                throw new Error("认领竞争：卡片已不在 ready 或已被认领");
            if (taskId) {
                dsp = createDispatch(db, { key: lock, memoryId: taskId, agent, leaseMinutes: 10 }); // 同任务旧尝试 → 自动 supersede 换代
                // ★ 补链（2026-10-04 多 agent 协作联调）：ref 关联卡（from-memory 建的是 'reference'、import-legacy 无行）
                //   缺 'dispatch' 关系 → run 内 task_done 的 syncTaskToCard 定位不到卡 → 卡留 running → 收口把
                //   done 头经 E-0(review→in_progress) 投影回退。task_assign 建卡本就双写，此处幂等补齐同一口径。
                db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'dispatch')`).run(id, taskId);
            }
            // ★ 节点画布（D3/D11 连线派发）：任务卡→智能体卡派发边锚定本次工作证；同对旧 active 边翻 superseded。
            //   与认领/工作证同一事务：目标卡校验失败整笔回滚，不留半截边。
            if (agentCardId) {
                if (!db.prepare(`SELECT id FROM cards WHERE id=? AND kind='agent'`).get(agentCardId))
                    throw new Error("目标智能体卡不存在（须为智能体类型投影卡）");
                db.prepare(`UPDATE card_edges SET status='superseded' WHERE source_id=? AND target_id=? AND kind='dispatch' AND status='active'`).run(id, agentCardId);
                const eIns = db.prepare(`INSERT INTO card_edges(source_id,target_id,kind,dispatch_id,status) VALUES (?,?,'dispatch',?,'active')`)
                    .run(id, agentCardId, dsp ? dsp.id : null);
                dispatchEdgeId = Number(eIns.lastInsertRowid);
            }
            writeCardEvent(id, agent, "dispatch", "ready", "running", dsp
                ? `一键派发（工作证 gen=${dsp.generation}${dsp.superseded ? `，取代 #${dsp.superseded}` : ""} · run 启动中）`
                : "一键派发（无关联任务记忆，仅卡级认领 · run 启动中）");
            txCommit();
        }
        catch (e) {
            try { txRollback(); }
            catch (e2) { console.error("[cards] 派发事务回滚异常（卡片可能滞留 running，需调度器/人工核对）", e2); }
            console.error(`[cards] #${id} 派发事务失败（409 回显调用方）`, e);
            return reply.code(409).send({ ok: false, error: String(e instanceof Error ? e.message : e) });
        }
        syncCardToTask(id, { assignee: agent }); // 头回写 running + assignee（与 /claim 同口径）
        // ★ P4 前情注入：本卡的 active 注入边 → 上游交接文档进 run 提示词头部（下游开局即有上下文）
        const handoffs = db.prepare(`SELECT h.title title, h.body body FROM card_edges e JOIN cards h ON h.id = e.source_id
            WHERE e.target_id=? AND e.kind='inject' AND e.status='active' ORDER BY e.id`).all(id);
        const handoffBlock = handoffs.length
            ? (`【前情提要（来自上游交接文档，全文按需检索）】\n` + handoffs.map((h) => `· ${h.title}：\n${String(h.body ?? "").slice(0, 1500)}`).join("\n---\n")).slice(0, 3000) // ★ 详版注入：单条 1500/总量 3000（有界，防撞 run 提示词上限）
            : "";
        // 起 run：提示词内嵌卡片正文（agent 无卡片读工具），并给足收口指令
        // ★ P2/P3 通道分流：智能体卡 channel='cli' → CLI 直控执行器；'cdp' → CDP 驾驶执行器；queue → 内部 agent run
        // （计算必须先于 message 构建——交接要求行按通道分支引用 channel）
        const agentProfile = agentCardId ? profileOfCard(db.prepare(`SELECT * FROM cards WHERE id=?`).get(agentCardId)) : null;
        const channel = agentProfile ? String(agentProfile.channel) : "queue";
        const message = [
            `【一键派发】你被指派处理 MemoryOS 看板卡片 #${id}（认领人 ${agent}）。`,
            taskId
                ? `关联任务 #${taskId}，工作证 dispatch_key=${lock}：干完必须调用 task_done(memory_id=${taskId}, conclusion="<≤200字结论>", dispatch_key="${lock}")。`
                : `本卡未关联任务记忆：不要调用 task_done，结论直接写在最终回复里。`,
            ...(handoffBlock ? [handoffBlock] : []),
            `标题：${String(c.title ?? "").slice(0, 120)}`,
            `正文：${String(c.body ?? "").trim().slice(0, 2500) || "（空卡：先自行调研再给可执行结论）"}`,
            `要求：① 先查上下文（memory_search/memory_read，或 task_next 看全局任务）再动手；② 结论须可验收，不确定处显式标注不确定性；③ 中途不要改卡片状态（由系统按 run 终态自动收口）。`,
            // ★ CLI 通道收口靠分隔符协议（D7）：提示词里明确详版交接的分节要求
            ...(channel === "cli" ? [`交接要求：结束前必须输出 <<<HANDOFF>>> … <</HANDOFF>>> 详版交接段，分节写：【结论】【改动文件】【踩坑与规避】【遗留与建议】，尽量具体，写全给下一个人看。`] : []),
        ].join("\n");
        let started;
        try {
            if (channel === "cli") {
                if (typeof ctx.startCliRun !== "function")
                    throw new Error("CLI 直控执行器未就绪"); // ★ 抛出走统一回滚分支（503 早退会留下已认领的 running 卡+工作证）
                started = await ctx.startCliRun({
                    cardId: id, agentCardId, profile: agentProfile, dispatchId: dsp ? dsp.id : null, dispatchKey: lock, taskId, message,
                });
            }
            else if (channel === "cdp") {
                if (typeof ctx.startCdpRun !== "function")
                    throw new Error("CDP 驾驶执行器未就绪"); // 同上
                started = await ctx.startCdpRun({
                    cardId: id, agentCardId, profile: agentProfile, dispatchId: dsp ? dsp.id : null, dispatchKey: lock, taskId, message,
                });
            }
            else {
                started = await ctx.startAgentRun({
                    message, allowWrites: true, title: `🚀 ${String(c.title ?? "卡片派发").slice(0, 50)}`,
                    taskHint: taskId ?? undefined,
                    cardDispatch: { cardId: id, dispatchId: dsp ? dsp.id : null, dispatchKey: lock, taskId, actor: agent },
                });
            }
        }
        catch (e) {
            // 起 run 失败 → 回滚认领 + 释放工作证（不留半开状态，卡片回到可派发）
            console.error(`[cards] #${id} 起 run 失败（认领将回滚至 ready）`, e);
            txBegin();
            try {
                db.prepare(`UPDATE cards SET status='ready', assignee=NULL, claim_lock=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='running' AND claim_lock=?`).run(id, lock);
                if (dsp)
                    releaseDispatch(db, dsp.id, `起 run 失败：${e instanceof Error ? e.message : e}`);
                if (dispatchEdgeId)
                    db.prepare(`UPDATE card_edges SET status='cancelled' WHERE id=? AND status='active'`).run(dispatchEdgeId);
                writeCardEvent(id, agent, "dispatch_failed", "running", "ready", String(e instanceof Error ? e.message : e).slice(0, 160));
                txCommit();
            }
            catch (e2) {
                try { txRollback(); }
                catch (e3) { console.error("[cards] 起 run 失败的回滚自身异常（半开状态风险：卡片可能滞留 running，需人工/调度器核对）", e3); }
            }
            syncCardToTask(id, { assignee: "" }); // 头随卡回到 ready 并清 assignee
            return reply.code(503).send({ ok: false, error: `起 run 失败（认领已回滚）：${e instanceof Error ? e.message : e}` });
        }
        return reply.code(202).send({
            ok: true, id, runId: started.runId, status: started.status, cap: started.cap ?? null,
            queueAhead: started.queueAhead ?? null, agent, assignee: agent, taskId,
            channel, executor: channel === "cli", queued: !!started.queued,
            dispatch: dsp ? { id: dsp.id, key: lock, generation: dsp.generation, superseded: dsp.superseded ?? null } : null,
            edgeId: dispatchEdgeId, // 节点画布：本次连线派发写下的边
        });
    });
    // —— 状态流转（H3 ②：WHERE status=expected_from 前置校验 + 白名单）——
    app.post("/api/cards/:id/status", async (req, reply) => {
        const id = Number(req.params.id);
        const b = req.body ?? {};
        const to = String(b.status ?? "").trim();
        const expectedFrom = String(b.expected_from ?? "").trim() || undefined;
        const actor = String(b.as ?? "").trim() || asOf(req);
        const credErr = actorCredError(actor, b.credential ?? req.query.credential); // ★ ①：kebab agent 名需有效写凭据（硬模式 403）
        if (credErr)
            return reply.code(403).send({ ok: false, error: credErr });
        if (!CARD_STATES.includes(to))
            return reply.code(400).send({ ok: false, error: `非法状态 ${to}` });
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        if (!CARD_TRANSITIONS[c.status]?.includes(to)) {
            return reply.code(409).send({ ok: false, error: `非法迁移 ${c.status} → ${to}` });
        }
        // ★ 修 #7（2026-09-19）：M2 验收门 —— 卡带验收标准（meta.acceptance 非空）时不允许经 /status
        //   直达 done，必须走 /api/cards/:id/accept 显式验收。原 /accept 注释声明了该契约但 /status
        //   不检查，agent 可一步绕过验收。
        if (to === "done") {
            const acc = readCardMeta(c).acceptance;
            const hasAcc = acc != null && !(Array.isArray(acc) && acc.length === 0);
            if (hasAcc)
                return reply.code(409).send({ ok: false, error: "卡带验收标准（meta.acceptance），须经 /api/cards/:id/accept 验收后才能 done" });
        }
        if (c.status === "running" && c.assignee && c.assignee !== "unassigned" && !actor.startsWith("human") && actor !== c.assignee) {
            return reply.code(403).send({ ok: false, error: "非认领者无权流转" });
        }
        // ★ 修 #8（2026-09-19）：迁移白名单/权限检查都基于先读的 c.status，原 UPDATE 仅在显式传
        //   expectedFrom 时才带状态守卫 → 读改之间被并发改写时，校验过的迁移会被无条件覆盖（TOCTOU）。
        //   现恒以「读到的状态」（或显式 expectedFrom）作 WHERE 守卫，白名单校验与落笔原子化。
        const guardFrom = expectedFrom ?? c.status;
        const info = db
            .prepare(`UPDATE cards SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status=?`)
            .run(to, id, guardFrom);
        if (Number(info.changes) === 0) {
            return reply.code(409).send({ ok: false, error: `状态前置不符（期望 ${guardFrom}），可能已被其他操作改写` });
        }
        writeCardEvent(id, actor, "status_changed", c.status, to);
        if (to === "done")
            // ★ 2026-09-19（弊端 L4）：三清对齐 MCP 侧（锁 + 租约窗 + 贴条）——原仅清 claim_lock 残留过期租约
            db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL WHERE id=?`).run(id);
        if (to === "failed")
            db.prepare(`UPDATE cards SET failure_count=failure_count+1 WHERE id=?`).run(id);
        syncCardToTask(id); // ★ 2026-09-15：卡片状态回写关联 task 记忆状态头
        return { ok: true, id, from: c.status, to };
    });
    // —— M2 验收：review → done（meta.acceptance 存在时必须走此端点）——
    app.post("/api/cards/:id/accept", async (req, reply) => {
        const id = Number(req.params.id);
        const actor = String(req.body?.as ?? "").trim() || "human:dashboard";
        const credErr = actorCredError(actor, req.body?.credential ?? req.query?.credential); // ★ ①：kebab agent 名需有效写凭据（硬模式 403）
        if (credErr)
            return reply.code(403).send({ ok: false, error: credErr });
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
            // ★ 修 #1（2026-09-19）：原 dir 三元判的是 finalKind（恒为 'depends'）→ blocks 也存成
            //   「id 依赖 dst」，方向整个反了。正确语义：depends = id 依赖 dst（src=id）；blocks =
            //   id 阻塞 dst ⇔ dst 依赖 id（src=dst）。成环检测跟着方向走：加边 X→Y 前查 Y 是否已可达 X。
            const forward = kind !== "blocks"; // true=存 src=id → dst
            const cycle = forward ? dependsPathExists(dst, id) : dependsPathExists(id, dst);
            if (cycle)
                return reply.code(409).send({ ok: false, error: kind === "blocks" ? "成环：本卡已（传递）依赖 dst，无法再阻塞它" : "成环：dst 已依赖本卡" });
            const dir = forward ? [id, dst] : [dst, id];
            db.prepare(`INSERT OR IGNORE INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,kind)
           VALUES (NULL,'card',?,'card',?,'depends')`).run(dir[0], dir[1]);
            writeCardEvent(id, "human:dashboard", "link", null, null, kind === "blocks" ? `blocks → #${dst}（存为 depends：#${dst} → #${id}）` : `depends → #${dst}`);
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
    // —— 心跳续租（R6-4：常规续窗不写 events）——
    app.post("/api/cards/:id/heartbeat", async (req, reply) => {
        const id = Number(req.params.id);
        const actor = String(req.body?.as ?? "").trim();
        const credErr = actorCredError(actor, req.body?.credential ?? req.query?.credential); // ★ ①：kebab agent 名需有效写凭据（硬模式 403；人类缺省流量不变）
        if (credErr)
            return reply.code(403).send({ ok: false, error: credErr });
        // ★ 修 #2（2026-09-19）：续期同时撕 lease_notice_at（与 MCP task_heartbeat 同口径）。
        //   原来看板心跳只续窗不清贴条，导致漏一次心跳被贴条后，活跃认领者的卡被误判。
        //   撕条是状态变更，写一条事件留痕（R6-4 的"心跳静默"口径仅指常规续窗，不含贴条撕除）。
        // ★ 批次 B1（2026-10-03）：心跳=**正面存活证明** → 同时撤 lease_stale_at 裁决标记（reaper 已改
        //   「只标不回收」，撤销标记即回到正常持有态；卡恢复 running 全权）。
        const had = db.prepare(`SELECT lease_notice_at FROM cards WHERE id=? AND assignee=?`).get(id, actor);
                // ★ 2026-09-19（弊端 M3）：心跳续租仅限 running 态卡——done/blocked 卡不再被静默续租
        const info = db
            .prepare(`UPDATE cards SET heartbeat_at=datetime('now'), lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'), lease_notice_at=NULL, lease_stale_at=NULL WHERE id=? AND assignee=? AND status='running'`)
            .run(id, actor);
        if (Number(info.changes) === 0)
            return reply.code(409).send({ ok: false, error: "心跳失败：非认领者 / 无此卡 / 卡片不在 running 态" });
        if (had?.lease_notice_at)
            writeCardEvent(id, actor, "lease_notice_cleared", "running", "running", "看板心跳续期，撕除租约过期贴条");
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
            const r = ins.run(title, t.id, JSON.stringify({ legacy: true }), t.created_at);
            writeCardEvent(Number(r.lastInsertRowid), "human:dashboard", "create", null, "todo", `历史任务导入 #${t.id}`); // ★ 修 #14：导入卡此前零事件
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
                // ★ 修 #13：先查缓存，只重嵌缺失/已变更的卡（顺序与 tasks 对齐）
                const keyList = tasks.map((n) => `${n.id}:${cardText.get(n.id) ?? ""}`);
                const cardVecs = new Array(tasks.length);
                const needIdx = [];
                keyList.forEach((k, i) => {
                    const hit = cardVecCache.get(k);
                    if (hit)
                        cardVecs[i] = hit;
                    else
                        needIdx.push(i);
                });
                if (needIdx.length) {
                    const fresh = await embedder.embedTexts(needIdx.map((i) => cardText.get(tasks[i].id) ?? ""));
                    needIdx.forEach((i, j) => {
                        cardVecs[i] = fresh[j];
                        if (cardVecCache.size > 2000)
                            cardVecCache.clear();
                        cardVecCache.set(keyList[i], fresh[j]);
                    });
                }
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
        //   active（todo/triage/ready/running/blocked/failed=未完成且需要关注）/ done / terminal（archived/cancelled=已终结）
        //   aux 子卡无任务状态 → bucket=null。前端未完成计数只取 bucket==='active'，终结态不再混入。
        //   ★ 修 #15（2026-09-19）：failed 移出终结桶 —— 迁移白名单允许 failed→todo/blocked 恢复，
        //   归 terminal 会让未完成计数漏掉待恢复的失败卡。
        const TERMINAL = new Set(["archived", "cancelled"]);
        const nodesWithBucket = nodes.map((n) => {
            const kind = String(n.kind ?? "");
            const bucket = kind.startsWith("aux_") || kind === "aux" ? null
                : n.status === "done" ? "done"
                    : TERMINAL.has(String(n.status)) ? "terminal"
                        : "active";
            return { ...n, bucket };
        });
        // ★ 节点画布：边持久化实体（card_edges）随图返回；智能体卡附载体在位标记（探测失败降级不阻断出图）
        let edges = [];
        try {
            edges = db.prepare(`SELECT id, source_id, target_id, kind, dispatch_id, status FROM card_edges ORDER BY id`).all()
                .map((e) => ({ ...e, source_id: serializable(e.source_id), target_id: serializable(e.target_id) }));
        }
        catch { /* 旧库未迁移时降级为无边 */ }
        try {
            const scanKeys = scanKeysSafe();
            if (scanKeys)
                for (const n of nodesWithBucket) {
                    if (n.kind !== "agent")
                        continue;
                    const pid = Number(n.meta?.profile_id) || 0;
                    const prof = pid ? db.prepare(`SELECT agent_key FROM agent_profiles WHERE id=?`).get(pid) : null;
                    n.profileMissing = !prof || !scanKeys.has(String(prof.agent_key ?? ""));
                }
        }
        catch { /* 载体探测失败不标记，宁报在线不误报缺失 */ }
        return {
            ok: true,
            auto: String(req.query.auto ?? "0") !== "0",
            nodes: nodesWithBucket.map((n) => ({ ...n, id: serializable(n.id) })),
            links: links.map((l) => ({ ...l, src_id: serializable(l.src_id), dst_id: serializable(l.dst_id) })),
            edges,
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
        txBegin(); // ★ 修 #9：事务内事件入队
        try {
            for (const c of done) {
                const info = upd.run(c.id);
                if (Number(info.changes)) {
                    writeCardEvent(c.id, "human:dashboard", "archive", "done", "archived", `手工归档（阈值 ${days} 天）`);
                    syncCardToTask(c.id); // ★ 修 #12（2026-09-19）：归档同步回写任务头 done→archived（CARD_TO_TASK.archived 此前无人走到）
                    archived++;
                }
            }
            txCommit();
        }
        catch (e) {
            txRollback();
            throw e;
        }
        return { ok: true, run: { archived, cutoffDays: days }, mode: String(readConfig(db, "cards.archive_mode", "auto")) };
    });
    /** ★ 2026-09-20：卡片主题解析（归档分组用，只读）。
     *  优先级：cards.topic 列 > meta.topic > 标题内 [topic:xxx] > '未分类'。
     *  注：cardRowOf 不返回 topic（避免改动 /api/cards 等既有响应体），故此处直接读原始行。 */
    function topicOfCardRow(r) {
        const t = String(r.topic ?? "").trim();
        if (t)
            return t;
        try {
            const m = r.meta ? JSON.parse(r.meta) : {};
            if (m && typeof m.topic === "string" && m.topic.trim())
                return m.topic.trim();
        }
        catch { /* meta 非 JSON：忽略，落到标题解析 */ }
        const mt = /\[topic:([^\]]+)\]/.exec(String(r.title || ""));
        return mt ? mt[1].trim() : "未分类";
    }
    /** ★ 2026-09-20：归档中心 —— 归档卡片按主题分组（只读）。
     *  分组按卡片数降序、同数量按主题名（zh）排序；组内按归档时间倒序；first/last 给组时间范围。 */
    app.get("/api/cards/archive/grouped", async (req) => {
        const by = String(req.query.by ?? "topic").trim() || "topic";
        const rows = db
            .prepare(`SELECT id, kind, title, topic, meta, created_at, updated_at FROM cards WHERE status='archived' ORDER BY COALESCE(updated_at, created_at) DESC`)
            .all();
        const map = new Map();
        for (const r of rows) {
            const topic = topicOfCardRow(r);
            if (!map.has(topic))
                map.set(topic, []);
            map.get(topic).push({ id: Number(r.id), title: r.title, kind: r.kind, topic, at: r.updated_at || r.created_at });
        }
        const groups = [...map.entries()]
            .map(([topic, cards]) => ({
            topic,
            count: cards.length,
            first: cards[cards.length - 1]?.at ?? null,
            last: cards[0]?.at ?? null,
            cards,
        }))
            .sort((a, b) => b.count - a.count || String(a.topic).localeCompare(String(b.topic), "zh"));
        return { ok: true, by, total: rows.length, groups };
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
        // ★ 修 #4（2026-09-19）三处：
        //   ① 映射改用权威对照表 CARD_TO_TASK —— 原内联 TASK_MAP 是一致性③漏网的第 5 份副本；
        //     表内仅 triage/todo 无映射，两者的任务态即 pending。
        //   ② 原裸 `UPDATE memories SET content=?, status='active'` 不递增 version、不同步 FTS/2-gram
        //     （一致性②同款坑，MCP 侧 CAS 感知不到本写），改走 updateMemory 正门 CAS（2 次重试，
        //     持续漂移让位交对账，同 syncCardToTask 口径）。
        //   ③ 无条件置 status='active' 会复活已 cancelled/merged 的任务记忆 —— 改为非 active/trial
        //     直接 409 拒推，不再触碰记忆 status 列。
        const toStatus = CARD_TO_TASK[c.status] ?? "pending";
        const toAssignee = c.assignee ?? "";
        for (let attempt = 0; attempt < 2; attempt++) {
            const m = db.prepare(`SELECT id, content, version, status FROM memories WHERE id=?`).get(memoryId);
            if (!m)
                return reply.code(404).send({ ok: false, error: "绑定任务记忆不存在" });
            if (!["active", "trial"].includes(String(m.status)))
                return reply.code(409).send({ ok: false, error: `任务记忆 #${memoryId} 已终结（status=${m.status}），不允许推送` });
            // 解析现有 content 头
            const am = m.content.match(/\[assignee:([^\]]*)\]/);
            const sm = m.content.match(/\[status:([^\]]*)\]/);
            const curStatus = sm ? sm[1] : null;
            const curAssignee = am ? am[1] : "";
            // 归一旧头状态方便比对
            const normFrom = curStatus ? (TASK_NORMALIZE[curStatus] ?? curStatus) : null;
            const noop = normFrom === toStatus && curAssignee === toAssignee;
            if (noop)
                return { ok: true, noop, from: curStatus ?? null, to: toStatus, memory_id: memoryId };
            const head = `[task][assignee:${toAssignee}][status:${toStatus}]`;
            // ★（2026-09-14 实证）一次replace误二次replace导致头重复追加：
            //   若已有完整头 → 原位替换；否则整体前置新头（保留原正文/依赖段）。
            let newContent;
            if (/^\[task\]\[assignee:[^\]]*\]\[status:[^\]]*\]/.test(m.content)) {
                newContent = m.content.replace(/^\[task\]\[assignee:[^\]]*\]\[status:[^\]]*\]/, head);
            }
            else {
                newContent = `${head} ${m.content}`;
            }
            const ok = updateMemory(db, memoryId, { content: newContent, expectedVersion: m.version }); // ★ 正门 CAS
            if (ok) {
                writeCardEvent(id, "human:dashboard", "push_to_task", null, null, `卡 #${id} → 任务头 ${normFrom ?? "?"} → ${toStatus}`);
                return { ok: true, noop: false, from: curStatus ?? null, to: toStatus, memory_id: memoryId };
            }
            // 版本漂移：重读再试（第二次仍漂移 = MCP 侧正在改写 → 让位）
        }
        console.error(`[push-to-task] 卡片 #${id} → 任务 #${memoryId} 头回写让位：版本持续漂移（MCP 侧正在改写），交由对账对齐`);
        return reply.code(409).send({ ok: false, error: "任务头版本持续漂移（MCP 侧正在改写），已让位；请稍后重试或等对账对齐" });
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
        txBegin(); // ★ 修 #9：事务内事件入队
        try {
            // ① 租约贴条（⑦/H3 演进 → ⑧ 批次 B1 只标不回收）：过期不再自动抢回 —— 打 lease_notice_at 标记、卡保持
            //    running（与任务头一致零震荡）；认领者 heartbeat 续期/收口即撕条。超期裁决由 reapExpiredLeases
            //    阶段二统一处理（⑧：只标 lease_stale_at + dispatch 置 stale，不回收、不放回池子）。
            //    replace(' ','T')：lease_expires_at 存量含 SQLite 空格格式，与 JS ISO 裸比较「同日恒真」，先归一再比。
            const expired = db
                .prepare(`SELECT id, assignee FROM cards WHERE status='running' AND lease_expires_at IS NOT NULL AND replace(lease_expires_at,' ','T') < ? AND lease_notice_at IS NULL`)
                .all(now);
            for (const e of expired) {
                const upd = db.prepare(`UPDATE cards SET lease_notice_at=?, updated_at=? WHERE id=? AND status='running' AND lease_notice_at IS NULL`).run(now, now, e.id);
                if (Number(upd.changes) === 0)
                    continue;
                writeCardEvent(e.id, "dispatcher", "lease_expired", "running", "running", `租约过期（原 ${e.assignee ?? "?"}）——贴条待确认：heartbeat 续期 / 收口；超 24h 无人理转「待裁决」（⑧ 只标不回收）`);
                out.leased_back++;
            }
            // ② triage 超时（M1）：>24h 未动 → todo
            // ★ 2026-09-19（弊端 L5）：created_at 混 JS ISO（T/Z）与 SQLite 空格格式——裸比较同日条目判偏；
            //   归一为 T 格式后与 JS 侧截止时间比较（租约「同日恒真」同类修复）
            const staleCutoff = new Date(Date.now() - 86400000).toISOString();
            const stale = db
                .prepare(`SELECT id FROM cards WHERE status='triage' AND replace(created_at,' ','T') < ?`)
                .all(staleCutoff);
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
                    // ★ 修 #6：同 /api/prospective/due —— LIKE 子串误伤改 json_extract 精确比对
                    const dup = db.prepare(`SELECT id FROM cards WHERE json_extract(CASE WHEN json_valid(meta) THEN meta END, '$.from_prospective') = ? LIMIT 1`).get(r.id);
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
            txCommit();
        }
        catch (e) {
            txRollback();
            throw e;
        }
        return { ok: true, ...out };
    });

    // ═══════════ 节点画布（P0，2026-10-04）：类型注册表 / 改型 / 边 / 智能体档案 ═══════════
    // 设计依据：D4（Agent 卡 = cards.kind='agent' 投影卡 + meta.profile_id）、D11（先建卡后选型）、
    //           连线方向按 card_types 四端口行为档位判定；可回滚 = drop card_types/card_edges/agent_profiles 三张新表。
    const CARD_TYPE_FLAGS = ["can_dispatch_out", "can_dispatch_in", "can_inject_out", "can_inject_in"];
    const BUILTIN_TYPE_KEYS = new Set(["task", "agent", "handoff", "doc"]);
    const PROFILE_CHANNELS = ["cli", "cdp", "queue"]; // UIA 仅作 CDP 内部兜底，不设独立通道（D10）

    function typeRowOf(key) {
        return db.prepare(`SELECT * FROM card_types WHERE type_key=?`).get(String(key));
    }
    /** 智能体投影卡 → 档案行（meta.profile_id 反查） */
    function profileOfCard(c) {
        const pid = Number(readCardMeta(c).profile_id) || 0;
        return pid ? db.prepare(`SELECT * FROM agent_profiles WHERE id=?`).get(pid) : null;
    }
    function projectionCardOfProfile(profileId) {
        for (const r of db.prepare(`SELECT id, meta FROM cards WHERE kind='agent'`).all()) {
            try {
                const m = JSON.parse(r.meta ?? "{}");
                if (Number(m.profile_id) === Number(profileId))
                    return Number(r.id);
            }
            catch { /* meta 非法忽略 */ }
        }
        return null;
    }
    /** 载体在位探测（60s TTL 缓存）：scanAgents 的 CLI 版本探测走 spawnSync 很慢，
     *  graph 每请求都扫会拖慢画布刷新数秒；失败按 TTL 退避，防雪崩重试。返回 null=探测失败。 */
    let _scanCache = { keys: null, at: 0 };
    function scanKeysSafe() {
        const now = Date.now();
        if (_scanCache.keys && now - _scanCache.at < 60000)
            return _scanCache.keys;
        if (!_scanCache.keys && now - _scanCache.at < 60000)
            return null; // 上次探测失败未过期 → 继续按失败口径
        try {
            const res = scanAgents();
            _scanCache = { keys: new Set((res?.agents ?? []).map((a) => String(a.id ?? ""))), at: now };
        }
        catch {
            _scanCache = { keys: null, at: now };
        }
        return _scanCache.keys;
    }
    function validProfileChannel(v) {
        return PROFILE_CHANNELS.includes(String(v ?? "")) ? String(v) : "queue";
    }

    app.get("/api/card-types", async () => {
        return { ok: true, types: db.prepare(`SELECT * FROM card_types ORDER BY builtin DESC, type_key`).all() };
    });

    app.post("/api/card-types", async (req, reply) => {
        const b = req.body ?? {};
        const key = String(b.type_key ?? "").trim();
        if (!/^[a-z][a-z0-9_]{1,31}$/.test(key))
            return reply.code(400).send({ ok: false, error: "类型标识需为小写字母开头、2-32 位的小写字母/数字/下划线" });
        if (BUILTIN_TYPE_KEYS.has(key) || key.startsWith("aux"))
            return reply.code(409).send({ ok: false, error: "该标识为系统保留，不能用作自定义类型" });
        const label = String(b.label ?? "").trim();
        if (!label)
            return reply.code(400).send({ ok: false, error: "类型显示名不能为空" });
        if (typeRowOf(key))
            return reply.code(409).send({ ok: false, error: `类型已存在：${key}` });
        db.prepare(`INSERT INTO card_types(type_key,label,color,builtin,can_dispatch_out,can_dispatch_in,can_inject_out,can_inject_in,meta)
            VALUES (?,?,?,0,?,?,?,?,?)`)
            .run(key, label, String(b.color ?? "").trim() || null,
                ...CARD_TYPE_FLAGS.map((f) => (b[f] ? 1 : 0)), b.meta ? JSON.stringify(b.meta) : null);
        return { ok: true, type_key: key };
    });

    app.put("/api/card-types/:key", async (req, reply) => {
        const row = typeRowOf(String(req.params.key));
        if (!row)
            return reply.code(404).send({ ok: false, error: "类型不存在" });
        if (row.builtin)
            return reply.code(409).send({ ok: false, error: "系统内置类型不可修改" });
        const b = req.body ?? {};
        const label = b.label !== undefined ? String(b.label).trim() : row.label;
        if (!label)
            return reply.code(400).send({ ok: false, error: "类型显示名不能为空" });
        db.prepare(`UPDATE card_types SET label=?, color=?, can_dispatch_out=?, can_dispatch_in=?, can_inject_out=?, can_inject_in=? WHERE type_key=?`)
            .run(label,
                b.color !== undefined ? (String(b.color).trim() || null) : row.color,
                ...CARD_TYPE_FLAGS.map((f) => (b[f] !== undefined ? (b[f] ? 1 : 0) : (Number(row[f]) ? 1 : 0))),
                row.type_key);
        return { ok: true, type_key: row.type_key };
    });

    app.delete("/api/card-types/:key", async (req, reply) => {
        const row = typeRowOf(String(req.params.key));
        if (!row)
            return reply.code(404).send({ ok: false, error: "类型不存在" });
        if (row.builtin)
            return reply.code(409).send({ ok: false, error: "系统内置类型不可删除" });
        const used = Number(db.prepare(`SELECT COUNT(*) n FROM cards WHERE kind=?`).get(row.type_key).n);
        if (used > 0)
            return reply.code(409).send({ ok: false, error: `仍有 ${used} 张卡片使用该类型，不能删除` });
        db.prepare(`DELETE FROM card_types WHERE type_key=?`).run(row.type_key);
        return { ok: true };
    });

    // 改型（先建卡后选型的核心端点；PUT /api/cards/:id 不支持改 kind，故单列）
    app.post("/api/cards/:id/retype", async (req, reply) => {
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c)
            return reply.code(404).send({ ok: false, error: "卡片不存在" });
        const b = req.body ?? {};
        const kind = String(b.kind ?? "").trim();
        const t = typeRowOf(kind);
        if (!t)
            return reply.code(400).send({ ok: false, error: `未知卡片类型：${kind}` });
        if (c.kind === kind)
            return { ok: true, id, kind, unchanged: true };
        if (String(c.status) === "running")
            return reply.code(409).send({ ok: false, error: "卡片执行中，不能改型" });
        const activeEdge = db.prepare(`SELECT id FROM card_edges WHERE (source_id=? OR target_id=?) AND kind='dispatch' AND status='active'`).get(id, id);
        if (activeEdge)
            return reply.code(409).send({ ok: false, error: "卡片存在进行中的派发连线，不能改型" });
        const meta = readCardMeta(c);
        // 切入智能体卡：请求内直接建档案（一步到位，免两跳）
        if (kind === "agent" && !meta.profile_id) {
            const p = b.profile ?? {};
            const name = String(p.name ?? c.title ?? "").trim();
            if (!name)
                return reply.code(400).send({ ok: false, error: "切换为智能体卡需要提供名称（profile.name）" });
            const ins = db.prepare(`INSERT INTO agent_profiles(name,agent_key,channel,workspace,model,context_tokens,reasoning,launch_overrides)
                VALUES (?,?,?,?,?,?,?,?)`)
                .run(name, String(p.agent_key ?? "").trim() || null, validProfileChannel(p.channel),
                    String(p.workspace ?? "").trim() || null, String(p.model ?? "").trim() || null,
                    Number(p.context_tokens) > 0 ? Math.floor(Number(p.context_tokens)) : null,
                    String(p.reasoning ?? "").trim() || null, p.launch_overrides ? JSON.stringify(p.launch_overrides) : null);
            meta.profile_id = Number(ins.lastInsertRowid);
        }
        // 切出智能体卡：档案随卡删除（配置不留孤儿）
        if (String(c.kind) === "agent" && kind !== "agent" && meta.profile_id) {
            db.prepare(`DELETE FROM agent_profiles WHERE id=?`).run(Number(meta.profile_id));
            delete meta.profile_id;
        }
        // ★ meta 必须随改型写回：切入 agent 时 profile_id 只在此处落库（否则投影卡永远找不到档案）
        db.prepare(`UPDATE cards SET kind=?, meta=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(kind, JSON.stringify(meta), id);
        if (kind === "task" && !CARD_STATES.includes(String(c.status)))
            db.prepare(`UPDATE cards SET status='triage' WHERE id=?`).run(id); // 非法态兜底进任务状态机
        writeCardEvent(id, "human:dashboard", "retype", String(c.kind), kind, `改型 ${c.kind} → ${kind}`);
        return { ok: true, id, kind, profile_id: meta.profile_id ?? null };
    });

    app.get("/api/agent-profiles", async () => {
        const rows = db.prepare(`SELECT * FROM agent_profiles ORDER BY id`).all();
        const cardByProfile = new Map();
        for (const r of db.prepare(`SELECT id, meta, status FROM cards WHERE kind='agent'`).all()) {
            try {
                const m = JSON.parse(r.meta ?? "{}");
                if (m.profile_id)
                    cardByProfile.set(Number(m.profile_id), { card_id: Number(r.id), status: String(r.status ?? "") });
            }
            catch { /* meta 非法忽略 */ }
        }
        const keys = scanKeysSafe();
        return {
            ok: true,
            profiles: rows.map((p) => ({
                ...p,
                card: cardByProfile.get(Number(p.id)) ?? null,
                carrier_missing: keys ? (p.agent_key ? !keys.has(String(p.agent_key)) : false) : false,
            })),
        };
    });

    app.post("/api/agent-profiles", async (req, reply) => {
        const b = req.body ?? {};
        const name = String(b.name ?? "").trim();
        if (!name)
            return reply.code(400).send({ ok: false, error: "智能体卡名称不能为空" });
        const channel = validProfileChannel(b.channel);
        txBegin(); // 档案 + 投影卡一笔事务：不留孤儿半截
        let profileId = 0, cardId = 0;
        try {
            const ins = db.prepare(`INSERT INTO agent_profiles(name,agent_key,channel,workspace,model,context_tokens,reasoning,concurrency,launch_overrides,meta)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
                .run(name, String(b.agent_key ?? "").trim() || null, channel,
                    String(b.workspace ?? "").trim() || null, String(b.model ?? "").trim() || null,
                    Number(b.context_tokens) > 0 ? Math.floor(Number(b.context_tokens)) : null,
                    String(b.reasoning ?? "").trim() || null,
                    Number(b.concurrency) > 0 ? Math.floor(Number(b.concurrency)) : 1,
                    b.launch_overrides ? JSON.stringify(b.launch_overrides) : null,
                    b.meta ? JSON.stringify(b.meta) : null);
            profileId = Number(ins.lastInsertRowid);
            const meta = { profile_id: profileId };
            const pos = b.meta?.map_pos;
            if (pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y)))
                meta.map_pos = { c: { x: Math.round(Number(pos.x)), y: Math.round(Number(pos.y)) } };
            const cIns = db.prepare(`INSERT INTO cards(board,kind,title,body,status,meta) VALUES ('default','agent',?,NULL,'todo',?)`)
                .run(name, JSON.stringify(meta));
            cardId = Number(cIns.lastInsertRowid);
            writeCardEvent(cardId, "human:dashboard", "create", null, "todo", `新建智能体卡 ${name}`);
            txCommit();
        }
        catch (e) {
            try { txRollback(); }
            catch (e2) { console.error("[cards] agent-profiles 建档案回滚异常", e2); }
            console.error("[cards] agent-profiles 建档案失败（已回滚，不留孤儿）", e);
            return reply.code(500).send({ ok: false, error: String(e instanceof Error ? e.message : e) });
        }
        return { ok: true, profile_id: profileId, card_id: cardId };
    });

    app.put("/api/agent-profiles/:id", async (req, reply) => {
        const p = db.prepare(`SELECT * FROM agent_profiles WHERE id=?`).get(Number(req.params.id));
        if (!p)
            return reply.code(404).send({ ok: false, error: "智能体档案不存在" });
        const b = req.body ?? {};
        const cardId = projectionCardOfProfile(p.id);
        if (cardId) {
            const busy = db.prepare(`SELECT id FROM card_edges WHERE target_id=? AND kind='dispatch' AND status='active'`).get(cardId);
            if (busy)
                return reply.code(409).send({ ok: false, error: "该智能体卡有进行中的派发，执行完再改配置" });
        }
        const name = b.name !== undefined ? String(b.name).trim() : p.name;
        if (!name)
            return reply.code(400).send({ ok: false, error: "名称不能为空" });
        db.prepare(`UPDATE agent_profiles SET name=?, agent_key=?, channel=?, workspace=?, model=?, context_tokens=?, reasoning=?, concurrency=?, launch_overrides=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
            .run(name,
                b.agent_key !== undefined ? (String(b.agent_key).trim() || null) : p.agent_key,
                b.channel !== undefined ? validProfileChannel(b.channel) : p.channel,
                b.workspace !== undefined ? (String(b.workspace).trim() || null) : p.workspace,
                b.model !== undefined ? (String(b.model).trim() || null) : p.model,
                b.context_tokens !== undefined ? (Number(b.context_tokens) > 0 ? Math.floor(Number(b.context_tokens)) : null) : p.context_tokens,
                b.reasoning !== undefined ? (String(b.reasoning).trim() || null) : p.reasoning,
                b.concurrency !== undefined ? (Number(b.concurrency) > 0 ? Math.floor(Number(b.concurrency)) : 1) : p.concurrency,
                b.launch_overrides !== undefined ? (b.launch_overrides ? JSON.stringify(b.launch_overrides) : null) : p.launch_overrides,
                p.id);
        if (cardId && b.name !== undefined) // 投影卡标题随档案名同步
            db.prepare(`UPDATE cards SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(name, cardId);
        return { ok: true, id: p.id };
    });

    app.delete("/api/agent-profiles/:id", async (req, reply) => {
        const p = db.prepare(`SELECT * FROM agent_profiles WHERE id=?`).get(Number(req.params.id));
        if (!p)
            return reply.code(404).send({ ok: false, error: "智能体档案不存在" });
        const cardId = projectionCardOfProfile(p.id);
        if (cardId) {
            const busy = db.prepare(`SELECT id FROM card_edges WHERE target_id=? AND kind='dispatch' AND status='active'`).get(cardId);
            if (busy)
                return reply.code(409).send({ ok: false, error: "该智能体卡有进行中的派发，不能删除" });
            db.prepare(`DELETE FROM card_edges WHERE source_id=? OR target_id=?`).run(cardId, cardId);
            db.prepare(`DELETE FROM cards WHERE id=?`).run(cardId);
        }
        db.prepare(`DELETE FROM agent_profiles WHERE id=?`).run(p.id);
        return { ok: true };
    });

    // 前情注入边（派发边只由 dispatch-agent 在派发事务内创建，避免绕过唯一 active/fencing）
    app.post("/api/card-edges", async (req, reply) => {
        const b = req.body ?? {};
        const kind = String(b.kind ?? "").trim();
        if (kind !== "inject")
            return reply.code(400).send({ ok: false, error: "此端点仅创建前情注入边（派发边由「派发」动作自动建立）" });
        const sourceId = Number(b.source_id) || 0, targetId = Number(b.target_id) || 0;
        if (!sourceId || !targetId)
            return reply.code(400).send({ ok: false, error: "缺少边端点（source_id/target_id）" });
        if (sourceId === targetId)
            return reply.code(400).send({ ok: false, error: "不能连接到自身" });
        const s = readCard(sourceId), t = readCard(targetId);
        if (!s || !t)
            return reply.code(404).send({ ok: false, error: "边端点卡片不存在" });
        const st = typeRowOf(String(s.kind)), tt = typeRowOf(String(t.kind));
        if (!st?.can_inject_out)
            return reply.code(409).send({ ok: false, error: `「${st?.label ?? s.kind}」类型不能发起前情注入` });
        if (!tt?.can_inject_in)
            return reply.code(409).send({ ok: false, error: `「${tt?.label ?? t.kind}」类型不能接收前情注入` });
        try {
            const ins = db.prepare(`INSERT INTO card_edges(source_id,target_id,kind,status) VALUES (?,?,'inject','active')`).run(sourceId, targetId);
            return { ok: true, id: Number(ins.lastInsertRowid) };
        }
        catch (e) {
            // 唯一索引冲突=重复连线（预期 409）；其他异常也如实落日志，避免误报成「重复连线」掩盖真错误
            console.error("[cards] card-edges 建注入边失败（常见为重复连线）", e);
            return reply.code(409).send({ ok: false, error: "该交接文档已注入此任务（重复连线）" });
        }
    });

    app.delete("/api/card-edges/:id", async (req, reply) => {
        const e = db.prepare(`SELECT * FROM card_edges WHERE id=?`).get(Number(req.params.id));
        if (!e)
            return reply.code(404).send({ ok: false, error: "边不存在" });
        if (e.kind === "dispatch")
            return reply.code(409).send({ ok: false, error: "派发边是历史链的一部分，不可手删（随派发终态自动翻状态）" });
        db.prepare(`DELETE FROM card_edges WHERE id=?`).run(e.id);
        return { ok: true };
    });

    // 智能体卡状态唯一出口：档位/载体在位/队列深度（前端禁自行探测进程，见报告 §5.4）
    app.get("/api/agent-cards/:id/state", async (req, reply) => {
        const id = Number(req.params.id);
        const c = readCard(id);
        if (!c || String(c.kind) !== "agent")
            return reply.code(404).send({ ok: false, error: "智能体卡不存在" });
        const p = profileOfCard(c);
        const keys = scanKeysSafe();
        const queue = db.prepare(`
            SELECT e.id edge_id, e.source_id card_id, k.title, d.generation, d.heartbeat_at, d.lease_expires_at
            FROM card_edges e
            LEFT JOIN dispatches d ON d.id = e.dispatch_id
            LEFT JOIN cards k ON k.id = e.source_id
            WHERE e.target_id=? AND e.kind='dispatch' AND e.status='active'
            ORDER BY e.id`).all(id);
        return {
            ok: true, id,
            name: p?.name ?? c.title,
            channel: p?.channel ?? "queue",
            agent_key: p?.agent_key ?? null,
            workspace: p?.workspace ?? null, model: p?.model ?? null, reasoning: p?.reasoning ?? null, context_tokens: p?.context_tokens ?? null,
            carrier_missing: p ? (keys ? (p.agent_key ? !keys.has(String(p.agent_key)) : false) : false) : true,
            queue_depth: queue.length,
            queue,
        };
    });
}
