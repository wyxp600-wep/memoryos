/**
 * ★ 2026-11-16（R02-05 / M-8）冒烟：重工具端点速率与并发守卫。
 *
 * 覆盖：
 *   A. 单元·速率：窗口内放行 max 次，第 max+1 次拒绝且 retryAfter ≥1
 *   B. 单元·窗口滚动：窗口过后自动恢复
 *   C. 单元·并发：maxConcurrent 占满后新请求拒绝；release 后恢复
 *   D. 单元·主体隔离：agent A 打满不影响 agent B（不同 IP 亦然）
 *   E. 集成·路由判定：规则内 POST /api/exec/stream 被 429；规则外 GET /api/health 连续 100 次全 200
 *   F. 集成·响应口径：429 带 Retry-After 头与 {ok:false,error,retry_after}
 *   G. 集成·看板轮询不受影响：/api/cards/stream 连续 50 次不被限流
 *
 * 用法：node dist/smoke-rate-guard.js（smoke-all 自动发现）
 */
import Fastify from "fastify";
import { createRateGuard, installRateGuard } from "./rate-guard.js";

let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A：速率 ──
{
    const g = createRateGuard([{ name: "t", match: () => true, windowMs: 60_000, max: 3, maxConcurrent: 99 }]);
    const rule = g.rules[0];
    const got = [1, 2, 3].map(() => g.tryAcquire(rule, "k1"));
    const blocked = g.tryAcquire(rule, "k1");
    check("A 窗口内前 3 次放行", got.every((x) => x.ok === true));
    check("A 第 4 次拒绝", blocked.ok === false && blocked.error === "rate-limited", blocked.error);
    check("A retryAfter ≥1", blocked.retryAfter >= 1, `retryAfter=${blocked.retryAfter}`);
}

// ── B：窗口滚动恢复 ──
{
    const g = createRateGuard([{ name: "t", match: () => true, windowMs: 40, max: 1, maxConcurrent: 99 }]);
    const rule = g.rules[0];
    check("B 首次放行", g.tryAcquire(rule, "k").ok === true);
    check("B 立即再取被拒", g.tryAcquire(rule, "k").ok === false);
    await sleep(60);
    check("B 窗口过后恢复", g.tryAcquire(rule, "k").ok === true);
}

// ── C：并发 ──
{
    const g = createRateGuard([{ name: "t", match: () => true, windowMs: 60_000, max: 99, maxConcurrent: 2 }]);
    const rule = g.rules[0];
    const a = g.tryAcquire(rule, "k");
    const b = g.tryAcquire(rule, "k");
    const c = g.tryAcquire(rule, "k");
    check("C 前 2 个并发放行", a.ok && b.ok);
    check("C 第 3 个并发拒绝", c.ok === false && c.error === "too-many-concurrent", c.error);
    a.release();
    const d = g.tryAcquire(rule, "k");
    check("C release 后恢复", d.ok === true);
}

// ── D：主体隔离 ──
{
    const g = createRateGuard([{ name: "t", match: () => true, windowMs: 60_000, max: 1, maxConcurrent: 99 }]);
    const rule = g.rules[0];
    g.tryAcquire(rule, "127.0.0.1|trae");
    const other = g.tryAcquire(rule, "127.0.0.1|codex");
    const otherIp = g.tryAcquire(rule, "10.0.0.2|trae");
    check("D 同 IP 不同 agent 不连坐", other.ok === true);
    check("D 不同 IP 同 agent 不连坐", otherIp.ok === true);
    check("D 同主体仍受限", g.tryAcquire(rule, "127.0.0.1|trae").ok === false);
}

// ── E/F/G：集成到 Fastify ──
{
    const app = Fastify({ logger: false });
    installRateGuard(app);
    app.post("/api/exec/stream", async () => ({ ok: true }));
    app.get("/api/health", async () => ({ ok: true }));
    app.get("/api/cards/stream", async () => ({ ok: true }));
    await app.ready();

    const H = { host: "127.0.0.1:8787", "x-memory-agent": "trae" };
    let last = null;
    for (let i = 0; i < 21; i++) {
        last = await app.inject({ method: "POST", url: "/api/exec/stream", headers: H, payload: {} });
    }
    check("E 第 21 次 POST /api/exec/stream → 429", last.statusCode === 429, `status=${last.statusCode}`);
    check("F 429 带 Retry-After", Boolean(last.headers["retry-after"]), `Retry-After=${last.headers["retry-after"]}`);
    let body = {};
    try { body = JSON.parse(last.body); } catch { /* 非 JSON 即失败 */ }
    check("F 429 响应口径", body.ok === false && body.error === "rate-limited" && body.retry_after >= 1, JSON.stringify(body));

    const otherAgent = await app.inject({ method: "POST", url: "/api/exec/stream", headers: { ...H, "x-memory-agent": "codex" }, payload: {} });
    check("D 集成·另一 agent 不被连坐", otherAgent.statusCode === 200, `status=${otherAgent.statusCode}`);

    let healthOk = 0;
    for (let i = 0; i < 100; i++) {
        const r = await app.inject({ method: "GET", url: "/api/health", headers: H });
        if (r.statusCode === 200) healthOk++;
    }
    check("E 规则外 GET /api/health 100 次全 200", healthOk === 100, `${healthOk}/100`);

    let cardsOk = 0;
    for (let i = 0; i < 50; i++) {
        const r = await app.inject({ method: "GET", url: "/api/cards/stream", headers: H });
        if (r.statusCode === 200) cardsOk++;
    }
    check("G 看板轮询 /api/cards/stream 50 次不被限流", cardsOk === 50, `${cardsOk}/50`);

    await app.close();
}

console.log(`\n== M-8 重工具限流：${failed ? `${failed} FAIL` : "全部 PASS"} ==`);
process.exit(failed ? 1 : 0);
