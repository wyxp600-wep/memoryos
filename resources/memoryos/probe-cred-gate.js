#!/usr/bin/env node
/**
 * MemoryOS — 在制品（2026-09-24）①②③④ 行为探针（提交前实证）
 *
 * 覆盖（对应 dist/server-reg-task.js + dist/dashboard-reg-cards.js 的未提交 diff）：
 *   ②-A  A1 硬模式下 task_done / task_verify 必填 expected_version（fencing）
 *   ③-A  多卡全集合：claim 全集合上锁 / done 全集合清锁 / fencing 全集合拒接管 /
 *         任一卡带 meta.acceptance 即拦 task_done（原单卡 LIMIT 1 会被第 2 张卡绕过）
 *   ④-A  task_done 事件 payload self_verified 标记（无 gate 关闭=自述完成 → 0.02 低档置信）
 *   ①    web 卡面 4 端点 actorCredError（硬模式 kebab actor 无凭据 → 403；软模式零行为变化；
 *         human: 前缀流量豁免；已知取舍：硬模式下「unassigned」哨兵被当 kebab 名 → 无凭据 403）
 *
 * 手法（同 smoke-p26-lifecycle 体例）：
 *   - MCP 侧：stdio 真调 dist/server.js 子进程（软/硬两个环境），另开夹具连接直查临时库（观测落库事实）
 *   - web 侧：buildApp(db)+inject 进程内（不占端口），逐用例切换 process.env.MEMORYOS_A1_ENFORCE
 * 用法：cd resources/memoryos && node probe-cred-gate.js     退出码 0/1
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const WS = fs.mkdtempSync(path.join(os.tmpdir(), "cred-gate-"));
let pass = 0, fail = 0;
const check = (n, ok, detail = "") => { if (ok) { pass++; console.log(`PASS  ${n}${detail ? "  — " + detail : ""}`); } else { fail++; console.log(`FAIL  ${n}${detail ? "  — " + detail : ""}`); } };

/** 起一个 MCP server 子进程（stdio JSON-RPC） */
function mcpServer(envExtra) {
    const DB = path.join(WS, `srv-${Math.random().toString(36).slice(2, 8)}.db`);
    const proc = spawn(process.execPath, [path.join("dist", "server.js")], {
        env: { ...process.env, MEMORY_DB: DB, ...envExtra },
        windowsHide: true,
    });
    let buf = "", id = 0;
    const wait = new Map();
    const send = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
    proc.stdout.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line) continue;
            let m; try { m = JSON.parse(line); } catch { continue; }
            if (m.id && wait.has(m.id)) { const r = wait.get(m.id); wait.delete(m.id); r(m); }
        }
    });
    const text = (resp) => (resp?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    const call = (name, args) => send("tools/call", { name, arguments: args }).then(text);
    const dbFix = () => new DatabaseSync(DB);
    const stop = () => { try { proc.kill(); } catch { /* 已退 */ } };
    async function ready() {
        await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe-cred-gate", version: "1" } });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        await call("memory_projects", {}).catch(() => { });
    }
    return { DB, call, dbFix, stop, ready };
}

/** 给任务造第 2 张 dispatch 卡（复刻 task_assign 建卡 SQL；真实库多卡靠多派发，探针直接落库） */
function fixtureSecondCard(dbFixConn, memoryId, assignee, meta = null) {
    const info = dbFixConn.prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,priority,assignee,meta) VALUES ('default','task','探针多卡夹具','fixture','ready','memory',?,3,?,?)`)
        .run(memoryId, assignee, meta).lastInsertRowid;
    dbFixConn.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'dispatch')`).run(info, memoryId);
    return Number(info);
}
const cardsOf = (dbFixConn, memoryId) => dbFixConn.prepare(`SELECT cm.card_id FROM card_memory cm WHERE cm.memory_id=? AND cm.relation='dispatch'`).all(memoryId).map((r) => dbFixConn.prepare(`SELECT * FROM cards WHERE id=?`).get(r.card_id));
const verOf = (dbFixConn, memoryId) => dbFixConn.prepare(`SELECT version FROM memories WHERE id=?`).get(memoryId).version;

try {
    /* ═══ Part A：MCP 硬模式（MEMORYOS_A1_ENFORCE=1）═══ */
    const hard = mcpServer({ MEMORY_AGENT: "probe-hard", MEMORYOS_A1_ENFORCE: "1" });
    await hard.ready();
    const dbA = hard.dbFix();

    // A1 签发写凭据（硬模式下所有写操作的前置）
    const issueText = await hard.call("memory_credential", { action: "issue", agent: "probe-hard", scope: "write" });
    const CRED = (issueText.match(/：([0-9a-f]+)\s*$/)?.[1]) ?? "";
    check("A1.memory_credential issue 签发出 hex 凭据", /[0-9a-f]{8,}/.test(CRED), issueText.slice(0, 80));

    // A2/A3 任务 #A + 第 2 张 dispatch 卡
    const ta = Number((await hard.call("task_assign", { content: "探针任务 A（多卡全集合租约）", assignee: "probe-hard", project: "global", credential: CRED })).match(/#(\d+)/)?.[1]);
    const secA = fixtureSecondCard(dbA, ta, "probe-hard");
    check("A3.夹具第 2 张 dispatch 卡建好", !!secA, `card#${secA}`);

    // A4 认领 → ③-A 全集合上锁
    const claimText = await hard.call("task_claim", { memory_id: ta, as: "probe-hard", credential: CRED });
    const LOCK = claimText.match(/lease_token=([0-9a-f]{24})/)?.[1] ?? "";
    const cA = cardsOf(dbA, ta);
    check("A4.claim 成功（含 lease_token）", claimText.includes("已认领") && LOCK.length === 24, `task#${ta}`);
    check("③-A.claim 后全集合 2 张卡均 running+同锁", cA.length === 2 && cA.every((c) => c.status === "running" && c.claim_lock === LOCK), cA.map((c) => `#${c.id}:${c.status}:${c.claim_lock ? "lock" : "no"}`).join(" "));
    check("③-A.claim 后全集合租约窗已设", cA.length === 2 && cA.every((c) => c.lease_expires_at != null), cA.map((c) => String(c.lease_expires_at).slice(0, 16)).join(" "));

    // A5 ②-A 负路径：done 缺 expected_version 必拒
    const doneNeg = await hard.call("task_done", { memory_id: ta, conclusion: "探针负路径", credential: CRED });
    check("②-A.done 缺 expected_version 被拒（硬模式）", doneNeg.includes("A1 硬模式") && doneNeg.includes("expected_version"), doneNeg.slice(0, 90));
    const stA5 = dbA.prepare(`SELECT content FROM memories WHERE id=?`).get(ta).content;
    check("②-A.拒绝后状态头仍 in_progress（未误写）", stA5.includes("[status:in_progress]"));

    // A6 ②-A 正路径 + ③-A done 全集合清锁 + ④-A self_verified
    const donePos = await hard.call("task_done", { memory_id: ta, conclusion: "探针正路径", credential: CRED, expected_version: verOf(dbA, ta) });
    check("②-A.done 携 expected_version 成功", donePos.toLowerCase().includes("done") && !donePos.includes("拒绝") && !donePos.includes("必须携带"), donePos.slice(0, 90));
    const cA2 = cardsOf(dbA, ta);
    check("③-A.done 全集合清锁（2 张卡 lock/lease 均 NULL）", cA2.length === 2 && cA2.every((c) => c.claim_lock === null && c.lease_expires_at === null), cA2.map((c) => `#${c.id}:${c.status}`).join(" "));
    const evA = dbA.prepare(`SELECT payload FROM memory_events WHERE memory_id=? AND op='task_done' ORDER BY id DESC LIMIT 1`).get(ta)?.payload ?? "{}";
    check("④-A.done 事件 payload 带 self_verified=true（无 gate=自述完成）", evA.includes('"self_verified":true'), evA.slice(0, 120));

    // A7 ③-A 门控全集合：第 2 张卡带 meta.acceptance → task_done 必拦（原单卡 LIMIT 1 绕过的 C1/S-P8）
    const tc = Number((await hard.call("task_assign", { content: "探针任务 C（验收门全集合）", assignee: "probe-hard", project: "global", credential: CRED })).match(/#(\d+)/)?.[1]);
    fixtureSecondCard(dbA, tc, "probe-hard", JSON.stringify({ acceptance: { preset: "lint-sql" } }));
    await hard.call("task_claim", { memory_id: tc, as: "probe-hard", credential: CRED });
    const doneC = await hard.call("task_done", { memory_id: tc, conclusion: "应被验收门拦", credential: CRED, expected_version: verOf(dbA, tc) });
    check("③-A.任一卡带 meta.acceptance 即拦 task_done", doneC.includes("验收标准") || doneC.includes("gate"), doneC.slice(0, 110));

    // A8 ③-A fencing 全集合：第 2 张卡被「接管」→ 持旧锁 done 必拒
    const td = Number((await hard.call("task_assign", { content: "探针任务 D（fencing 接管）", assignee: "probe-hard", project: "global", credential: CRED })).match(/#(\d+)/)?.[1]);
    const secD = fixtureSecondCard(dbA, td, "probe-hard");
    const claimD = await hard.call("task_claim", { memory_id: td, as: "probe-hard", credential: CRED });
    const LOCKD = claimD.match(/lease_token=([0-9a-f]{24})/)?.[1] ?? "";
    dbA.prepare(`UPDATE cards SET claim_lock=? WHERE id=?`).run("feedfacefeedfacefeedface", secD); // 模拟他方接管第 2 张卡
    const doneD = await hard.call("task_done", { memory_id: td, conclusion: "陈旧锁应拒", credential: CRED, expected_version: verOf(dbA, td), lease_token: LOCKD });
    check("③-A.fencing 全集合：第 2 张卡锁不符 → done 拒绝", doneD.includes("租约已被接管") && doneD.includes(`#${secD}`), doneD.slice(0, 110));

    // A9 task_verify ②-A：release 后 verify 缺 expected_version 必拒；带则过
    await hard.call("task_release", { memory_id: td, reason: "探针释放", credential: CRED });
    const vNeg = await hard.call("task_verify", { memory_id: td, reason: "探针验收（缺版本）", credential: CRED });
    check("②-A.verify 缺 expected_version 被拒（硬模式）", vNeg.includes("A1 硬模式") && vNeg.includes("expected_version"), vNeg.slice(0, 90));
    const vPos = await hard.call("task_verify", { memory_id: td, reason: "探针验收（带版本）：实证完毕", credential: CRED, expected_version: verOf(dbA, td) });
    check("②-A.verify 携 expected_version 成功", vPos.toLowerCase().includes("done") && !vPos.includes("必须携带"), vPos.slice(0, 90));
    hard.stop();
    dbA.close();

    /* ═══ Part B：MCP 软模式回归（向后兼容：无 expected_version/凭据仍可 done）═══ */
    const soft = mcpServer({ MEMORY_AGENT: "probe-soft" });
    await soft.ready();
    const dbB = soft.dbFix();
    const ts = Number((await soft.call("task_assign", { content: "软模式回归任务", assignee: "probe-soft", project: "global" })).match(/#(\d+)/)?.[1]);
    await soft.call("task_claim", { memory_id: ts, as: "probe-soft" });
    const doneSoft = await soft.call("task_done", { memory_id: ts, conclusion: "软模式零行为变化" });
    check("B1.软模式 done 无凭据/无版本仍成功（向后兼容）", doneSoft.toLowerCase().includes("done") && !doneSoft.includes("必须携带"), doneSoft.slice(0, 80));
    soft.stop();
    dbB.close();

    /* ═══ Part C：web 卡面 ①（buildApp 进程内，逐用例切 env）═══ */
    const { openDb } = await import("./dist/db.js");
    const { buildApp } = await import("./dist/dashboard.js");
    const dbw = openDb(path.join(WS, "web.db"));
    const app = buildApp(dbw, { token: "probe-cred-gate-token" });
    const inj = (o) => app.inject({ ...o, headers: { "x-memory-token": "probe-cred-gate-token", ...(o.payload ? { "content-type": "application/json" } : {}) } });
    const newCard = (title, status, assignee, meta) => Number(dbw.prepare(`INSERT INTO cards(board,kind,title,status,assignee,meta) VALUES ('default','task',?,?,?,?)`).run(title, status, assignee, meta).lastInsertRowid);
    const setHard = (on) => { if (on) process.env.MEMORYOS_A1_ENFORCE = "1"; else delete process.env.MEMORYOS_A1_ENFORCE; };
    // C1 软模式基线：kebab actor 无凭据也放行（零行为变化）
    const c1 = newCard("C1 软基线", "ready", null, null);
    const r1 = await inj({ method: "POST", url: `/api/cards/${c1}/claim`, query: { as: "probe-web" } });
    check("①.软模式 web claim kebab actor 无凭据放行", r1.statusCode === 200 && r1.json().ok === true, `status=${r1.statusCode}`);
    // C2 硬模式：kebab actor 无凭据 → 403
    const c2 = newCard("C2 硬 403", "ready", null, null);
    setHard(true);
    const r2 = await inj({ method: "POST", url: `/api/cards/${c2}/claim`, query: { as: "probe-web" } });
    check("①.硬模式 web claim kebab actor 无凭据 403", r2.statusCode === 403 && String(r2.json().error).includes("A1 硬模式"), `status=${r2.statusCode} err=${String(r2.json().error).slice(0, 60)}`);
    // C3 硬模式 + 有效凭据 → 放行
    dbw.prepare(`INSERT INTO agent_credentials(agent,credential,scope,expires_at) VALUES ('probe-web','credweb000000000000000000000000', 'write', strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'))`).run();
    const r3 = await inj({ method: "POST", url: `/api/cards/${c2}/claim`, query: { as: "probe-web", credential: "credweb000000000000000000000000" } });
    check("①.硬模式 web claim 携有效凭据放行", r3.statusCode === 200 && r3.json().ok === true, `status=${r3.statusCode}`);
    // C4 硬模式：human 前缀豁免
    const c4 = newCard("C4 human 豁免", "ready", null, null);
    const r4 = await inj({ method: "POST", url: `/api/cards/${c4}/claim`, query: { as: "human:dashboard" } });
    check("①.硬模式 web claim human: 前缀豁免（非 403）", r4.statusCode !== 403, `status=${r4.statusCode}`);
    // C5 硬模式 heartbeat：kebab 无凭据 403；有凭据 200（卡须 running+assignee 匹配）
    const c5 = newCard("C5 心跳", "running", "probe-web", null);
    dbw.prepare(`UPDATE cards SET claim_lock='cafebabe000000' WHERE id=?`).run(c5);
    const h1 = await inj({ method: "POST", url: `/api/cards/${c5}/heartbeat`, payload: { as: "probe-web" } });
    check("①.硬模式 web heartbeat kebab 无凭据 403", h1.statusCode === 403, `status=${h1.statusCode}`);
    const h2 = await inj({ method: "POST", url: `/api/cards/${c5}/heartbeat`, payload: { as: "probe-web", credential: "credweb000000000000000000000000" } });
    check("①.硬模式 web heartbeat 携凭据 200", h2.statusCode === 200 && h2.json().ok === true, `status=${h2.statusCode}`);
    // C6 已知取舍留证：硬模式下缺省哨兵「unassigned」被 AGENT_NAME_RE 判 kebab → 无凭据 403（A1 语义：身份必须可证明；软模式不受影响）
    const c6 = newCard("C6 哨兵取舍", "ready", null, null);
    const r6 = await inj({ method: "POST", url: `/api/cards/${c6}/claim` }); // 不带 as → actor='unassigned'
    check("①.已知取舍：硬模式缺省哨兵 unassigned 亦 403（留证）", r6.statusCode === 403, `status=${r6.statusCode}`);
    setHard(false);
    dbw.close();
}
catch (e) {
    console.error("探针异常：", e instanceof Error ? e.stack : String(e));
    fail++;
}
console.log(`\n探针结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
