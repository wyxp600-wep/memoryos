/**
 * ★ 2026-11-16（R02-05 / M-8）：重工具/高风险端点速率与并发守卫。
 *
 * 目标：看板是**同源 + 本地**服务，真正的风险不是外部 DDoS，而是
 *   ① 失控的 agent / 脚本在同一分钟内反复拉起执行面（fork 风暴、CLI 配额烧穿）；
 *   ② 长连接（exec 流 / CDP live）泄漏导致并发子进程无限增长。
 * 因此只对「会起子进程 / 出站请求 / 重磁盘 IO」的端点计数，**普通轮询与静态资源零影响**：
 *   · cards / agent-runs / stats / health 等看板轮询不在规则表内，永不 429；
 *   · 规则按「主体 = agent 名（x-memory-agent，缺省回落 IP）」分桶，避免一个 agent 失控连带其他 agent。
 *
 * 响应口径：429 + `Retry-After`（秒）+ `{ok:false,error:"rate-limited"|"too-many-concurrent", retry_after}`。
 * 计数为进程内内存（重启清零）；这是**过载保护**，不是配额系统，不落库、不做跨进程协调。
 */

/** 规则表：bucketName -> { match(pathname), windowMs, max, maxConcurrent }
 *  match 只认**方法 + 路径**，不做参数解析（避免为限流引入额外解析开销）。 */
const RULES = [
    {
        name: "exec",
        match: (m, p) => m === "POST" && (p === "/api/exec/stream" || p === "/api/exec/kill"),
        windowMs: 60_000, max: 20, maxConcurrent: 3,
    },
    {
        name: "agent-exec",
        match: (m, p) => p.startsWith("/api/agent-cards/") && /\/(exec|live)(\/|$)/.test(p),
        windowMs: 60_000, max: 15, maxConcurrent: 3,
    },
    {
        name: "ingest",
        match: (m, p) => m === "POST" && (p === "/api/ingest/run" || p === "/api/ingest/validate-source"),
        windowMs: 60_000, max: 10, maxConcurrent: 2,
    },
    {
        name: "obsidian",
        match: (m, p) => m === "POST" && (p === "/api/obsidian/import" || p === "/api/obsidian/export"),
        windowMs: 60_000, max: 20, maxConcurrent: 2,
    },
    {
        name: "design",
        match: (m, p) => m === "POST" && p.startsWith("/api/design/"),
        windowMs: 60_000, max: 20, maxConcurrent: 2,
    },
    {
        name: "worktrees",
        match: (m, p) => (m === "POST" && p === "/api/worktrees") ||
            (m === "DELETE" && p.startsWith("/api/worktrees/")) ||
            (m === "GET" && p.endsWith("/changes") && p.startsWith("/api/worktrees/")),
        windowMs: 60_000, max: 20, maxConcurrent: 3,
    },
];

/** 进程内桶：bucket -> Map(key -> { winStart, count, inflight }) */
export function createRateGuard(rules = RULES) {
    const buckets = new Map(rules.map((r) => [r.name, new Map()]));
    const KEY_MAX = 512; // 单桶主体上限，超出时清掉已过期窗口，防长时间运行内存漂移

    function sweep(map, now, windowMs) {
        if (map.size <= KEY_MAX) return;
        for (const [k, rec] of map) {
            if (now - rec.winStart >= windowMs && rec.inflight === 0) map.delete(k);
        }
    }

    /** 放行判定：ok=false 时调用方直接 429，**不得**再 acquire 并发。 */
    function tryAcquire(rule, key) {
        const map = buckets.get(rule.name);
        const now = Date.now();
        sweep(map, now, rule.windowMs);
        let rec = map.get(key);
        if (!rec) {
            rec = { winStart: now, count: 0, inflight: 0 };
            map.set(key, rec);
        }
        if (now - rec.winStart >= rule.windowMs) {
            rec.winStart = now;
            rec.count = 0;
        }
        if (rec.count >= rule.max) {
            return { ok: false, error: "rate-limited", retryAfter: Math.max(1, Math.ceil((rec.winStart + rule.windowMs - now) / 1000)) };
        }
        if (rule.maxConcurrent != null && rec.inflight >= rule.maxConcurrent) {
            return { ok: false, error: "too-many-concurrent", retryAfter: 1 };
        }
        rec.count += 1;
        rec.inflight += 1;
        return { ok: true, release: () => { rec.inflight = Math.max(0, rec.inflight - 1); } };
    }

    return { rules, buckets, tryAcquire };
}

/** 主体标识：优先 agent 名（同机多 agent 互不连坐），缺失时回落 IP。 */
function subjectOf(req) {
    const a = String(req.headers["x-memory-agent"] ?? "").trim();
    const ip = String(req.ip || "unknown");
    return a ? `${ip}|${a}` : ip;
}

/** 挂载到 Fastify：onRequest 判定 + reply 生命周期释放并发。 */
export function installRateGuard(app, guard = createRateGuard()) {
    app.addHook("onRequest", async (req, reply) => {
        const pathname = String(req.url ?? "").split("?")[0];
        const rule = guard.rules.find((r) => {
            try { return r.match(String(req.method || "").toUpperCase(), pathname); }
            catch { return false; }
        });
        if (!rule) return;
        const got = guard.tryAcquire(rule, subjectOf(req));
        if (!got.ok) {
            reply.header("Retry-After", String(got.retryAfter));
            return reply.code(429).send({ ok: false, error: got.error, retry_after: got.retryAfter });
        }
        // 无论是正常响应、报错还是客户端中断，都必须归还并发名额（否则一次中断永久占坑）
        let released = false;
        const release = () => { if (!released) { released = true; got.release(); } };
        reply.raw.once("close", release);
        reply.raw.once("finish", release);
    });
}
