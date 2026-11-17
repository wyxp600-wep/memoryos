/**
 * ★ 2026-11-16（B1）：任务库标准接口 —— 只管理任务域，不认识记忆库。
 *
 * 边界（硬约束）：
 *   · 本模块**禁止** import memory-store.js / task-links.js / db.js 的记忆函数；
 *   · 只读写 `{schema}.task_records` / `dispatches` / `cards` / `task_events` /
 *     `task_checkpoints` / `task_sequence` / `task_fts` / `task_gram`；
 *   · 任务与记忆的关联不在本模块（见 task-links.js）。
 *
 * 独立部署：`createTaskStore({ db, schema: "main" })` 即可在「只有任务库」的进程里工作；
 *   集成模式保持默认 `schema: "task_store"`（ATTACH 后的 schema 名）。
 *
 * 依赖注入约定：`db` 为已打开并完成 ATTACH 的 DatabaseSync 兼容对象（需要 prepare/exec）。
 *   本模块不持有连接生命周期，也不决定事务边界（由调用方 withTx 包裹）。
 */

const TASK_COLS = [
    "content", "type", "agent", "agent_fpath", "project", "status", "confidence", "eff_confidence",
    "conflict_with", "superseded_by", "derived_from", "hit_count", "last_hit_at", "embedding",
    "embedding_stale", "sensitivity", "inject", "source", "created_at", "sector", "form", "salience",
    "decay_lambda", "last_seen_at", "valid_from", "valid_until", "trigger_cond", "trigger_kind",
    "trigger_action", "valence", "arousal", "source_ref", "pinned", "version", "fencing_token",
    "epoch", "idempotency_key", "causal_parent",
];

const nowIso = () => new Date().toISOString();
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** 任务文本头：[task][assignee:x][status:y] 标题 */
const HEAD_RE = /^\[task\]\[assignee:([^\]]*)\]\[status:([a-z_]+)\]([\s\S]*)$/;

export function createTaskStore({ db, schema = "task_store", helpers = {} } = {}) {
    if (!db || typeof db.prepare !== "function")
        throw new Error("createTaskStore: 需要 db（已 ATTACH 的 DatabaseSync 兼容对象）");
    const T = (name) => `${schema}.${q(name)}`;
    /* ★ B4 组1b：sector 归一与衰减默认值属于「记忆字段口径」，由调用方注入（集成时传 db.js 的实现），
       避免 store 反向依赖记忆层；独立部署可用默认实现（sector 原样 + 中性 λ）。 */
    const normalizeSector = helpers.normalizeSector ?? ((s) => String(s ?? "").trim().toLowerCase() || "episodic");
    const sectorLambda = helpers.sectorLambda ?? (() => 0.01);

    /** 取下一个任务号：与 storage.js 同口径（value 表示已发出的最大号，先 +1 再读）。 */
    function nextId() {
        const row = db.prepare(`SELECT value FROM ${T("task_sequence")} WHERE id=1`).get();
        if (!row) throw new Error("task_sequence 未初始化（任务库未完成迁移）");
        db.prepare(`UPDATE ${T("task_sequence")} SET value=value+1 WHERE id=1`).run();
        return Number(db.prepare(`SELECT value FROM ${T("task_sequence")} WHERE id=1`).get().value);
    }

    /** 创建任务：只写任务表，绝不落 knowledge_records。返回 DTO（不含 prepared statement）。 */
    function createTask(input = {}) {
        const content = String(input.content ?? "");
        if (!content.trim()) throw new Error("createTask: content 必填");
        const id = input.id != null ? Number(input.id) : nextId();
        // ★ B4 组1b：默认值与 db.js writeMemory 逐项对齐（sector 推导 / λ / form / salience / trigger_kind / source）
        const sector = normalizeSector(input.sector, "task");
        const lambda = input.decay_lambda ?? sectorLambda(sector);
        const source = input.source ?? (String(input.agent ?? "").startsWith("human") ? "human" : "agent");
        const row = {
            id,
            content: String(content).replace(/\\r\\n?/g, "\\n"),
            type: "task",
            agent: input.agent ?? "unknown",
            agent_fpath: input.agent_fpath ?? null,
            project: input.project ?? "global",
            status: input.status ?? "active",
            confidence: input.confidence ?? 0.8,
            eff_confidence: input.eff_confidence ?? input.confidence ?? 0.8,
            source,
            created_at: input.created_at ?? nowIso(),
            sector,
            form: String(input.form ?? "textual"),
            salience: input.salience ?? 1.0,
            decay_lambda: lambda,
            valid_from: input.valid_from ?? null,
            valid_until: input.valid_until ?? null,
            trigger_cond: input.trigger_cond ?? null,
            trigger_kind: String(input.trigger_kind ?? "pattern"),
            trigger_action: input.trigger_action ?? null,
            valence: input.valence ?? null,
            arousal: input.arousal ?? null,
            source_ref: input.source_ref ?? null,
            sensitivity: String(input.sensitivity ?? "normal"),
            pinned: input.pinned ?? 0,
            embedding: input.embedding ?? null,
            embedding_stale: input.embedding_stale ?? 1,
            idempotency_key: input.idempotency_key ?? null,
            causal_parent: input.causal_parent ?? null,
            version: input.version ?? 1,
            fencing_token: input.fencing_token ?? 0,
            epoch: input.epoch ?? 1,
        };
        const cols = Object.keys(row);
        const ph = cols.map(() => "?").join(",");
        db.prepare(`INSERT INTO ${T("task_records")} (${cols.map(q).join(",")}) VALUES (${ph})`)
            .run(...cols.map((c) => row[c]));
        // 显式 id 时也要抬高号段，防后续自增撞号（与 storage.js 的 max(value,NEW.id) 同口径）
        if (input.id != null)
            db.prepare(`UPDATE ${T("task_sequence")} SET value=max(value,?) WHERE id=1`).run(id);
        return getTask(id);
    }

    /** 按列状态列任务（与 db.js queryByType 同口径：created_at 倒序 + id 倒序）。 */
    function listTasks({ status = null, limit = 500 } = {}) {
        const lim = Math.min(Math.max(Number(limit) || 500, 1), 2000);
        const ph = status ? "WHERE status=?" : "";
        // ★ 与 db.js rowOf 同口径：node:sqlite 可能返回 BigInt/字符串，统一转 Number，
        //   否则调用方用 === / 算术比较会静默失效（B4 组1 实测触发会话隔离与 done 集判定回归）。
        const num = (v) => (v == null ? v : Number(v));
        return db.prepare(`SELECT * FROM ${T("task_records")} ${ph}
            ORDER BY julianday(created_at) DESC, id DESC LIMIT ?`)
            .all(...(status ? [String(status)] : []), lim)
            .map((r) => ({
                ...r,
                id: Number(r.id),
                confidence: num(r.confidence),
                eff_confidence: num(r.eff_confidence),
                conflict_with: num(r.conflict_with),
                superseded_by: num(r.superseded_by),
                derived_from: num(r.derived_from),
                hit_count: Number(r.hit_count ?? 0),
                version: Number(r.version ?? 1),
                embedding_stale: Number(r.embedding_stale ?? 0),
            }));
    }

    function getTask(id) {
        return db.prepare(`SELECT * FROM ${T("task_records")} WHERE id=?`).get(Number(id)) ?? null;
    }

    /** 更新任务：默认按 id；带 expectedVersion 时做 CAS（版本不符则返回 {ok:false, code:"version-conflict"}）。 */
    function updateTask(id, patch = {}, { expectedVersion = null } = {}) {
        const cur = getTask(id);
        if (!cur) return { ok: false, code: "not-found" };
        if (expectedVersion != null && Number(expectedVersion) !== Number(cur.version))
            return { ok: false, code: "version-conflict", current: Number(cur.version) };
        const cols = Object.keys(patch).filter((c) => TASK_COLS.includes(c) && c !== "id");
        if (!cols.length) return { ok: true, task: cur, changed: 0 };
        const sets = cols.map((c) => `${q(c)}=?`).join(",");
        const nextVersion = Number(cur.version) + 1;
        const info = db.prepare(`UPDATE ${T("task_records")} SET ${sets}, version=? WHERE id=?`)
            .run(...cols.map((c) => patch[c]), nextVersion, Number(id));
        return { ok: true, task: getTask(id), changed: Number(info.changes) };
    }

    function deleteTask(id) {
        const info = db.prepare(`DELETE FROM ${T("task_records")} WHERE id=?`).run(Number(id));
        return { ok: Number(info.changes) > 0, changed: Number(info.changes) };
    }

    /** 解析任务头（assignee / status），只读，不做状态机裁决。 */
    function parseHead(id) {
        const t = getTask(id);
        if (!t) return null;
        const m = HEAD_RE.exec(String(t.content ?? ""));
        return m ? { assignee: m[1], status: m[2], title: m[3].trim() } : { assignee: null, status: null, title: String(t.content ?? "") };
    }

    // ── 任务事件 ──
    function appendEvent({ memoryId, op, payload = null, operator = "system", undone = 0 }) {
        const info = db.prepare(`INSERT INTO ${T("task_events")} (memory_id, op, payload, operator, undone, created_at)
            VALUES (?,?,?,?,?,?)`).run(Number(memoryId), String(op), payload == null ? null : JSON.stringify(payload), String(operator), undone ? 1 : 0, nowIso());
        return { ok: true, id: Number(info.lastInsertRowid) };
    }

    function listEvents(memoryId, { limit = 20, ops = [] } = {}) {
        const ph = ops.length ? `AND op IN (${ops.map(() => "?").join(",")})` : "";
        return db.prepare(`SELECT * FROM ${T("task_events")} WHERE memory_id=? ${ph} ORDER BY id DESC LIMIT ?`)
            .all(Number(memoryId), ...ops, Number(limit));
    }

    // ── dispatch（租约唯一真相源；语义与 db.js 逐条对齐，便于后续零改动替换）──
    /** 生成：generation 取历史最大值 +1；先把旧 active/stale 置 superseded，再插新行并回填 superseded_by。
     *  必须保留该顺序——dispatches 上有「每任务仅一条 active」的唯一约束，跳过 supersede 会撞 UNIQUE。 */
    function createDispatch({ key, memoryId, agent, sessionId = null, credentialId = null, leaseMinutes = 30 }) {
        const min = Math.max(1, Math.min(1440, Math.floor(Number(leaseMinutes) || 30)));
        const gen = Number(db.prepare(`SELECT MAX(generation) g FROM ${T("dispatches")} WHERE memory_id=?`).get(Number(memoryId))?.g ?? 0) + 1;
        const priors = db.prepare(`SELECT id FROM ${T("dispatches")} WHERE memory_id=? AND state IN ('active','stale')`).all(Number(memoryId));
        for (const p of priors)
            db.prepare(`UPDATE ${T("dispatches")} SET state='superseded', settled_at=? WHERE id=?`).run(nowIso(), Number(p.id));
        const info = db.prepare(`INSERT INTO ${T("dispatches")}
            (dispatch_key, memory_id, agent, session_id, credential_id, state, generation, lease_expires_at, heartbeat_at, started_at)
            VALUES (?,?,?,?,?, 'active', ?, ?, ?, ?)`)
            .run(String(key), Number(memoryId), String(agent), sessionId, credentialId, gen,
            new Date(Date.now() + min * 60_000).toISOString(), nowIso(), nowIso());
        const id = Number(info.lastInsertRowid);
        for (const p of priors)
            db.prepare(`UPDATE ${T("dispatches")} SET superseded_by=? WHERE id=?`).run(id, Number(p.id));
        return { id, key: String(key), generation: gen, superseded: priors.length ? Number(priors[0].id) : null };
    }

    function readDispatchByKey(key) {
        return db.prepare(`SELECT * FROM ${T("dispatches")} WHERE dispatch_key=?`).get(String(key)) ?? null;
    }

    function readActiveDispatch(memoryId) {
        return db.prepare(`SELECT * FROM ${T("dispatches")} WHERE memory_id=? AND state='active'
            ORDER BY generation DESC, id DESC LIMIT 1`).get(Number(memoryId)) ?? null;
    }

    /** 结算：outcome 归一到 succeeded/failed；只作用于 active（与 db.js 同口径，返回 boolean）。 */
    function settleDispatch(dispatchId, outcome, evidence = null) {
        const oc = outcome === "failed" ? "failed" : "succeeded";
        const info = db.prepare(`UPDATE ${T("dispatches")} SET state='settled', outcome=?, evidence=?, settled_at=?
            WHERE id=? AND state='active'`).run(oc, evidence == null ? null : String(evidence), nowIso(), Number(dispatchId));
        return Number(info.changes ?? 0) > 0;
    }

    /** 释放：只作用于 active/stale（与 db.js 同口径，返回 boolean）。 */
    function releaseDispatch(dispatchId, reason = null) {
        const info = db.prepare(`UPDATE ${T("dispatches")} SET state='released', evidence=?, settled_at=?
            WHERE id=? AND state IN ('active','stale')`).run(reason == null ? null : String(reason), nowIso(), Number(dispatchId));
        return Number(info.changes ?? 0) > 0;
    }

    // ── 卡片 ──
    function getCard(id) {
        return db.prepare(`SELECT * FROM ${T("cards")} WHERE id=?`).get(Number(id)) ?? null;
    }

    function listCardsOfTask(taskId) {
        try {
            return db.prepare(`SELECT * FROM ${T("cards")} WHERE ref_id=? AND ref_kind='task'`).all(Number(taskId));
        }
        catch { return []; }
    }

    // ── 检查点 ──
    function readCheckpoint(cardId) {
        try {
            return db.prepare(`SELECT * FROM ${T("task_checkpoints")} WHERE card_id=? ORDER BY version DESC LIMIT 1`).get(Number(cardId)) ?? null;
        }
        catch { return null; }
    }

    function writeCheckpoint({ cardId, sessionId, checkpoint, expectedVersion = 0, author = "system", taskState = null }) {
        const cur = readCheckpoint(cardId);
        const curVer = Number(cur?.version ?? 0);
        if (Number(expectedVersion) !== curVer)
            return { ok: false, code: "version-conflict", current: curVer };
        const next = curVer + 1;
        db.prepare(`INSERT INTO ${T("task_checkpoints")} (card_id, version, session_id, author, payload, task_state, created_at)
            VALUES (?,?,?,?,?,?,?)`).run(Number(cardId), next, String(sessionId), String(author),
            checkpoint == null ? null : JSON.stringify(checkpoint), taskState, nowIso());
        return { ok: true, version: next };
    }

    /** 任务检索：只查任务库 FTS；无 FTS 时退化为 LIKE（独立/旧库可用）。 */
    function searchTasks(query, { limit = 10, project = null } = {}) {
        const qq = String(query ?? "").trim();
        if (!qq) return [];
        const hasFts = (() => {
            try { return !!db.prepare(`SELECT 1 x FROM ${T("task_fts")} LIMIT 0`); }
            catch { return false; }
        })();
        if (hasFts) {
            try {
                const ph = project ? "AND t.project=?" : "";
                return db.prepare(`SELECT t.id, t.content, t.project, t.status, bm25(task_fts) rank
                    FROM ${T("task_fts")} JOIN ${T("task_records")} t ON t.id = task_fts.rowid
                    WHERE task_fts MATCH ? ${ph} ORDER BY rank LIMIT ?`)
                    .all(qq, ...(project ? [String(project)] : []), Number(limit));
            }
            catch { /* MATCH 语法错误时退化 LIKE */ }
        }
        const ph = project ? "AND project=?" : "";
        return db.prepare(`SELECT id, content, project, status FROM ${T("task_records")}
            WHERE content LIKE ? ${ph} ORDER BY id DESC LIMIT ?`)
            .all(`%${qq}%`, ...(project ? [String(project)] : []), Number(limit));
    }

    function stats() {
        const one = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch { return null; } };
        return {
            schema,
            tasks: Number(one(`SELECT COUNT(*) c FROM ${T("task_records")}`)?.c ?? 0),
            activeDispatches: Number(one(`SELECT COUNT(*) c FROM ${T("dispatches")} WHERE state='active'`)?.c ?? 0),
            cards: Number(one(`SELECT COUNT(*) c FROM ${T("cards")}`)?.c ?? 0),
            events: Number(one(`SELECT COUNT(*) c FROM ${T("task_events")}`)?.c ?? 0),
        };
    }

    /** 依赖自检：任务库不应有非任务记录（守卫触发器之外的兜底断言）。 */
    function assertTaskOnly() {
        const bad = Number(db.prepare(`SELECT COUNT(*) c FROM ${T("task_records")} WHERE type<>'task'`).get()?.c ?? 0);
        return { ok: bad === 0, nonTaskRows: bad };
    }

    return {
        schema,
        nextId, createTask, getTask, listTasks, updateTask, deleteTask, parseHead,
        appendEvent, listEvents,
        createDispatch, readDispatchByKey, readActiveDispatch, settleDispatch, releaseDispatch,
        getCard, listCardsOfTask, readCheckpoint, writeCheckpoint,
        searchTasks, stats, assertTaskOnly,
    };
}
