/**
 * WYSIWYG 一致性冒烟：验证「用户侧 /api/all 的 ai.* 视图」与「AI 侧 MCP 真实返回」逐字一致。
 *
 * 用法（在 resources/memoryos 目录下）：
 *   node dist/smoke-wysiwyg.js
 *
 * 流程（临时库，零污染真实数据）：
 *   1) 建临时 DB，spawn dist/server.js（MCP stdio）
 *   2) memory_write 写 3 条：短 / 超 120 字 / 超 220 字（含换行，验证空白折叠）
 *   3) 用同一 DB 起 dashboard app，inject GET /api/all 取每行的 ai.search / ai.context / ai.read
 *   4) 分别调用 memory_search / memory_context / memory_read，逐字比对
 *   5) 额外验证 ai_visible：把一条改为 archived 后，/api/all 的 ai_visible.searchable 应为 false
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { buildApp } from "./dashboard.js";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DB_PATH = path.join(ROOT, "data", "memory-wysiwyg.db");
/** dashboard 访问控制为 fail-closed，冒烟须显式提供令牌（见 ④ 用户侧注释） */
const SMOKE_TOKEN = "smoke-wysiwyg-token";
for (const p of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
    try {
        fs.rmSync(p, { force: true });
    }
    catch { }
}
const failed = [];
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed.push(name);
}
/* ---------- MCP stdio 客户端 ---------- */
const proc = spawn(process.execPath, [path.join(HERE, "server.js")], {
    env: { ...process.env, MEMORY_DB: DB_PATH, MEMORY_AGENT: "wysiwyg" },
});
let buf = "";
const pending = new Map();
let lastId = 0;
function send(method, params) {
    const id = ++lastId;
    return new Promise((resolve) => {
        pending.set(id, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
}
proc.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const t = line.trim();
        if (!t)
            continue;
        let msg;
        try {
            msg = JSON.parse(t);
        }
        catch {
            continue;
        }
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
    }
});
const text = (r) => r?.result?.content?.[0]?.text ?? "";
/** 从 MCP 多行返回里取出 `#id ...` 行，按 id 索引 */
function indexLines(s) {
    const map = new Map();
    for (const line of s.split("\n")) {
        const m = line.match(/^#(\d+)/);
        if (m)
            map.set(Number(m[1]), line);
    }
    return map;
}
// 每条内容都带同一个 ASCII 探针词 zq7x：fake-embed 环境下走纯词法路也能三条全命中（unicode61 可对 ASCII 分词）
const SHORT = "zq7x WYSIWYG 探针 短句 记忆一致性校验。";
const MED = "zq7x WYSIWYG 探针 中等长度：本条正文折叠后应超过 120 字但不超过 220 字，用于验证 memory_context 的裁剪提示。" +
    "补充内容：".repeat(8);
const LONG = "zq7x WYSIWYG 探针 超长：本条正文折叠后远超 220 字，用于验证 memory_search 的裁剪与用户侧 ✂ 提示。\n" +
    "第二段换行应被折叠为单空格。\n" +
    "结论前置：关键结论必须写在开头 220 字内。\n" +
    "填充内容：".repeat(30);
try {
    const init = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wysiwyg-smoke", version: "0.1.0" } });
    check("MCP initialize", !!init.result?.serverInfo);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    // ② 写 3 条（不同语义，避免去重合并）
    for (const c of [SHORT, MED, LONG]) {
        const w = await send("tools/call", { name: "memory_write", arguments: { content: c, type: "experience", project: "global" } });
        check(`memory_write 写入成功（${c.length} 字）`, text(w).includes("已写入记忆 #"), text(w).slice(0, 60));
    }
    // ③ AI 侧真实返回（先跑 MCP：search 会 bump hit_count，故 /api/all 须在其之后取，才能比对同一时刻的 hit 计数）
    const s = await send("tools/call", { name: "memory_search", arguments: { query: "zq7x", project: "global", limit: 10 } });
    const stext = text(s);
    const sLines = indexLines(stext);
    const c1 = await send("tools/call", { name: "memory_context", arguments: { project: "global", limit: 5 } });
    const cLines = indexLines(text(c1));
    const readTexts = new Map();
    for (const id of [1, 2, 3]) {
        const rd = await send("tools/call", { name: "memory_read", arguments: { memory_id: id } });
        readTexts.set(id, text(rd));
    }
    // ④ 用户侧：同库起 dashboard，取 ai.* 视图（此时 hit_count 与上面 MCP 返回同刻）
    const db = openDb(DB_PATH);
    // ★ 2026-09-15 修正：installAccessControl 已 fail-closed（无令牌 503 token-not-configured），
    //   `{token:null}` 不再表示"免校验" —— 冒烟须自带令牌并逐请求带 x-memory-token。
    const app = buildApp(db, { token: SMOKE_TOKEN });
    await app.ready();
    const inject = (opts) => app.inject({ ...opts, headers: { ...(opts.headers ?? {}), "x-memory-token": SMOKE_TOKEN } });
    const res = await inject({ method: "GET", url: "/api/all?limit=100" });
    check("/api/all 返回 200", res.statusCode === 200, `status=${res.statusCode}`);
    const rows = JSON.parse(res.body).rows ?? [];
    check("/api/all 含 ai.* 视图字段", rows.length >= 3 && rows.every((r) => r.ai && r.ai.search && r.ai.context && r.ai.read), `rows=${rows.length}`);
    check("memory_search 命中 3 条", sLines.size >= 3, JSON.stringify(stext.slice(0, 80)));
    check("memory_context 注入 3 条", cLines.size >= 3, JSON.stringify(text(c1).slice(0, 80)));
    // ⑤ 逐条逐字比对
    let okSearch = 0, okContext = 0, okRead = 0;
    for (const r of rows) {
        const aiLine = sLines.get(r.id);
        if (aiLine) {
            const same = aiLine === r.ai.search;
            if (same)
                okSearch++;
            else
                check(`#${r.id} memory_search 逐字一致`, false, `MCP=${JSON.stringify(aiLine.slice(0, 90))} / API=${JSON.stringify(r.ai.search.slice(0, 90))}`);
        }
        const cLine = cLines.get(r.id);
        if (cLine) {
            const same = cLine === r.ai.context;
            if (same)
                okContext++;
            else
                check(`#${r.id} memory_context 逐字一致`, false, `MCP=${JSON.stringify(cLine.slice(0, 90))} / API=${JSON.stringify(r.ai.context.slice(0, 90))}`);
        }
        const rd = readTexts.get(r.id) ?? "";
        if (rd === r.ai.read)
            okRead++;
        else
            check(`#${r.id} memory_read 逐字一致`, false, `MCP=${JSON.stringify(rd.slice(0, 90))} / API=${JSON.stringify(r.ai.read.slice(0, 90))}`);
    }
    check("memory_search：每条用户侧视图 == AI 侧原文", okSearch === Math.min(rows.length, sLines.size) && okSearch >= 3, `${okSearch}/${rows.length}`);
    check("memory_context：每条用户侧视图 == AI 侧原文", okContext === Math.min(rows.length, cLines.size) && okContext >= 3, `${okContext}/${rows.length}`);
    check("memory_read：每条用户侧视图 == AI 侧原文", okRead === rows.length, `${okRead}/${rows.length}`);
    // ⑥ 裁剪规则可视化：长文本应被标记裁剪
    const longRow = rows.find((r) => r.content.includes("超长"));
    check("超长记忆被标记 searchClipped（用户侧可见 ✂）", !!longRow?.ai?.searchClipped && longRow.ai.searchHidden > 0, `normLen=${longRow?.ai?.normLen} hidden=${longRow?.ai?.searchHidden}`);
    const shortRow = rows.find((r) => r.content === SHORT);
    check("短记忆未标记裁剪", shortRow?.ai?.searchClipped === false, `normLen=${shortRow?.ai?.normLen}`);
    // ⑧ 回归：与「改动前 server.js 内联模板」逐字一致（证明抽取 format.js 没改变 AI 侧任何输出）
    const raw = db.prepare(`SELECT id, content, type, agent, project, status, confidence, created_at, hit_count,
        (SELECT COUNT(*) FROM memory_usage u WHERE u.memory_id=memories.id AND u.event='cited' AND u.project=memories.project) cited
        FROM memories`).all();
    const legacySearch = (r) => `#${r.id} [${r.type}|${r.agent}|${r.created_at.slice(0, 10)}](conf=${r.confidence.toFixed(2)}) ${r.content.replace(/\s+/g, " ").slice(0, 220)}`;
    const legacyContext = (r, focus) => `#${r.id} [${r.type}|${r.agent}]${focus ? "" : ` cited=${r.cited} hit=${r.hit_count}`} conf=${r.confidence.toFixed(2)}: ${r.content.replace(/\s+/g, " ").slice(0, 120)}`;
    const legacyRead = (r) => `#${r.id} [${r.type}|${r.agent}|${r.project}] conf=${r.confidence.toFixed(2)} status=${r.status} 创建=${r.created_at.slice(0, 10)}\n完整正文（${r.content.length} 字）：\n${r.content}`;
    let okLegacy = 0;
    for (const r of raw) {
        const v = (await import("./format.js")).aiViews(r);
        if (v.search === legacySearch(r) && v.context === legacyContext(r, false) && v.context_focus === legacyContext(r, true) && v.read === legacyRead(r))
            okLegacy++;
        else
            check(`#${r.id} 与改动前模板输出一致`, false, JSON.stringify(v.search.slice(0, 80)));
    }
    check("回归：AI 侧输出与改动前模板逐字一致（无行为变更）", okLegacy === raw.length, `${okLegacy}/${raw.length}`);
    // ⑨ AI 可见性规则（status/eff 过滤）
    const res2 = await inject({ method: "GET", url: "/api/all?limit=100" });
    const before = JSON.parse(res2.body).rows.find((r) => r.content === SHORT);
    check("active 且 eff>0.15 → searchable=true", before?.ai_visible?.searchable === true, JSON.stringify(before?.ai_visible));
    db.prepare(`UPDATE memories SET status='archived' WHERE id=?`).run(before.id);
    const res3 = await inject({ method: "GET", url: "/api/all?limit=100" });
    const after = JSON.parse(res3.body).rows.find((r) => r.id === before.id);
    check("archived → searchable=false 且给出原因", after?.ai_visible?.searchable === false && /status=archived/.test(after.ai_visible.reason), JSON.stringify(after?.ai_visible));
    await app.close();
}
catch (e) {
    check("冒烟脚本异常", false, String(e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
}
finally {
    try {
        proc.kill();
    }
    catch { }
}
console.log(failed.length ? `\n❌ ${failed.length} 项失败：${failed.join("、")}` : "\n✅ 全部通过：用户侧每一条记忆与 AI 接收到的内容逐字一致");
process.exit(failed.length ? 1 : 0);
