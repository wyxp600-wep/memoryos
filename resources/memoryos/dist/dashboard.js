/**
 * MemoryOS v0.3 — Dashboard（M-2.3）
 * Fastify + 内嵌零构建前端（单 HTML 字符串，无静态资源/无构建）。
 * 监听 127.0.0.1:8787；复用 report.ts 五查询 + db.ts 治理原语。
 * 人工归档走 daemon_log 同一审计通道，operator=`human:dashboard`（14章 v0.3 [3]）。
 * 用法：
 *   node dist/dashboard.js                （默认 8787，MEMORY_DB 指定库）
 *   MEMORY_PORT=9000 node dist/dashboard.js
 * 冒烟：buildApp(db) 交给 smoke-dashboard.ts 用 app.inject() 端到端测试。
 */
import Fastify from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import { openDb, archiveMemory, logUsage, logDaemon, withTx, writeMemory, updateMemory, queryByType, rejectMemory, pendingConflicts, applyArbitration, markMerged, listWorkingMemory, setWorkingMemory, clearWorkingMemory, readMemory } from "./db.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { funnel, trend, topMemories, zombies, crossTool } from "./report.js";
import { buildPlan, loadHygieneConfig, reembedStale } from "./daemon.js";
import { readConfig, writeConfig } from "./db.js";
import { scanAgents, connectGuideFor, applyConnectWrite } from "./scan.js";
import { getSources, ingestAll, loadCustomSpecs, saveCustomSpecs, validateCustomSource, customSourcesPath } from "./ingest.js";
import { syncRules, syncProjectRules, getSyncTargets } from "./sync-rules.js";
import { detectVaults, importVault, exportMemories, vaultStatus, syncNotesIndex, demoteNoteLinks, writeNoteToVault } from "./obsidian-sync.js";
import { getEmbedder, cosine, bufToVec } from "./embed.js";
import { computeStatus, syncSkills, detectSkillTargets } from "./skill-sync.js";
import { createMcpClient, resolveLlm, runAgent, buildSystemPrompt } from "./agent-core.js";
import { protectSecret, unprotectSecret, forgetSecret } from "./secret-store.js";
import { probeEndpoint, normalizeLlmEndpoint, llmConf } from "./llm.js";
import { SECTORS, SECTOR_KEYS } from "./db.js";
const DEFAULT_PORT = 8787;
/** 人工/编辑/新建允许的 type（含规则页 rule） */
const ALLOWED_TYPES = ["decision", "experience", "pitfall", "convention", "rule"];
/* ── 受限模式（终端用户能力收敛）────────────────────────────────
 * 目标：任务由系统计划统一派发、采集地址由系统统一分配，用户不可自行创建/导入/指定。
 * 关闭方式：设环境变量 MEMORY_RESTRICTED=0（仅供开发/管理员调试）。
 * 前端据 /api/summary 下发的 restricted 能力位隐藏入口；此处为真限制（防绕过 UI 直调 API）。 */
const RESTRICTED = process.env.MEMORY_RESTRICTED !== "0";
const RESTRICTED_MSG = {
    taskCreate: "任务由系统计划统一派发，不支持手动创建",
    planImport: "计划导入已关闭，请使用系统提供的计划",
    customSource: "采集地址由系统统一分配，不支持手动指定",
    cardCreate: "卡片由系统计划统一派发，不支持手动创建",
    cardDispatch: "派发由系统调度，不支持手动触发",
    cardLink: "卡片连线由系统管理，不支持手动建立",
    noteCreate: "笔记创建已关闭，仅系统采集",
    cardToMemory: "卡片转记忆已关闭",
};
function restricted(reply, key) {
    return reply.code(403).send({ ok: false, code: "RESTRICTED", error: RESTRICTED_MSG[key] });
}
/** 新版重设计 UI 目录（含 index.html + echarts.min.js），/ 路由即 serve 此目录。
 *  基于 import.meta.url 两级回退解析，避免硬编码用户路径：
 *    1) dist 上一级 memoryos-dashboard-redesign —— 便携包布局（UI 放包根，与热更新同名合并）
 *    2) dist 上两级 memoryos-dashboard-redesign —— 开发布局（dist 在 memoryos/ 下，UI 在项目根） */
function resolveUiDir() {
    for (const rel of ["../memoryos-dashboard-redesign", "../../memoryos-dashboard-redesign"]) {
        const dir = fileURLToPath(new URL(rel, import.meta.url));
        if (fs.existsSync(path.join(dir, "index.html")))
            return dir;
    }
    return fileURLToPath(new URL("../../memoryos-dashboard-redesign", import.meta.url));
}
const UI_DIR = resolveUiDir();
/** 计划文件目录（plan.schema.json + plan-*.json）。与 UI 同源解析：dist 上一级 plans */
function resolvePlansDir() {
    for (const rel of ["../plans", "../../plans"]) {
        const dir = fileURLToPath(new URL(rel, import.meta.url));
        if (fs.existsSync(path.join(dir, "plan.schema.json")))
            return dir;
    }
    return fileURLToPath(new URL("../plans", import.meta.url));
}
const PLANS_DIR = resolvePlansDir();
/** loopback 主机白名单（比对时去掉端口）：防 DNS rebinding 把外部域名解析到 127.0.0.1 后直连本机 API */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TOKEN_COOKIE = "memoryos_token";
/** 令牌文件名（与库同目录）：CLI 启动时自动生成/读取 */
export const TOKEN_FILE = "token";
/** 安全响应头（P1-2）：脚本仅同源（页面无内联脚本）；样式放行内联与现有字体域；禁止 object/base 劫持与 iframe 嵌套 */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://miaoda.feishu.cn; " +
    "font-src 'self' data: https://miaoda.feishu.cn; img-src 'self' data: blob:; connect-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
/**
 * 访问控制（P1-2）三段：
 *  ① Host 白名单 —— Host 去端口后必须属于 loopback（防 DNS rebinding）
 *  ② 令牌校验 —— ?token= / x-memory-token / cookie 三者任一命中即放行；首次带 ?token= 访问自动种 cookie，
 *     前端无需改动即可让后续同源请求带凭据
 *  ③ 安全响应头 —— CSP + nosniff + no-referrer
 */
function installAccessControl(app, token) {
    /** ★ 2026-09-15（P-4171）：常数时间令牌比较。原 `===` 有长度/早期退出侧信道；
     *  先 sha256 摘要再 timingSafeEqual —— 摘要恒定 32B，消除长度侧信道。 */
    const safeEqual = (a, b) => {
        const ha = createHash("sha256").update(String(a ?? "")).digest();
        const hb = createHash("sha256").update(String(b ?? "")).digest();
        return timingSafeEqual(ha, hb);
    };
    app.addHook("onRequest", async (req, reply) => {
        const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
        if (!LOOPBACK_HOSTS.has(host)) {
            return reply.code(403).send({ ok: false, error: "forbidden-host" });
        }
        // fail-closed（P0-2.2）：无令牌配置时拒绝，而非放行。
        // 原实现 `if (!token) return;` 会在 token 为空时让全部 13 个写路由裸奔——
        // startDashboard 虽有自举生成，但 buildApp 被其他入口调用时无此保证。
        if (!token) {
            return reply
                .code(503)
                .send({ ok: false, error: "token-not-configured", hint: "设置 MEMORY_TOKEN 或确保 data/token 存在后重启" });
        }
        const url = String(req.url ?? "");
        const fromQuery = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "").get("token");
        const cookie = String(req.headers.cookie ?? "");
        const fromCookie = cookie
            .split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith(TOKEN_COOKIE + "="))
            ?.slice(TOKEN_COOKIE.length + 1);
        const ok = safeEqual(fromQuery, token) || safeEqual(String(req.headers["x-memory-token"] ?? ""), token) || safeEqual(fromCookie, token);
        if (!ok) {
            return reply.code(401).send({ ok: false, error: "unauthorized", hint: "需带 ?token=<令牌> 访问；令牌见 data/token" });
        }
        if (safeEqual(fromQuery, token)) {
            reply.header("set-cookie", `${TOKEN_COOKIE}=${token}; Path=/; SameSite=Strict; HttpOnly; Max-Age=31536000`);
        }
    });
    app.addHook("onSend", async (_req, reply, payload) => {
        reply.header("Content-Security-Policy", CSP);
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Referrer-Policy", "no-referrer");
        return payload;
    });
}
/* ── 设置面板：config.json（userData）读写 ─────────────────────────────
 * 与 desktop 壳 core-process 共用同一配置文件（AppData/Roaming/MemoryOS/config.json）。
 * 数据目录：优先 MEMORYOS_DATA_DIR，否则由 MEMORY_DB "…/data/memory.db" 反推。 */
function dataDirOf() {
    if (process.env.MEMORYOS_DATA_DIR)
        return process.env.MEMORYOS_DATA_DIR;
    const db = process.env.MEMORY_DB;
    return db ? path.dirname(path.dirname(db)) : "";
}
function configFilePath() {
    return dataDirOf() ? path.join(dataDirOf(), "config.json") : "";
}
function readDiskConfig() {
    const f = configFilePath();
    if (!f)
        return {};
    try {
        return JSON.parse(fs.readFileSync(f, "utf8"));
    }
    catch {
        return {};
    }
}
function writeDiskConfig(cfg) {
    const f = configFilePath();
    if (!f)
        return;
    fs.mkdirSync(dataDirOf(), { recursive: true });
    // ★ 2026-09-15（P-4171 落地补齐）：明文 llmKey 绝不落盘，改为落 DPAPI 密文 llmKeyEnc
    // （secret-store.js，用户作用域加密，只有同一 Windows 用户能解）。原实现只是把 llmKey 剥掉，
    // 却没有替代存储 → 密钥保存即丢失、云端 LLM 在设置页根本配不起来。
    const { llmKey, ...safe } = cfg;
    fs.writeFileSync(f, JSON.stringify(safe, null, 2), "utf8");
}
/* ── Agent 的 MCP 客户端（模块级单例：一个 dashboard 进程 = 一个 MCP 子进程）──
 * 惰性拉起：首次用到 agent 端点时才 spawn，避免拖慢 dashboard 启动。
 * smoke-dashboard 等会多次调用 buildApp —— 放模块级可避免重复 spawn 与 exit 监听堆积。 */
let _agentMcp = null;
async function getAgentMcp() {
    if (!_agentMcp) {
        _agentMcp = await createMcpClient({
            agentName: "dashboard-agent",
            agentFpath: fileURLToPath(new URL("./dashboard.js", import.meta.url)),
        });
    }
    return _agentMcp;
}
// dashboard 退出时收掉 MCP 子进程（stdio 子进程随父进程 stdin EOF 退出，这里是显式兜底）
process.once("exit", () => { try { _agentMcp?.close(); } catch { /* 已断 */ } _agentMcp = null; });
export function buildApp(db, opts = {}) {
    const app = Fastify({ logger: false });
    installAccessControl(app, opts.token ?? process.env.MEMORY_TOKEN ?? null);
    // 本机 Dashboard，仅 loopback，禁用默认错误体（避免泄漏路径）
    app.setNotFoundHandler((_req, reply) => reply.type("text/html; charset=utf-8").code(404).send("Not Found"));
    // —— 概览：status 分布 + 总条数 + 类别分布 + secret 计数（R4：H4 仅计数不含内容）——
    app.get("/api/summary", async () => {
        const statusRows = db
            .prepare(`SELECT status, COUNT(*) c FROM memories GROUP BY status ORDER BY c DESC`)
            .all();
        const total = statusRows.reduce((s, r) => s + r.c, 0);
        const effMin = db.prepare(`SELECT MIN(eff_confidence) m FROM memories WHERE status='active'`).get().m;
        // ★ P3：类别分布（9 类，缺省补 0）+ secret 计数（仅计数）
        const sectorRows = db
            .prepare(`SELECT sector, COUNT(*) c FROM memories GROUP BY sector`)
            .all();
        const sectorMap = new Map(sectorRows.map((r) => [r.sector, r.c]));
        const sector_distribution = SECTOR_KEYS.map((k) => ({ sector: k, count: sectorMap.get(k) ?? 0 }));
        const secret_count = Number(db.prepare(`SELECT COUNT(*) c FROM memories WHERE sensitivity='secret'`).get().c);
        return {
            total,
            statusRows,
            minActiveEff: effMin,
            sector_distribution,
            secret_count,
            // 受限能力位：前端据此隐藏入口（单一信源，避免前后端限制漂移）
            restricted: {
                enabled: RESTRICTED,
                taskCreate: RESTRICTED,
                planImport: RESTRICTED,
                customSource: RESTRICTED,
                // ★ M8（R4 裁决）：能力位 +6。cardComment 受限时可评论（只读板 + 自认领卡可流转）
                cardCreate: RESTRICTED,
                cardDispatch: RESTRICTED,
                cardComment: !RESTRICTED,
                cardLink: RESTRICTED,
                noteCreate: RESTRICTED,
                cardToMemory: RESTRICTED,
                // ★ 2026-09-15：Agent 页写门禁能力位（受限模式 → agent 仅只读，前端隐藏「允许写入」勾选）
                agentWrite: RESTRICTED,
            },
        };
    });
    // —— 设置面板：config.json 读 / 写（LLM、受限模式、数据目录、端口、状态）——
    app.get("/api/config", async () => {
        const cfg = readDiskConfig();
        const dbPath = process.env.MEMORY_DB ?? "";
        const port = Number(process.env.MEMORY_PORT ?? DEFAULT_PORT);
        const _dh = db.prepare(`SELECT created_at FROM daemon_log ORDER BY id DESC LIMIT 1`).get();
        const _hrs = _dh && _dh.created_at ? (Date.now() - new Date(_dh.created_at).getTime()) / 3600000 : null;
        return {
            llmUrl: String(cfg.llmUrl ?? ""),
            llmModel: String(cfg.llmModel ?? process.env.INGEST_MODEL ?? ""),
            // ★ 2026-09-15：密钥状态改为反映**真实可用的来源**（原实现取 cfg.llmKey，而它从不落盘 → 永远 false）
            llmKeySet: !!(cfg.llmKeyEnc || process.env.LLM_API_KEY || process.env.INGEST_KEY),
            llmKeySource: cfg.llmKeyEnc ? "encrypted" : (process.env.LLM_API_KEY ? "env(LLM_API_KEY)" : (process.env.INGEST_KEY ? "env(INGEST_KEY)" : "none")),
            llmEffective: await (async () => {
                const c = await llmConf();
                return { url: c.url, model: c.model, source: c.source, keySource: c.keySource };
            })(),
            restricted: cfg.restricted === true,
            restrictedActive: RESTRICTED,
            port,
            dataDir: dataDirOf(),
            dbPath,
            dbName: dbPath ? path.basename(dbPath) : "memory.db",
            // 真实状态：查询 daemon_log 最近运行时间
            processAlive: _hrs === null || _hrs > 26 ? false : true,
            daemonStale: _hrs === null || _hrs > 26,
            hoursSince: _hrs !== null ? Number(_hrs.toFixed(1)) : null,
        };
    });
    app.post("/api/config", async (req, reply) => {
        const b = (req.body ?? {});
        const cfg = readDiskConfig();
        let llmTouched = false;
        if (b.llmUrl !== undefined) {
            const v = String(b.llmUrl ?? "").trim();
            if (v)
                cfg.llmUrl = v;
            else
                delete cfg.llmUrl;
            llmTouched = true;
        }
        if (b.llmModel !== undefined) {
            const v = String(b.llmModel ?? "").trim();
            if (v)
                cfg.llmModel = v;
            else
                delete cfg.llmModel;
            llmTouched = true;
        }
        // ★ 2026-09-15：密钥改为 DPAPI 密文落盘（llmKeyEnc）；明文只存在于请求内，不落盘。
        if (b.clearLlmKey === true) {
            delete cfg.llmKeyEnc;
            delete cfg.llmKey;
            forgetSecret();
            llmTouched = true;
        }
        else if (typeof b.llmKey === "string" && b.llmKey.trim()) {
            const enc = await protectSecret(b.llmKey.trim());
            if (!enc.ok)
                return reply.code(500).send({ ok: false, error: `密钥加密失败，未保存：${enc.error}`, hint: "可改用环境变量 LLM_API_KEY 注入密钥" });
            cfg.llmKeyEnc = enc.blob;
            delete cfg.llmKey;
            llmTouched = true;
        }
        const restrictedChanged = typeof b.restricted === "boolean" && b.restricted !== (cfg.restricted === true);
        if (typeof b.restricted === "boolean")
            cfg.restricted = b.restricted;
        try {
            writeDiskConfig(cfg);
            // LLM 配置现已「现读」（llm.js llmConf / agent-core resolveLlm 都每次读 config.json）→ 即时生效
            // 只有受限模式这类启动期环境变量仍需要重启内核重新注入。
            return {
                ok: true,
                restartRequired: restrictedChanged,
                llmEffective: llmTouched ? "saved" : undefined,
                note: restrictedChanged
                    ? "已保存：LLM 配置即时生效；受限模式切换需重启内核"
                    : "已保存，即时生效（无需重启内核）",
            };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: "写入 config.json 失败：" + (e instanceof Error ? e.message : String(e)) });
        }
    });
    /** 设置页「测试连接」：用**表单里还没保存的值**真发一次 max_tokens=1 请求，定位是 URL/密钥/模型哪一步不对 */
    app.post("/api/config/test-llm", async (req) => {
        const b = (req.body ?? {});
        const cfg = readDiskConfig();
        const saved = await llmConf();
        const url = normalizeLlmEndpoint(String(b.llmUrl ?? "").trim() || cfg.llmUrl || saved.url);
        const model = String(b.llmModel ?? "").trim() || cfg.llmModel || saved.model;
        // 表单没填密钥 → 用已保存的（env 或解密）
        let key = String(b.llmKey ?? "").trim();
        if (!key)
            key = saved.key;
        return probeEndpoint({ url, model, key }, Number(b.timeoutMs) || 15000);
    });
    // —— 记忆卫生建议（只读，不落库）：治理阈值 + 去重/归档候选，供前端"建议→人工确认"环 ——
    app.get("/api/hygiene/suggestions", async () => {
        const config = loadHygieneConfig(db);
        const plan = buildPlan(db); // buildPlan 纯计算，不写库，安全
        const ids = [
            ...new Set([...plan.dedupes.flatMap((d) => [d.winner, d.loser]), ...plan.archives.map((a) => a.id)]),
        ];
        const contentMap = new Map();
        if (ids.length) {
            const ph = ids.map(() => "?").join(",");
            const rows = db
                .prepare(`SELECT id, content, type FROM memories WHERE id IN (${ph})`)
                .all(...ids);
            rows.forEach((r) => contentMap.set(Number(r.id), { content: r.content, type: r.type }));
        }
        return {
            config,
            dedupeSuggestions: plan.dedupes.map((d) => ({
                winner: d.winner,
                loser: d.loser,
                sim: d.sim,
                crossSource: d.crossSource,
                winnerSnippet: contentMap.get(d.winner)?.content ?? null,
                loserSnippet: contentMap.get(d.loser)?.content ?? null,
            })),
            archiveSuggestions: plan.archives.map((a) => ({
                id: a.id,
                type: a.type,
                eff: a.eff,
                reason: a.reason,
                daysSinceExposure: a.daysSinceExposure,
                snippet: contentMap.get(a.id)?.content ?? null,
            })),
        };
    });
    // —— 记忆卫生「人工确认」：仅应用用户勾选的建议项（单事务，逐条留痕，不碰全量 applyPlan）——
    app.post("/api/hygiene/apply", async (req, reply) => {
        const archiveIds = (req.body?.archiveIds ?? []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
        const merges = (req.body?.merges ?? []).filter((m) => Number.isFinite(Number(m.winner)) && Number.isFinite(Number(m.loser)) && m.winner > 0 && m.loser > 0).map((m) => ({ winner: Number(m.winner), loser: Number(m.loser) }));
        if (!archiveIds.length && !merges.length) {
            return reply.code(400).send({ ok: false, error: "请至少选择一项" });
        }
        try {
            let archived = 0;
            let merged = 0;
            withTx(db, () => {
                for (const id of archiveIds) {
                    // 归档前检：仅 active 才动，避免重复/已不存在项
                    const row = db.prepare(`SELECT status FROM memories WHERE id=?`).get(id);
                    if (!row || row.status !== "active")
                        continue;
                    archiveMemory(db, id);
                    logDaemon(db, { task: "manual-archive", op: "archive", memory_id: id, operator: "human:dashboard", detail: "记忆卫生·人工归档" });
                    archived++;
                }
                for (const m of merges) {
                    const lr = db.prepare(`SELECT status FROM memories WHERE id=?`).get(m.loser);
                    if (!lr || lr.status !== "active")
                        continue;
                    markMerged(db, m.loser, m.winner);
                    logDaemon(db, { task: "dedupe", op: "merge", memory_id: m.loser, operator: "human:dashboard", detail: `记忆卫生·人工合并 → #${m.winner}` });
                    merged++;
                }
            });
            return { ok: true, archived, merged };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e) });
        }
    });
    // —— 复用周报五查询（仅 active 过滤已内置于 top/zombies）——
    app.get("/api/funnel", async () => funnel(db, {}));
    app.get("/api/trend", async (req) => trend(db, { days: req.query.days ? Number(req.query.days) : 14 }));
    app.get("/api/top", async (req) => topMemories(db, { limit: req.query.limit ? Number(req.query.limit) : 10 }));
    app.get("/api/zombies", async (req) => zombies(db, {
        days: req.query.days ? Number(req.query.days) : 30,
        limit: req.query.limit ? Number(req.query.limit) : 20,
    }));
    app.get("/api/cross-tool", async (req) => crossTool(db, { limit: req.query.limit ? Number(req.query.limit) : 20 }));
    // —— 仲裁队列：pending-conflict 列表（含旧记忆内容） ——
    app.get("/api/conflicts", async () => {
        const conflicts = pendingConflicts(db);
        return { count: conflicts.length, items: conflicts.map((c) => ({
                id: c.pending.id,
                type: c.pending.type,
                agent: c.pending.agent,
                content: c.pending.content,
                confidence: c.pending.confidence,
                eff: c.pending.eff_confidence ?? c.pending.confidence,
                hits: c.pending.hit_count,
                created_at: c.pending.created_at,
                conflict_with: c.pending.conflict_with,
                old_id: c.old?.id ?? null,
                old_content: c.old?.content ?? null,
                old_type: c.old?.type ?? null,
            })) };
    });
    // —— 仲裁操作：key=1保留新/2保留旧/3合并/4不冲突 ——
    app.post("/api/conflict/:id", async (req, reply) => {
        const id = Number(req.params.id);
        const key = req.body?.key;
        if (!Number.isFinite(id) || id <= 0)
            return reply.code(400).send({ ok: false, error: "id 非法" });
        if (!["1", "2", "3", "4"].includes(key))
            return reply.code(400).send({ ok: false, error: "key 非法，必须为 1/2/3/4" });
        try {
            const result = applyArbitration(db, id, key);
            logDaemon(db, { task: "arbitrate", op: key, memory_id: id, operator: "human:dashboard", detail: result });
            return { ok: true, result };
        }
        catch (e) {
            return reply.code(400).send({ ok: false, error: String(e) });
        }
    });
    // —— 人工归档：ids 批量置 archived，审计 operator=human:dashboard（单事务） ——
    app.post("/api/archive", async (req, reply) => {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
        if (!ids.length)
            return reply.code(400).send({ ok: false, error: "ids 为空或非法" });
        let archived = 0;
        try {
            withTx(db, () => {
                for (const id of ids) {
                    archiveMemory(db, id);
                    logDaemon(db, { task: "manual-archive", op: "archive", memory_id: id, operator: "human:dashboard", detail: "Dashboard 人工归档" });
                    archived++;
                }
            });
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: String(e) });
        }
        return { ok: true, archived };
    });
    // —— 新建记忆：human 手动写入（agent=human:dashboard，审计留痕；自动生成向量进语义路） ——
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
        logDaemon(db, { task: "manual-edit", op: "edit", memory_id: row.id, operator: "human:dashboard", detail: "Dashboard 手动编辑记忆" });
        return { ok: true, id: row.id };
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
        if (!(db.prepare(`SELECT id FROM memories WHERE id=?`).get(id)))
            return reply.code(404).send({ ok: false, error: "记忆不存在" });
        rejectMemory(db, id, "human:dashboard");
        return { ok: true, id };
    });
    // —— 规则列表：type='rule'，默认只列 active（删除即消失，审计留痕另查） ——
    app.get("/api/rules", async (req) => {
        const limit = Number(req.query.limit ?? 500) || 500;
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
        }));
        return { total: rows.length, rows };
    });
    // —— 任务看板：解码 type='task' 记忆约定头 → 结构化七态（v1.1 状态机：多 Agent 协同可视化）——
    // 解码与 server.ts taskHead 同源：`[task][assignee:X][status:<七态>]`；存量 open/claimed/done 归一
    const TASK_HEAD_RE_STATES = "pending|in_progress|blocked|review|done|failed|cancelled";
    const TASK_HEAD_RE = new RegExp(`^\\[task\\]\\[assignee:[^\\]]*\\]\\[status:(${TASK_HEAD_RE_STATES}|open|claimed)\\]`);
    const TASK_NORMALIZE = { open: "pending", claimed: "in_progress", done: "done" };
    const TASK_DEP_RE = /\[depends:([0-9,\s]+)\]/;
    const TASK_BUCKETS = ["pending", "in_progress", "blocked", "review", "done", "failed", "cancelled"];
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
            .all(...(status ? [status, limit] : [limit])).map((r) => ({
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
        }));
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
    // —— Obsidian 同步：vault 探测 / 状态 / 导入 / 导出（复用 obsidian-sync.ts，逻辑不重写）——
    app.get("/api/obsidian/vaults", async () => ({ vaults: detectVaults() }));
    app.get("/api/obsidian/status", async (req, reply) => {
        const vault = req.query.vault;
        if (!vault)
            return reply.code(400).send({ error: "vault 参数必填" });
        try {
            const s = vaultStatus(db, vault);
            const imported = db
                .prepare(`SELECT note_path, memory_id, substr(note_hash,1,8) AS note_hash, mtime_ms, created_at FROM obsidian_sync WHERE vault_root=? ORDER BY created_at DESC LIMIT 200`)
                .all(path.resolve(vault));
            return { ...s, imported };
        }
        catch (e) {
            return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/api/obsidian/import", async (req, reply) => {
        const vault = req.body.vault;
        if (!vault)
            return reply.code(400).send({ ok: false, error: "vault 必填" });
        try {
            const embedder = await getEmbedder();
            const stats = await importVault(db, embedder, {
                vaultPath: vault,
                project: req.body.project,
                dryRun: !!req.body.dry_run,
                agent: "obsidian",
            });
            return { ok: true, stats };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
    app.post("/api/obsidian/export", async (req, reply) => {
        const vault = req.body.vault;
        if (!vault)
            return reply.code(400).send({ ok: false, error: "vault 必填" });
        try {
            const stats = exportMemories(db, {
                vaultPath: vault,
                project: req.body.project,
                type: req.body.type,
                limit: req.body.limit,
            });
            return { ok: true, stats };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
    // —— 技能同步：中央库状态 / 一键分发（复用 skill-sync.ts，纯文件操作不依赖 db）——
    app.get("/api/skills/status", async () => ({ ...computeStatus(), detected: detectSkillTargets() }));
    app.post("/api/skills/sync", async (req, reply) => {
        try {
            const results = syncSkills(!!req.body.dry_run);
            return { ok: true, dry_run: !!req.body.dry_run, results };
        }
        catch (e) {
            return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
    });
    // —— 新版重设计 UI：/ 与 /echarts.min.js（读取文件，同源 /api/* 免 CORS；no-store 防缓存旧版）——
    app.get("/", async (_req, reply) => reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8")));
    app.get("/echarts.min.js", async (_req, reply) => reply.type("application/javascript").send(fs.readFileSync(path.join(UI_DIR, "echarts.min.js"))));
    app.get("/app.js", async (_req, reply) => reply.header("Cache-Control", "no-store").type("application/javascript").send(fs.readFileSync(path.join(UI_DIR, "app.js"), "utf8")));
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
            _agentMcp = null; // 拉起失败不缓存坏句柄，下次请求重试
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
            _agentMcp = null;
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
    return app;
}
// —— CLI：严格比对入口文件（pathToFileURL 全等），避免被 smoke-dashboard 等 import 时误触发真实监听 ——
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const dbPath = process.env.MEMORY_DB ?? fileURLToPath(new URL("../data/memory.db", import.meta.url)); // fileURLToPath 正确 decode 中文路径
    const db = openDb(dbPath);
    // 访问令牌：env MEMORY_TOKEN 优先；否则读 data/token，仍无则生成并落盘（首启自举，保证 CLI 启动同样受控）
    const tokenFile = path.join(path.dirname(dbPath), TOKEN_FILE);
    let token = process.env.MEMORY_TOKEN ?? "";
    if (!token) {
        try {
            token = fs.readFileSync(tokenFile, "utf8").trim();
        }
        catch { /* 文件不存在 → 下面生成 */ }
    }
    if (!token) {
        token = randomBytes(24).toString("hex");
        try {
            fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
            fs.writeFileSync(tokenFile, token, { encoding: "utf8", mode: 0o600 });
        }
        catch (e) {
            console.warn(`[dashboard] 令牌落盘失败（鉴权仍生效）：${e instanceof Error ? e.message : String(e)}`);
        }
    }
    const app = buildApp(db, { token });
    const host = "127.0.0.1";
    const port = Number(process.env.MEMORY_PORT ?? DEFAULT_PORT);
    app
        .listen({ host, port })
        .then(() => console.log(`MemoryOS Dashboard: http://${host}:${port}/  （访问令牌不在 URL/日志中打印；令牌见 ${tokenFile}）`));
}
