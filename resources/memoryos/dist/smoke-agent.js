/**
 * smoke-agent.js — MemoryOS Agent 冒烟
 *  ① LLM 端点工具调用直测（qwen3:8b / 任意 OpenAI 兼容，--llm-url/--llm-model 覆盖）
 *  ② MCP 客户端连通 + tools/list（18 工具）
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
        msg = await callLlm(llm, [
            { role: "system", content: "你是最小工具调用测试器。用户报城市就调用 get_temp，不要闲聊。" },
            { role: "user", content: "北京现在几度？" },
        ], tools);
    } catch (e) { err = e; }
    const tcs = msg?.tool_calls || [];
    ok("LLM 端点可达", !err, err ? String(err.message).slice(0, 120) : `${(Date.now() - t0) / 1000}s`);
    ok("LLM 发起工具调用", tcs.length === 1 && tcs[0].function.name === "get_temp",
        tcs.length ? `tool_calls=${JSON.stringify(tcs.map((t) => t.function)).slice(0, 120)}` : "content=" + String(msg?.content).slice(0, 80));
    // ② MCP
    const mcp = await createMcpClient({ agentName: "smoke", agentFpath: "dist/smoke-agent.js" });
    try {
        const tools2 = await mcp.tools();
        // ① 计数断言（P0 执行面加入 3 工具后为 21）；② 必备清单断言 —— 只改计数会漏掉"注册缺失"
        //   （F16 教训：`&&` 短路使计数为假时清单根本不执行，故两者分开断言）
        const REQUIRED = [
            "memory_write", "memory_search", "memory_ask", "memory_projects", "memory_context",
            "memory_read", "memory_feedback", "memory_cite", "memory_report", "memory_health",
            "obsidian_import", "obsidian_export", "obsidian_write_note",
            "task_assign", "task_claim", "task_done", "task_supersede", "task_next",
        ];
        const names = tools2.map((t) => t.name);
        // 执行面默认关闭（P0-2）：开启时才期望 +3，否则应为基线 18 —— 两种态都必须自洽
        const execOn = process.env.MEMORYOS_EXEC_ON === "1";
        ok(`MCP 连通 + 工具计数（执行面${execOn ? "已开启" : "默认关闭"}）`, tools2.length === (execOn ? REQUIRED.length + 3 : REQUIRED.length), `got ${tools2.length}: ${names.join(", ")}`);
        const missing = REQUIRED.filter((n) => !names.includes(n));
        ok("必备 18 工具全部注册（防静默缺失）", missing.length === 0, missing.length ? `缺失 ${missing.join(", ")}` : "0 缺失");
        const execNames = ["file_read", "file_write", "exec_run"].filter((n) => names.includes(n));
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
