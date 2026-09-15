/**
 * MemoryOS v0.1 MCP 协议级冒烟（stdio JSON-RPC）
 * 走完: initialize -> notifications/initialized -> tools/list
 *     -> tools/call memory_write -> tools/call memory_search
 * 验证 "MCP 工具可被 Agent 真实验证调用"（非仅 db 层可用）
 * 用法：npx tsx src/smoke-mcp.ts
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
const DB_PATH = path.join(process.cwd(), "data", "memory-mcp-smoke.db");
for (const p of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
    try {
        fs.rmSync(p, { force: true });
    }
    catch { }
}
const proc = spawn(process.execPath, [path.join(process.cwd(), "dist", "server.js")], {
    env: {
        ...process.env,
        MEMORY_DB: DB_PATH,
        MEMORY_AGENT: "codex",
        MEMORY_AGENT_FPATH: "C:/Users/zhang/.codex/config.toml",
    },
});
let buf = "";
const responses = {};
let lastId = 0;
const pending = new Map();
function send(method, params) {
    const id = ++lastId;
    return new Promise((resolve) => {
        pending.set(id, { resolve, name: method });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
}
proc.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let msg;
        try {
            msg = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            responses[msg.id] = msg;
            p.resolve(msg);
        }
    }
});
const failed = [];
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed.push(name);
}
try {
    const init = (await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0.1.0" },
    }));
    check("initialize 返回", !!(init.result && init.result.serverInfo), JSON.stringify(init.result?.serverInfo));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const lst = (await send("tools/list", {}));
    const tools = lst.result?.tools ?? [];
    // ★ P0 修复（F16）：原断言 tools.length === 17 且白名单漏 task_supersede（与自身标题「task×4」也矛盾），
    //   且 `&&` 短路使「只改计数」仍然 FAIL。改为：显式期望清单 + 分别报告缺项，避免计数与名单互相掩盖。
    const EXPECT_TOOLS = [
        "memory_write", "memory_search", "memory_read", "memory_context", "memory_projects",
        "memory_cite", "memory_feedback", "memory_report", "memory_health", "memory_ask",
        "task_assign", "task_claim", "task_done", "task_next", "task_supersede",
        "obsidian_import", "obsidian_export", "obsidian_write_note",
    ];
    const missing = EXPECT_TOOLS.filter((n) => !tools.some((t) => t.name === n));
    check(
        `tools/list 记忆/任务/obsidian 工具齐全（必备 ${EXPECT_TOOLS.length} 个全部在列）`,
        missing.length === 0, // ★ 超集断言：不锁死总数——执行面工具上线是增量，精确计数会让套件一上线就变红（F16 病根）
        `count=${tools.length}${missing.length ? " missing=" + missing.join(",") : ""}`,
    );
    const w = (await send("tools/call", {
        name: "memory_write",
        arguments: {
            content: "微信回调时间戳容差需设5分钟（签名校验常因时钟偏差误报超时）",
            type: "experience",
            project: "ecommerce",
        },
    }));
    const wtext = w.result?.content?.[0]?.text ?? "";
    check("tools/call memory_write 返回", wtext.includes("已写入记忆 #1"), JSON.stringify(wtext.slice(0, 60)));
    const s = (await send("tools/call", {
        name: "memory_search",
        arguments: { query: "时间戳", project: "ecommerce" },
    }));
    const stext = s.result?.content?.[0]?.text ?? "";
    check("tools/call memory_search 命中并带 agent=codex", stext.includes("[experience|codex"), JSON.stringify(stext.slice(0, 80)));
    // memory_read：按 id 读完整正文（不受 220 截断）
    const rd = (await send("tools/call", {
        name: "memory_read",
        arguments: { memory_id: 1 },
    }));
    const rdtext = rd.result?.content?.[0]?.text ?? "";
    check("tools/call memory_read 返回完整正文", rdtext.includes("完整正文") && rdtext.includes("微信回调"), JSON.stringify(rdtext.slice(0, 50)));
    // task 交接：assign → claim → done（MVP 协同闭环，真实 MCP 链路）
    const ta = (await send("tools/call", {
        name: "task_assign",
        arguments: { content: "排查 Ozon scope 未开通", assignee: "claude", project: "global" },
    }));
    const tat = ta.result?.content?.[0]?.text ?? "";
    const tid = (tat.match(/#(\d+)/) ?? [])[1];
    check("task_assign 分派并返回任务号", /已分派任务 #\d+/.test(tat) && !!tid, JSON.stringify(tat.slice(0, 60)));
    const tcl = (await send("tools/call", {
        name: "task_claim",
        arguments: { as: "claude", memory_id: Number(tid) },
    }));
    const tclt = tcl.result?.content?.[0]?.text ?? "";
    check("task_claim 认领 claimed", tclt.includes("已认领") && tclt.includes("in_progress by claude"), JSON.stringify(tclt.slice(0, 60)));
    const tdn = (await send("tools/call", {
        name: "task_done",
        arguments: { memory_id: Number(tid), conclusion: "需要向平台申请 order/read scope" },
    }));
    const tdnt = tdn.result?.content?.[0]?.text ?? "";
    check("task_done 完成 done", tdnt.includes("已完成") && tdnt.includes("status=done"), JSON.stringify(tdnt.slice(0, 60)));
    // task_next：依赖拓扑可做集（真实 MCP 链路）
    const tn = (await send("tools/call", {
        name: "task_next",
        arguments: { project: "global" },
    }));
    const tnt = tn.result?.content?.[0]?.text ?? "";
    check("task_next 返回可做/阻塞/在做三段", tnt.includes("可做") && tnt.includes("阻塞") && tnt.includes("我在做"), JSON.stringify(tnt.slice(0, 60)));
    // memory_context：一键注入高价值记忆（步骤3 自动检索注入）
    const cx = (await send("tools/call", {
        name: "memory_context",
        arguments: { project: "ecommerce", limit: 3 },
    }));
    const cxt = cx.result?.content?.[0]?.text ?? "";
    check("tools/call memory_context 注入高价值记忆 + agent 标注", cxt.includes("MemoryContext 注入") && cxt.includes("agent="), JSON.stringify(cxt.slice(0, 60)));
    // memory_context + focus：按任务主题召回（而非全库曝光榜）
    const cxf = (await send("tools/call", {
        name: "memory_context",
        arguments: { project: "ecommerce", limit: 3, focus: "时间戳" },
    }));
    const cxft = cxf.result?.content?.[0]?.text ?? "";
    check("memory_context + focus 按主题召回（命中时间戳记忆 + 标注主题排序）", cxft.includes("时间戳") && cxft.includes("『时间戳』主题相关度排序"), JSON.stringify(cxft.slice(0, 80)));
    // M-1.5/1.6: cite + report 通过 MCP 全链路
    const c = (await send("tools/call", {
        name: "memory_cite",
        arguments: { memory_id: 1, session_id: "S-mcp", task_hint: "smoke" },
    }));
    const ctext = c.result?.content?.[0]?.text ?? "";
    check("tools/call memory_cite 返回", ctext.includes("已 cite 记忆 #1"), JSON.stringify(ctext.slice(0, 60)));
    const r = (await send("tools/call", {
        name: "memory_report",
        arguments: { report: "funnel", project: "ecommerce" },
    }));
    const rtext = r.result?.content?.[0]?.text ?? "";
    check("tools/call memory_report funnel 含 raw_cited 与 inferred_cited 两行", rtext.includes("raw_cited") && rtext.includes("inferred_cited"), JSON.stringify(rtext.slice(0, 80)));
    // memory_feedback：纠错闭环（soft-reject，不进检索）
    const fb = (await send("tools/call", {
        name: "memory_feedback",
        arguments: { memory_id: 1, reason: "smoke: 该结论已过时" },
    }));
    const fbtext = fb.result?.content?.[0]?.text ?? "";
    check("tools/call memory_feedback soft-reject 记忆", fbtext.includes("已标记记忆 #1") && fbtext.includes("rejected"), JSON.stringify(fbtext.slice(0, 50)));
    // memory_health：使用侧健康（P2 效果监控）
    const h = (await send("tools/call", {
        name: "memory_health",
        arguments: { days: 30 },
    }));
    const htext = h.result?.content?.[0]?.text ?? "";
    check("tools/call memory_health 返回触发率/写读比", htext.includes("检索触发率") && htext.includes("写读比"), JSON.stringify(htext.slice(0, 50)));
}
finally {
    proc.stdin.end();
    proc.kill();
    setTimeout(() => {
        for (const p of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
            try {
                fs.rmSync(p, { force: true });
            }
            catch { }
        }
        console.log(failed.length === 0 ? "\n== MCP ALL PASS ==" : `\n== MCP ${failed.length} FAILED ==`);
        process.exit(failed.length === 0 ? 0 : 1);
    }, 200);
}
