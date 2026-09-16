/**
 * MemoryOS v0.1 MCP 协议级冒烟（stdio JSON-RPC）
 * 走完: initialize -> notifications/initialized -> tools/list
 *     -> tools/call memory_write -> tools/call memory_search
 * 验证 "MCP 工具可被 Agent 真实验证调用"（非仅 db 层可用）
 * 用法：node dist/smoke-mcp.js
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

    // ★ P2-6（C-2/C-4）生命周期工具 + fencing + memory_write 版本化（端到端）
    const ta2 = (await send("tools/call", {
        name: "task_assign",
        arguments: { content: "P2-6 生命周期样本：验证 heartbeat/release/block/reopen 与 fencing", assignee: "smoke" },
    }));
    const ta2t = ta2.result?.content?.[0]?.text ?? "";
    const tid2 = (ta2t.match(/#(\d+)/) || [])[1];
    check("P2-6a.task_assign 建立样本任务", !!tid2, JSON.stringify(ta2t.slice(0, 50)));
    const tcl2 = (await send("tools/call", {
        name: "task_claim",
        arguments: { memory_id: Number(tid2), as: "smoke" },
    }));
    const tcl2t = tcl2.result?.content?.[0]?.text ?? "";
    const lease = (tcl2t.match(/lease_token=([0-9a-f]+)/) || [])[1];
    check("P2-6b.task_claim 发放租约锁（lease_token）", !!lease, JSON.stringify(tcl2t.slice(0, 70)));
    const tdnBad = (await send("tools/call", {
        name: "task_done",
        arguments: { memory_id: Number(tid2), conclusion: "伪造租约的完成写", lease_token: "bogus-lock" },
    }));
    const tdnBadt = tdnBad.result?.content?.[0]?.text ?? "";
    check("P2-6c.过期/伪造租约被 fencing 拒绝", tdnBadt.includes("租约已被接管"), JSON.stringify(tdnBadt.slice(0, 60)));
    const thb = (await send("tools/call", {
        name: "task_heartbeat",
        arguments: { memory_id: Number(tid2), as: "smoke" },
    }));
    const thbt = thb.result?.content?.[0]?.text ?? "";
    check("P2-6d.task_heartbeat 续租成功", thbt.includes("续租成功"), JSON.stringify(thbt.slice(0, 60)));
    const tdnOk = (await send("tools/call", {
        name: "task_done",
        arguments: { memory_id: Number(tid2), conclusion: "P2-6 生命周期样本完成", lease_token: lease },
    }));
    const tdnOkt = tdnOk.result?.content?.[0]?.text ?? "";
    check("P2-6e.持有效租约可完成（fencing 不误杀）", tdnOkt.includes("已完成"), JSON.stringify(tdnOkt.slice(0, 60)));
    const trp = (await send("tools/call", {
        name: "task_reopen",
        arguments: { memory_id: Number(tid2), reason: "冒烟：验证重开路径" },
    }));
    const trpt = trp.result?.content?.[0]?.text ?? "";
    check("P2-6f.task_reopen 终态重开（done → in_progress）", trpt.includes("已重开"), JSON.stringify(trpt.slice(0, 60)));
    const trl = (await send("tools/call", {
        name: "task_release",
        arguments: { memory_id: Number(tid2), reason: "冒烟：释放认领" },
    }));
    const trlt = trl.result?.content?.[0]?.text ?? "";
    check("P2-6g.task_release 释放回 pending", trlt.includes("已释放"), JSON.stringify(trlt.slice(0, 60)));
    const tcl3 = (await send("tools/call", {
        name: "task_claim",
        arguments: { memory_id: Number(tid2), as: "smoke", expected_version: 99 },
    }));
    const tcl3t = tcl3.result?.content?.[0]?.text ?? "";
    check("P2-6h.陈旧版本领取被拒（乐观版本 fencing）", tcl3t.includes("版本漂移"), JSON.stringify(tcl3t.slice(0, 70)));
    const tcl4 = (await send("tools/call", {
        name: "task_claim",
        arguments: { memory_id: Number(tid2), as: "smoke" },
    }));
    const tcl4t = tcl4.result?.content?.[0]?.text ?? "";
    check("P2-6i.释放后可重新认领（pending → in_progress）", tcl4t.includes("已认领"), JSON.stringify(tcl4t.slice(0, 60)));
    const tblk = (await send("tools/call", {
        name: "task_block",
        arguments: { memory_id: Number(tid2), reason: "冒烟：验证受阻态" },
    }));
    const tblkt = tblk.result?.content?.[0]?.text ?? "";
    check("P2-6j.task_block 标记受阻（in_progress → blocked）", tblkt.includes("已标记受阻"), JSON.stringify(tblkt.slice(0, 60)));
    const thb2 = (await send("tools/call", {
        name: "task_heartbeat",
        arguments: { memory_id: Number(tid2), as: "smoke" },
    }));
    const thb2t = thb2.result?.content?.[0]?.text ?? "";
    check("P2-6k.受阻态续租被拒（状态守卫）", thb2t.includes("无需续租"), JSON.stringify(thb2t.slice(0, 50)));
    const trl2 = (await send("tools/call", {
        name: "task_release",
        arguments: { memory_id: Number(tid2), reason: "冒烟：受阻态释放应被拒" },
    }));
    const trl2t = trl2.result?.content?.[0]?.text ?? "";
    check("P2-6l.受阻态释放被拒（仅进行中可释放）", trl2t.includes("仅进行中任务可释放"), JSON.stringify(trl2t.slice(0, 60)));
    // C-4：memory_write 版本化（supersedes + version 乐观校验）
    const mw1 = (await send("tools/call", {
        name: "memory_write",
        arguments: { content: "C-4 样本 v1：乐观修订基线", type: "decision", confidence: 0.6, source_task_id: Number(tid2) },
    }));
    const mw1t = mw1.result?.content?.[0]?.text ?? "";
    const mid1 = (mw1t.match(/#(\d+)/) || [])[1];
    const mw2 = (await send("tools/call", {
        name: "memory_write",
        arguments: { content: "C-4 样本 v2：替代 v1 结论", type: "decision", supersedes: Number(mid1), version: 1 },
    }));
    const mw2t = mw2.result?.content?.[0]?.text ?? "";
    check("P2-6m.memory_write 版本化修订（归档旧条 + 因果链）", mw2t.includes("已替代并归档"), JSON.stringify(mw2t.slice(0, 70)));
    const mid2 = (mw2t.match(/#(\d+)/) || [])[1];
    const mw3 = (await send("tools/call", {
        name: "memory_write",
        arguments: { content: "C-4 样本 v3：陈旧版本修订（应被拒）", type: "decision", supersedes: Number(mid2), version: 99 },
    }));
    const mw3t = mw3.result?.content?.[0]?.text ?? "";
    check("P2-6n.陈旧版本修订被拒（乐观版本 fencing）", mw3t.includes("版本漂移"), JSON.stringify(mw3t.slice(0, 70)));
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
