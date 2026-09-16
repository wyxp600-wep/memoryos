/** T8（P2-3）：buildApp 路由域拆分 —— ingest 域。
 * handler 自 dashboard.js 原行 1000-1242 逐字搬移，注册顺序不变；响应体逐字节一致。
 * 门禁：node dist/snapshot-routes.js --check 必须 0 差异。共享顶层名经 ctx 注入。 */
import { logDaemon, queryStats, readConfig } from "./db.js";
import { trend } from "./report.js";
import { loadHygieneConfig } from "./daemon.js";
import { getSources, ingestAll, loadCustomSpecs, saveCustomSpecs, validateCustomSource, customSourcesPath } from "./ingest.js";
import { randomBytes } from "node:crypto";
import path from "node:path";
export function registerIngest(app, ctx) {
    const { db, restricted, RESTRICTED } = ctx;
    // —— 采集消化：枚举可读明文知识源 ——
    app.get("/api/ingest/sources", async () => ({ sources: getSources() }));
    // —— 采集消化：执行一轮（读源→提炼→入库，幂等靠去重）——
    let ingestRunning = false;
    app.post("/api/ingest/run", async (req, reply) => {
        if (ingestRunning)
            return reply.code(409).send({ ok: false, error: "已有采集进行中，请稍候" });
        ingestRunning = true;
        try {
            const maxSources = Number(req.body?.maxSources ?? 0) || 0; // 0=全部
            const stats = await ingestAll(db, maxSources);
            return { ok: true, stats };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e) });
        }
        finally {
            ingestRunning = false;
        }
    });
    // —— 采集消化：自定义源读写（%APPDATA%\MemoryOS\sources.json，只影响自定义源，绝不动内置 SOURCE_SPECS）——
    app.get("/api/ingest/custom-sources", async () => ({
        sources: loadCustomSpecs(),
        path: customSourcesPath(),
    }));
    // 新增/更新（按 id upsert）；同一路径不允许重复登记
    app.post("/api/ingest/custom-sources", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "customSource");
        const b = req.body ?? {};
        const p = String(b.path ?? "").trim();
        if (!p)
            return reply.code(400).send({ ok: false, error: "路径不能为空" });
        const check = validateCustomSource({ path: p, maxFiles: b.maxFiles, maxDepth: b.maxDepth, includeFilter: b.includeFilter });
        if (!check.ok)
            return reply.code(400).send({ ok: false, error: check.error });
        const list = loadCustomSpecs();
        const id = String(b.id ?? "").trim() || `custom-${randomBytes(4).toString("hex")}`;
        const norm = p.replace(/\\/g, "/").toLowerCase();
        const dup = list.find((s) => s.id !== id && s.path.replace(/\\/g, "/").toLowerCase() === norm);
        if (dup)
            return reply.code(409).send({ ok: false, error: `该路径已被源「${dup.name || dup.id}」登记` });
        const kindRaw = String(b.kind ?? "memory");
        const kind = kindRaw === "rule" || kindRaw === "convo" ? kindRaw : "memory";
        const spec = {
            id,
            agent: String(b.agent ?? "custom").trim() || "custom",
            name: String(b.name ?? "").trim() || p.split(/[/\\]/).filter(Boolean).pop() || id,
            kind,
            level: b.level === "L1" ? "L1" : "L2",
            path: p,
            maxFiles: Math.min(Math.max(Number(b.maxFiles ?? 50) || 50, 1), 200),
            maxDepth: Math.min(Math.max(Number(b.maxDepth ?? 3) || 3, 0), 6),
            includeFilter: b.includeFilter ? String(b.includeFilter) : undefined,
        };
        const idx = list.findIndex((s) => s.id === id);
        const isUpdate = idx >= 0;
        if (isUpdate)
            list[idx] = spec;
        else
            list.push(spec);
        const r = saveCustomSpecs(list);
        if (!r.ok)
            return reply.code(500).send({ ok: false, error: r.error });
        logDaemon(db, {
            task: "ingest-custom-source",
            op: isUpdate ? "update" : "create",
            operator: "human:dashboard",
            detail: `自定义采集源${isUpdate ? "更新" : "新增"}：${spec.name} → ${spec.path}（命中 ${check.files} 文件）`,
        });
        return { ok: true, id: spec.id, source: spec, check, backupPath: r.backupPath, path: r.path };
    });
    // 删除（按 id）
    app.delete("/api/ingest/custom-sources/:id", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "customSource");
        const id = req.params.id;
        const list = loadCustomSpecs();
        const hit = list.find((s) => s.id === id);
        if (!hit)
            return reply.code(404).send({ ok: false, error: "自定义源不存在" });
        const r = saveCustomSpecs(list.filter((s) => s.id !== id));
        if (!r.ok)
            return reply.code(500).send({ ok: false, error: r.error });
        logDaemon(db, {
            task: "ingest-custom-source",
            op: "delete",
            operator: "human:dashboard",
            detail: `删除自定义采集源：${hit.name} → ${hit.path}`,
        });
        return { ok: true, id, backupPath: r.backupPath };
    });
    // 预检（不写盘）：返回文件数/总大小/样例路径，供前端「预检」按钮在提交前拦截
    app.post("/api/ingest/validate-source", async (req, reply) => {
        if (RESTRICTED)
            return restricted(reply, "customSource");
        const b = req.body ?? {};
        const check = validateCustomSource({
            path: String(b.path ?? ""),
            maxFiles: b.maxFiles,
            maxDepth: b.maxDepth,
            includeFilter: b.includeFilter,
        });
        return { ok: check.ok, check };
    });
    // 启用/停用采集源：受限模式下唯一允许的用户侧操作 —— 只切 enabled，不可改路径、不可增删
    app.post("/api/ingest/custom-sources/:id/enabled", async (req, reply) => {
        const id = req.params.id;
        const list = loadCustomSpecs();
        const idx = list.findIndex((s) => s.id === id);
        if (idx < 0)
            return reply.code(404).send({ ok: false, error: "采集源不存在" });
        const enabled = req.body?.enabled !== false;
        list[idx] = { ...list[idx], enabled };
        const r = saveCustomSpecs(list);
        if (!r.ok)
            return reply.code(500).send({ ok: false, error: r.error });
        logDaemon(db, {
            task: "ingest-custom-source",
            op: enabled ? "enable" : "disable",
            operator: "human:dashboard",
            detail: `${enabled ? "启用" : "停用"}采集源：${list[idx].name} → ${list[idx].path}`,
        });
        return { ok: true, id, enabled, backupPath: r.backupPath };
    });
    // —— 最近审计留痕（human:daemon 均可看）——
    app.get("/api/audit", async () => {
        const rows = db
            .prepare(`SELECT id, task, op, memory_id, operator, detail, created_at FROM daemon_log ORDER BY id DESC LIMIT 20`)
            .all();
        return { rows };
    });
    // —— 主动写入健康：最近一次主动写入时间 + 近 30 天次数（写习惯闭环提醒）——
    // 主动写入两通道：MCP memory_write（memory_usage.event='write'，agent 主动）+ Dashboard 手动写（daemon_log manual-write/edit）
    app.get("/api/write-health", async () => {
        const mcp = db
            .prepare(`SELECT created_at FROM memory_usage WHERE event='write' ORDER BY id DESC LIMIT 1`)
            .get();
        const human = db
            .prepare(`SELECT created_at FROM daemon_log WHERE task IN ('manual-write','manual-edit') ORDER BY id DESC LIMIT 1`)
            .get();
        const mcp30 = db
            .prepare(`SELECT COUNT(*) c FROM memory_usage WHERE event='write' AND created_at >= datetime('now','-30 days')`)
            .get().c;
        const human30 = db
            .prepare(`SELECT COUNT(*) c FROM daemon_log WHERE task IN ('manual-write','manual-edit') AND created_at >= datetime('now','-30 days')`)
            .get().c;
        const lastWrite = [mcp?.created_at, human?.created_at].filter(Boolean).sort().pop() ?? null;
        const daysSince = lastWrite ? Math.max(0, Math.floor((Date.now() - new Date(lastWrite).getTime()) / 86400000)) : null;
        return { lastWrite, daysSince, writes30d: mcp30 + human30, mcpWrite30d: mcp30, manualWrite30d: human30 };
    });
    // —— 利用率健康：近 30 天 search/write/returned/cited 趋势与今日活跃（两个提升方向的闭环度量）——
    app.get("/api/usage-health", async () => {
        const today = new Date().toISOString().slice(0, 10); // created_at 为 UTC，按日聚合需同口径
        const rows = db
            .prepare(`SELECT substr(created_at,1,10) AS day, event, COUNT(*) AS c
         FROM memory_usage
         WHERE created_at >= datetime('now','-30 days')
         GROUP BY substr(created_at,1,10), event`)
            .all();
        const map = new Map();
        for (const r of rows) {
            if (!map.has(r.day))
                map.set(r.day, { day: r.day, search: 0, write: 0, returned: 0, cited: 0, injected: 0 });
            const d = map.get(r.day);
            // injected（memory_context 自动注入曝光）单列统计，不再混入 returned，保 returned=纯检索命中
            if (r.event === "search" || r.event === "write" || r.event === "returned" || r.event === "cited" || r.event === "injected")
                d[r.event] = Number(r.c);
        }
        const days = [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
        const agg = { search: 0, write: 0, returned: 0, cited: 0, injected: 0 };
        for (const d of days)
            for (const k of ["search", "write", "returned", "cited", "injected"])
                agg[k] += d[k];
        // ★ 真命中率：搜索触发的命中数 returned ÷ 检索调用次数 search（口径修正后才是可信值）
        const hitRate = agg.search > 0 ? agg.returned / agg.search : 0;
        // 检索触发率：search ÷ write；<1 提示"只写不搜"（沉淀>检索，使用侧利用率低）
        const searchTriggerRate = agg.write > 0 ? agg.search / agg.write : 0;
        return {
            today: map.get(today) ?? { day: today, search: 0, write: 0, returned: 0, cited: 0, injected: 0 },
            days30: agg,
            trend: days,
            hitRate,
            hitRateRemark: "检索命中数 returned ÷ 检索调用次数 search（injected 自动注入已剔除）",
            searchTriggerRate,
            searchTriggerRemark: "search ÷ write；<1 表示检索次数少于沉淀次数（只写不搜信号）",
        };
    });
    // —— 治理新鲜度（P2-4）：上次治理时间 + 停摆判定 + trial/active 存量，让"治理停摆"可见 ——
    // 阈值 26h：桌面版 daemon 常驻每小时一轮、CLI 侧计划任务每日一轮，超过即说明这条链路断了
    app.get("/api/daemon-health", async () => {
        const last = db.prepare(`SELECT created_at FROM daemon_log ORDER BY id DESC LIMIT 1`).get();
        const lastRun = last?.created_at ?? null;
        const hours = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 3600000 : null;
        const count = (sql) => db.prepare(sql).get().c;
        return {
            lastRun,
            hoursSince: hours === null ? null : Number(hours.toFixed(1)),
            stale: hours === null || hours > 26,
            pending: {
                trial: count(`SELECT COUNT(*) c FROM memories WHERE status='trial'`),
                active: count(`SELECT COUNT(*) c FROM memories WHERE status='active'`),
            },
            hygiene: loadHygieneConfig(db), // 生效阈值（含可调旋钮），便于排查"为什么 trial 不动"
        };
    });
    /* ★ P1-3 / P1-5：统一健康面（新增，只读、不改变任何既有路由）。
     *  T6 的验收要求「ANALYZE 时间戳 + stat1 行数」可机读 —— 原方案写 /api/health，
     *  但该路由此前不存在（只有 write/usage/daemon-health 三条），故此处补齐。
     *  同时暴露 T14 的查询耗时 p50/p95、慢查询 Top10 与 busy 重试次数。 */
    app.get("/api/health", async () => {
        const pragma = (name) => {
            const row = db.prepare(`PRAGMA ${name}`).get();
            return row ? Object.values(row)[0] : null;
        };
        const pageCount = Number(pragma("page_count")) || 0;
        const freelist = Number(pragma("freelist_count")) || 0;
        const hasStat1 = db.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE name='sqlite_stat1'`).get().c > 0;
        const stat1Rows = hasStat1 ? db.prepare(`SELECT COUNT(*) c FROM sqlite_stat1`).get().c : 0;
        const analyzeTs = readConfig(db, "maintenance.analyze_ts", null);
        const vacuumTs = readConfig(db, "maintenance.vacuum_ts", null);
        const last = db.prepare(`SELECT created_at FROM daemon_log ORDER BY id DESC LIMIT 1`).get();
        const hours = last?.created_at ? (Date.now() - new Date(last.created_at).getTime()) / 3600000 : null;
        return {
            ok: true,
            db: {
                pageCount,
                freelist,
                freelistPct: pageCount ? Number(((freelist / pageCount) * 100).toFixed(1)) : null,
                sizeMb: Number(((pageCount * 4096) / 1048576).toFixed(1)),
                autoVacuum: Number(pragma("auto_vacuum")),
            },
            analyze: {
                ts: analyzeTs,
                stat1Exists: hasStat1,
                stat1Rows,
                fresh: analyzeTs ? (Date.now() - new Date(analyzeTs).getTime()) < 86400000 * 1.5 : false,
            },
            vacuum: { ts: vacuumTs, enabled: String(process.env.MEMORYOS_AUTOVACUUM ?? "") === "1" || readConfig(db, "maintenance.autovacuum", false) === true },
            queries: queryStats(),
            daemon: { lastRun: last?.created_at ?? null, hoursSince: hours === null ? null : Number(hours.toFixed(1)), stale: hours === null || hours > 26 },
        };
    });
}
