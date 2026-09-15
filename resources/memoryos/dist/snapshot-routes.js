#!/usr/bin/env node
/**
 * MemoryOS — 路由响应快照（P2-3 / T8 拆分 buildApp 的**验收前置**）
 *
 * 为什么先做这个：T8 要把 dashboard.js 里 2246 行的 buildApp() 拆成模块，硬要求是
 * 「96 条路由的路径与响应体**逐字节不变**」（报告 §2.A 潜在风险 2）。没有基线就无法证明"没改行为"，
 * 靠人工点测必然漏。本工具把"拆分前"的行为固化成可比对快照，拆分后 `--check` 一条命令判定。
 *
 * 用法（cwd = resources/memoryos）：
 *   node dist/snapshot-routes.js                # 生成快照 → outputs/route-snapshot.json（不碰生产库）
 *   node dist/snapshot-routes.js --check        # 与 outputs/route-snapshot.json 比对，差异即非零退出
 *   node dist/snapshot-routes.js --out <path>   # 指定快照路径
 *
 * 隔离：临时库 + 固定夹具 + 固定令牌；**不使用生产库**。
 * 归一化：剥离易变字段（时间戳/uptime/pid/duration 等）与绝对路径，保证同代码两次运行快照一致。
 * 覆盖：自动发现全部**无参数 GET 路由**（`:` 动态段路由需构造参数据，另行补；见输出清单）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb, writeMemory } from "./db.js";
import { buildApp } from "./dashboard.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const CHECK = argv.includes("--check");
const OUT = path.resolve(ROOT, opt("out", path.join("..", "..", "outputs", "route-snapshot.json")));
const TOKEN = "snapshot-token-fixed";

/* ── 固定夹具（全部确定性：显式给 created_at，避免"同秒并列"以外的抖动） ── */
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "memoryos-snap-"));
const DB = path.join(WS, "snapshot.db");

const normalize = (v) => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            // 易变键：时间类 + 计时统计（T14 查询可观测的 max/p50/p95 每次运行天然抖动）
            if (/^(ts|time|timestamp|uptime|uptimeMs|now|pid|duration|durationMs|elapsed|startedAt|lastRun|max|min|avg|p50|p95|p99|hoursSince)$/i.test(k)) { out[k] = "«volatile»"; continue; }
            out[k] = normalize(val);
        }
        return out;
    }
    if (typeof v === "string") {
        // 时间戳（ISO 与 SQLite `YYYY-MM-DD HH:MM:SS` 两种格式）→ 占位；绝对路径 → 占位
        return v
            .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "«ts»")
            .replace(/\d{4}-\d{2}-\d{2}/g, "«date»")
            .replace(/[A-Za-z]:\\\\?[^\s"']+/g, "«path»")
            .replace(/\/[\w./-]{8,}/g, "«path»");
    }
    return v;
};
const maskVolatile = (obj) => normalize(obj);

const db = openDb(DB);
// 夹具：3 条 active（含 1 条 secret）+ 1 条 archived + 1 条 decision + 1 条任务
const w = (content, extra = {}) => writeMemory(db, {
    content, type: extra.type ?? "experience", agent: extra.agent ?? "snapshot",
    agent_fpath: null, project: extra.project ?? "global", embedding: null, ...extra,
});
const m1 = w("快照夹具 A：端口 80 被 IIS 占用时先查 W3SVC 服务状态");
const m2 = w("快照夹具 B：微信回调时间戳容差需设 5 分钟");
const m3 = w("快照夹具 C:secret 敏感样本（内容不应出现在任何响应里）", { sensitivity: "secret" });
const m4 = w("快照夹具 D：已归档样本", { type: "decision" });
w("[task][assignee:snapshot][status:pending] 快照夹具任务：验证路由快照稳定", { type: "task" });
db.prepare(`UPDATE memories SET status='archived' WHERE id=?`).run(m4.id);
db.prepare(`UPDATE memories SET created_at=datetime('now','-2 days') WHERE id=?`).run(m2.id);
db.prepare(`UPDATE memories SET created_at=datetime('now','-5 days') WHERE id=?`).run(m3.id);
void m1;

const app = buildApp(db, { token: TOKEN });
await app.ready();

/* ── 路由发现：解析 printRoutes({ commonPrefix:false }) 的树形文本 ──
 * 真实格式（Fastify v5 实测）：
 *   └── / (GET, HEAD)
 *       ├── api/summary (GET, HEAD)
 *       └── api/cards (GET, HEAD, POST)
 *           └── /archive (GET, HEAD, POST)      ← 子段带前导 /，父路径需拼接
 * 每层缩进 4 字符（`│   ` / `    `），据缩进还原层级，再按父路径拼接成完整路径。 */
function parseRouteTree(tree) {
    const out = [];
    const stack = [];                       // depth → 完整路径
    for (const line of tree.split("\n")) {
        const m = line.match(/^([│├└─\s]*)(\S.*?)\s*\(([A-Z, ]+)\)\s*$/);
        if (!m) continue;
        const depth = Math.floor(m[1].length / 4);
        const seg = m[2].trim();
        const methods = m[3].split(",").map((s) => s.trim()).filter(Boolean);
        let full;
        if (seg === "/") full = "/";
        else {
            const parent = stack[depth - 1] ?? "/";
            const clean = seg.replace(/^\/+/, "");
            full = parent === "/" ? `/${clean}` : `${parent}/${clean}`;
        }
        stack[depth] = full;
        stack.length = depth + 1;
        for (const method of methods) out.push({ method, path: full });
    }
    return out;
}
const tree = app.printRoutes({ commonPrefix: false });
const routes = parseRouteTree(tree);
const gettable = routes.filter((r) => r.method === "GET" && !r.path.includes(":"));
const dynamic = routes.filter((r) => r.method === "GET" && r.path.includes(":"));
/* ★ 防空转守卫：解析失败会让快照"0 条全一致"从而假绿 —— 低于下限一律判失败 */
const MIN_EXPECTED_GET = 20;
if (gettable.length < MIN_EXPECTED_GET) {
    console.error(`❌ 路由发现异常：仅解析到 ${gettable.length} 条无参 GET 路由（下限 ${MIN_EXPECTED_GET}）—— printRoutes 格式可能变化，勿把空结果当作"一致"。`);
    await app.close();
    try { db.close(); } catch { /* 已关 */ }
    process.exit(1);
}

const snapshot = { token: TOKEN, routes: [], skipped: { dynamic: dynamic.map((r) => r.path), nonGet: routes.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`) } };
for (const r of gettable) {
    const res = await app.inject({ method: "GET", url: r.path, headers: { "x-memory-token": TOKEN } });
    const ct = String(res.headers["content-type"] ?? "");
    let payload = res.body;
    let kind = "text";
    try { payload = maskVolatile(JSON.parse(res.body)); kind = "json"; } catch { /* 非 JSON */ }
    const bodyStr = kind === "json" ? JSON.stringify(payload) : String(payload);
    snapshot.routes.push({
        path: r.path,
        status: res.statusCode,
        contentType: ct.split(";")[0],
        contentLength: Buffer.byteLength(res.body, "utf8"),
        sha256: crypto.createHash("sha256").update(bodyStr).digest("hex").slice(0, 16),
        body: bodyStr.length <= 4000 ? bodyStr : bodyStr.slice(0, 4000) + "«truncated»",
    });
}
// 鉴权面：无令牌应 401（fail-closed 也是行为契约的一部分，纳入快照）
const noTok = await app.inject({ method: "GET", url: "/api/summary" });
snapshot.auth = { noTokenStatus: noTok.statusCode };
await app.close();
try { db.close(); } catch { /* 已关 */ }
try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* Windows 句柄未即时释放 */ }

console.log(`发现路由 ${routes.length} 条：快照 ${gettable.length} 条（无参 GET）｜跳过 动态段 ${dynamic.length} 条、非 GET ${routes.length - gettable.length - dynamic.length} 条`);
console.log(`鉴权契约：无令牌 /api/summary → ${snapshot.auth.noTokenStatus}`);

if (!CHECK) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2), "utf8");
    console.log(`✅ 快照已写入：${OUT}`);
    process.exit(0);
}

/* ── --check：逐条比对 ── */
if (!fs.existsSync(OUT)) { console.log(`❌ 找不到基线快照：${OUT}（先不带 --check 跑一次生成）`); process.exit(1); }
const base = JSON.parse(fs.readFileSync(OUT, "utf8"));
const baseMap = new Map(base.routes.map((r) => [r.path, r]));
const curMap = new Map(snapshot.routes.map((r) => [r.path, r]));
let diff = 0;
for (const [p, b] of baseMap) {
    const c = curMap.get(p);
    if (!c) { console.log(`❌ 路由消失：GET ${p}`); diff++; continue; }
    if (c.status !== b.status) { console.log(`❌ ${p} status ${b.status} → ${c.status}`); diff++; }
    else if (c.sha256 !== b.sha256) { console.log(`❌ ${p} 响应体变化（${b.contentLength}B/${b.sha256} → ${c.contentLength}B/${c.sha256}）`); diff++; }
}
for (const p of curMap.keys()) if (!baseMap.has(p)) { console.log(`❌ 新增路由（需确认是否有意为之）：GET ${p}`); diff++; }
if (snapshot.auth.noTokenStatus !== base.auth.noTokenStatus) { console.log(`❌ 鉴权契约变化：无令牌 ${base.auth.noTokenStatus} → ${snapshot.auth.noTokenStatus}`); diff++; }
console.log(diff ? `\n== 快照比对：${diff} 处差异（拆分必须 0 差异）==` : `\n== 快照比对：${baseMap.size} 条路由逐字节一致 ✅ ==`);
process.exit(diff ? 1 : 0);
