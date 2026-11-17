/**
 * ★ 2026-11-16（B2）：记忆库标准接口 —— 只管理知识记忆，不认识任务库。
 *
 * 边界（硬约束）：
 *   · 本模块**禁止** import task-store.js / task-links.js / task-domain.js；
 *   · 只读写 `{schema}.knowledge_records` / `memory_events` / `memory_vectors` /
 *     `memories_fts` / `memories_gram` / `links`（memory↔memory）；
 *   · 任务与记忆的关联不在本模块（见 task-links.js）。
 *
 * 独立部署：`createMemoryStore({ db, schema: "main" })` 即可在「只有记忆库」的进程里工作；
 *   集成模式下记忆库本来就是 main，默认值不变。
 *
 * 与旧写入层的差异：`createMemory` 拒绝 `type='task'`（任务必须走 task-store），
 *   并保留六字段正文校验的调用方责任（本模块不复制校验规则，避免两处口径漂移）。
 */

const MEM_COLS = [
    "content", "type", "agent", "agent_fpath", "project", "status", "confidence", "eff_confidence",
    "conflict_with", "superseded_by", "derived_from", "hit_count", "last_hit_at", "embedding",
    "embedding_stale", "sensitivity", "inject", "source", "created_at", "sector", "form", "salience",
    "decay_lambda", "last_seen_at", "valid_from", "valid_until", "trigger_cond", "trigger_kind",
    "trigger_action", "valence", "arousal", "source_ref", "pinned", "version", "fencing_token",
    "epoch", "idempotency_key", "causal_parent",
];
const RELATIONS = ["related", "depends_on", "conflicts", "derived_from", "supersedes"];

const nowIso = () => new Date().toISOString();
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

export function createMemoryStore({ db, schema = "main", helpers = {} } = {}) {
    if (!db || typeof db.prepare !== "function")
        throw new Error("createMemoryStore: 需要 db（已打开的 DatabaseSync 兼容对象）");
    const T = (name) => `${schema}.${q(name)}`;
    /* ★ B4 组3b：sector 归一与衰减默认值由调用方注入（集成时传 db.js 实现），store 保持零依赖。 */
    const normalizeSector = helpers.normalizeSector ?? ((s) => String(s ?? "").trim().toLowerCase() || "episodic");
    const sectorLambda = helpers.sectorLambda ?? (() => 0.01);

    function nextId() {
        const row = db.prepare(`SELECT value FROM ${T("record_sequence")} WHERE id=1`).get();
        if (!row) throw new Error("record_sequence 未初始化（记忆库未完成建表）");
        db.prepare(`UPDATE ${T("record_sequence")} SET value=value+1 WHERE id=1`).run();
        return Number(db.prepare(`SELECT value FROM ${T("record_sequence")} WHERE id=1`).get().value);
    }

    /** 创建记忆。type='task' 一律拒绝（边界硬约束，不依赖运行时猜测）。 */
    function createMemory(input = {}) {
        const type = String(input.type ?? "experience");
        if (type === "task")
            return { ok: false, code: "task-not-allowed", msg: "任务必须写入任务库（task-store），记忆库拒绝 type='task'" };
        const content = String(input.content ?? "");
        if (!content.trim()) return { ok: false, code: "empty-content", msg: "content 必填" };
        const id = input.id != null ? Number(input.id) : nextId();
        const sector = normalizeSector(input.sector, type);
        const lambda = input.decay_lambda ?? sectorLambda(sector);
        const row = {
            id,
            content,
            type,
            agent: input.agent ?? "unknown",
            agent_fpath: input.agent_fpath ?? null,
            project: input.project ?? "global",
            status: input.status ?? "active",
            confidence: input.confidence ?? 0.7,
            eff_confidence: input.eff_confidence ?? input.confidence ?? 0.7,
            source: input.source ?? (String(input.agent ?? "").startsWith("human") ? "human" : "agent"),
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
            idempotency_key: input.idempotency_key ?? null,
            causal_parent: input.causal_parent ?? null,
            embedding: input.embedding ?? null,
            embedding_stale: input.embedding_stale ?? 1,
            inject: input.inject ?? 0,
            version: input.version ?? 1,
            fencing_token: input.fencing_token ?? 0,
            epoch: input.epoch ?? 1,
        };
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO ${T("knowledge_records")} (${cols.map(q).join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
            .run(...cols.map((c) => row[c]));
        if (input.id != null)
            db.prepare(`UPDATE ${T("record_sequence")} SET value=max(value,?) WHERE id=1`).run(id);
        return { ok: true, memory: getMemory(id) };
    }

    function getMemory(id) {
        return db.prepare(`SELECT * FROM ${T("knowledge_records")} WHERE id=?`).get(Number(id)) ?? null;
    }

    function updateMemory(id, patch = {}, { expectedVersion = null } = {}) {
        const cur = getMemory(id);
        if (!cur) return { ok: false, code: "not-found" };
        if (patch.type === "task") return { ok: false, code: "task-not-allowed", msg: "记忆不可转为任务" };
        if (expectedVersion != null && Number(expectedVersion) !== Number(cur.version))
            return { ok: false, code: "version-conflict", current: Number(cur.version) };
        const cols = Object.keys(patch).filter((c) => MEM_COLS.includes(c) && c !== "id");
        if (!cols.length) return { ok: true, memory: cur, changed: 0 };
        const nextVersion = Number(cur.version) + 1;
        const info = db.prepare(`UPDATE ${T("knowledge_records")} SET ${cols.map((c) => `${q(c)}=?`).join(",")}, version=? WHERE id=?`)
            .run(...cols.map((c) => patch[c]), nextVersion, Number(id));
        return { ok: true, memory: getMemory(id), changed: Number(info.changes) };
    }

    /** 归档（软删除）：只改 status，不物理删除，保持可追溯。 */
    function archiveMemory(id) {
        const info = db.prepare(`UPDATE ${T("knowledge_records")} SET status='archived', version=version+1 WHERE id=?`).run(Number(id));
        return { ok: Number(info.changes) > 0 };
    }

    /** 记忆事件：与 task_events 同构（payload 存 JSON），便于两侧审计口径一致。 */
    function appendEvent({ memoryId, op, payload = null, operator = "system", undone = 0 }) {
        try {
            const info = db.prepare(`INSERT INTO ${T("memory_events")} (memory_id, op, payload, operator, undone, created_at)
                VALUES (?,?,?,?,?,?)`).run(Number(memoryId), String(op),
                payload == null ? null : (typeof payload === "string" ? payload : JSON.stringify(payload)),
                String(operator), undone ? 1 : 0, nowIso());
            return { ok: true, id: Number(info.lastInsertRowid) };
        }
        catch (e) {
            console.error(`[memory-store] 记忆事件写入失败: ${String(e).slice(0, 300)}`);
            return { ok: false, code: "event-table-unavailable", msg: String(e).slice(0, 120) };
        }
    }

    function bumpHit(id) {
        const info = db.prepare(`UPDATE ${T("knowledge_records")}
            SET hit_count=hit_count+1, last_hit_at=?, last_seen_at=? WHERE id=?`).run(nowIso(), nowIso(), Number(id));
        return { ok: Number(info.changes) > 0 };
    }

    // ── 记忆间 links（memory ↔ memory）──
    function linkMemories({ srcId, dstId, kind = "related", context = null }) {
        if (!RELATIONS.includes(kind)) return { ok: false, code: "bad-relation", allowed: RELATIONS };
        const a = getMemory(srcId), b = getMemory(dstId);
        if (!a || !b) return { ok: false, code: "not-found", missing: !a ? srcId : dstId };
        const exists = db.prepare(`SELECT id FROM ${T("links")}
            WHERE src_kind='memory' AND src_id=? AND dst_kind='memory' AND dst_id=? AND kind=?`).get(Number(srcId), Number(dstId), kind);
        if (exists) return { ok: true, id: Number(exists.id), idempotent: true };
        const info = db.prepare(`INSERT INTO ${T("links")}
            (vault_root, src_kind, src_id, dst_kind, dst_id, dst_title, kind, anchor, alias, context, created_at)
            VALUES (NULL,'memory',?,'memory',?,NULL,?,NULL,NULL,?,?)`)
            .run(Number(srcId), Number(dstId), kind, context, nowIso());
        return { ok: true, id: Number(info.lastInsertRowid) };
    }

    function unlinkMemories({ srcId, dstId, kind = null }) {
        const ph = kind ? "AND kind=?" : "";
        const info = db.prepare(`DELETE FROM ${T("links")}
            WHERE src_kind='memory' AND src_id=? AND dst_kind='memory' AND dst_id=? ${ph}`)
            .run(Number(srcId), Number(dstId), ...(kind ? [kind] : []));
        return { ok: Number(info.changes) > 0, deleted: Number(info.changes) };
    }

    function listLinks(id) {
        return db.prepare(`SELECT id, src_id, dst_id, kind, context, created_at FROM ${T("links")}
            WHERE (src_kind='memory' AND src_id=?) OR (dst_kind='memory' AND dst_id=?)
            ORDER BY id DESC`).all(Number(id), Number(id));
    }

    /** 记忆检索：只查记忆 FTS；不代查任务。 */
    function searchMemories(query, { limit = 10, project = null, status = "active" } = {}) {
        const qq = String(query ?? "").trim();
        if (!qq) return [];
        const ph = [project ? "AND t.project=?" : "", status ? "AND t.status=?" : ""].filter(Boolean).join(" ");
        const extra = [...(project ? [String(project)] : []), ...(status ? [String(status)] : [])];
        try {
            return db.prepare(`SELECT t.id, t.content, t.type, t.project, t.status, bm25(memories_fts) rank
                FROM ${T("memories_fts")} JOIN ${T("knowledge_records")} t ON t.id = memories_fts.rowid
                WHERE memories_fts MATCH ? ${ph} ORDER BY rank LIMIT ?`).all(qq, ...extra, Number(limit));
        }
        catch {
            return db.prepare(`SELECT id, content, type, project, status FROM ${T("knowledge_records")}
                WHERE content LIKE ? ${ph.replace(/t\./g, "")} ORDER BY id DESC LIMIT ?`)
                .all(`%${qq}%`, ...extra, Number(limit));
        }
    }

    function stats() {
        const one = (sql) => { try { return db.prepare(sql).get(); } catch { return null; } };
        return {
            schema,
            memories: Number(one(`SELECT COUNT(*) c FROM ${T("knowledge_records")}`)?.c ?? 0),
            active: Number(one(`SELECT COUNT(*) c FROM ${T("knowledge_records")} WHERE status='active'`)?.c ?? 0),
            links: Number(one(`SELECT COUNT(*) c FROM ${T("links")} WHERE src_kind='memory' AND dst_kind='memory'`)?.c ?? 0),
        };
    }

    /** 边界自检：记忆库不应出现任务记录。 */
    function assertMemoryOnly() {
        const bad = Number(db.prepare(`SELECT COUNT(*) c FROM ${T("knowledge_records")} WHERE type='task'`).get()?.c ?? 0);
        return { ok: bad === 0, taskRows: bad };
    }

    return {
        schema,
        nextId, createMemory, getMemory, updateMemory, archiveMemory,
        appendEvent, bumpHit,
        linkMemories, unlinkMemories, listLinks,
        searchMemories, stats, assertMemoryOnly,
    };
}
