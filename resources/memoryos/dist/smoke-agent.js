/**
 * smoke-agent.js — MemoryOS Agent 冒烟
 *  ① LLM 端点工具调用直测（qwen3:8b / 任意 OpenAI 兼容，--llm-url/--llm-model 覆盖）
 *  ② MCP 客户端连通 + tools/list（22 工具）
 *  ③ 只读 agent 单轮（memory_context 注入，不触发写门禁）
 * 用法：node dist/smoke-agent.js [--llm-url U --llm-model M]
 */
import { createMcpClient, resolveLlm, callLlm, mcpToolsToOpenai, runAgent, buildSystemPrompt } from "./agent-core.js";

const extra = process.argv.slice(2);
function opt(name) {
    const i = extra.indexOf(name);
    return i >= 0 ? extra[i + 1] : undefined;
}
const llm = resolveLlm({
    baseUrl: opt("--llm-url"),
    model: opt("--llm-model"),
    apiKey: opt("--llm-key"),
});
let failed = 0;
const ok = (name, cond, detail = "") => {
    console.log(`${cond ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
    if (!cond) failed++;
};

// ① LLM 工具调用直测
{
    const tools = mcpToolsToOpenai([{
        name: "get_temp",
        description: "查询某城市当前温度（°C）",
        inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    }]);
    const t0 = Date.now();
    let msg = null, err = null;
    try {
        const r = await callLlm(llm, [
            { role: "system", content: "你是最小工具调用测试器。用户报城市就调用 get_temp，不要闲聊。" },
            { role: "user", content: "北京现在几度？" },
        ], tools);
        msg = r.msg; // callLlm 现返回 {msg, usage}（A5：透传 token 用量）
    } catch (e) { err = e; }
    const tcs = msg?.tool_calls || [];
    ok("LLM 端点可达", !err, err ? String(err.message).slice(0, 120) : `${(Date.now() - t0) / 1000}s`);
    ok("LLM 发起工具调用", tcs.length === 1 && tcs[0].function.name === "get_temp",
        tcs.length ? `tool_calls=${JSON.stringify(tcs.map((t) => t.function)).slice(0, 120)}` : "content=" + String(msg?.content).slice(0, 80));
    // ② MCP
    const mcp = await createMcpClient({ agentName: "smoke", agentFpath: "dist/smoke-agent.js" });
    try {
        const tools2 = await mcp.tools();
        /* 断言策略（★ 2026-09-16 第三次修正同类问题 → 2026-09-17 第四次）：**禁止写死工具总数**。
         *   F16 是 smoke-mcp 写死 17；随后我把它改成"18 或 21"仍属写死 —— P2-6 再加 4 个生命周期工具后总数变 22，
         *   断言又立刻过期（本次实跑 got 22 → FAIL）。正解：期望值由**分组定义推导**，并在不符时打印差集，
         *   这样新增工具只改分组一处，且仍能抓到"注册缺失"（清单断言）与"多出意料外工具"（差集）。
         *   第四次：server.js 新增 3 工具（memory_credential / task_gate / task_delegate）又超期 REQUIRED ——
         *   本次把它们并入分组，后续加新工具同样只改分组定义。 */
        const REQUIRED = [
            "memory_write", "memory_search", "memory_ask", "memory_projects", "memory_context",
            "memory_read", "memory_feedback", "memory_cite", "memory_report", "memory_health",
            "memory_credential",
            "obsidian_import", "obsidian_export", "obsidian_write_note",
            "task_assign", "task_claim", "task_done", "task_supersede", "task_next",
            "task_gate", "task_delegate",
            // ★ P2-6（C-2/#4198）新增 task 生命周期工具
            "task_heartbeat", "task_release", "task_block", "task_reopen",
        ];
        const LIFECYCLE = ["task_heartbeat", "task_release", "task_block", "task_reopen"];   // P2-6（C-2）
        const EXEC = ["file_read", "file_write", "exec_run"];                                // P0（默认关闭，需 MEMORYOS_EXEC_ON=1）
        const names = tools2.map((t) => t.name);
        const execOn = process.env.MEMORYOS_EXEC_ON === "1";
        // ★ REQUIRED 已含 P2-6 生命周期 4 工具（22 = 记忆 10 + Obsidian 3 + 任务 9），
        //   故期望值不得再叠加 LIFECYCLE（早期版本在此重复计 4 个，导致期望恒比实际多 4 → 必 FAIL）。
        const expected = [...REQUIRED, ...(execOn ? EXEC : [])];
        const unexpected = names.filter((n) => !expected.includes(n));
        const missing = expected.filter((n) => !names.includes(n));
        ok(`MCP 工具面与分组定义一致（期望 ${expected.length} 个：基线 ${REQUIRED.length} + ${execOn ? "执行面 3" : "执行面默认关闭"}）`,
            names.length === expected.length && missing.length === 0 && unexpected.length === 0,
            `got ${names.length}｜缺失=[${missing.join(", ")}]｜多出=[${unexpected.join(", ")}]`);
        ok("必备工具全部注册（防静默缺失）", REQUIRED.every((n) => names.includes(n)), `${REQUIRED.length}/${REQUIRED.length} 在册（${REQUIRED.filter((n) => !names.includes(n)).length ? "缺 " + REQUIRED.filter((n) => !names.includes(n)).join(", ") : "0 缺失"}）`);
        ok("P2-6 生命周期 4 工具已注册", LIFECYCLE.every((n) => names.includes(n)), LIFECYCLE.filter((n) => !names.includes(n)).join(", ") || "4/4");
        const execNames = EXEC.filter((n) => names.includes(n));
        ok("执行面 3 工具的暴露与开关一致", execOn ? execNames.length === 3 : execNames.length === 0, `实际暴露 ${execNames.length} 个${execNames.length ? `: ${execNames.join(", ")}` : ""}`);
        const tn = await mcp.callTool("task_next", { project: "global", as: "" });
        ok("task_next 只读调用", !tn.isError, String(tn.text).replace(/\s+/g, " ").slice(0, 120));
        // ③ 只读 agent 单轮
        const messages = [
            { role: "system", content: buildSystemPrompt("smoke-agent") },
            { role: "user", content: "调用一次 memory_context(project=global)，然后用三句话告诉我：当前项目最该先记住的一件事是什么？只调用这一个工具。" },
        ];
        let saw = false;
        let r;
        try {
            r = await runAgent({
                llm, mcp, messages, maxSteps: 8,
                onStep: (s) => { if (s.type === "tool_result" && s.tool === "memory_context" && s.ok) saw = true; },
            });
            ok("agent 单轮（memory_context）", saw, "answer: " + r.answer.replace(/\s+/g, " ").slice(0, 150));
        } catch (e) {
            ok("agent 单轮（memory_context）", false, String(e.message).slice(0, 120));
        }
    } finally {
        await mcp.close();
    }
}
console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
