/**
 * MemoryOS — Agent 核心（可复用：CLI agent.js / dashboard agent 端点共用）
 * 职责：
 *  ① 可插拔 LLM 端点（OpenAI 兼容 /chat/completions + tool_calls）——默认本地 Ollama qwen3:8b，
 *     可切任意云端 API（LLM_BASE_URL / LLM_MODEL / LLM_API_KEY，或运行时传入 llm 覆盖）。
 *  ② MCP 客户端：stdio 拉起 dist/server.js（MemoryOS MCP，18 工具），tools/list → OpenAI tools 格式。
 *  ③ Agent 循环：LLM ⇄ 工具；写类工具经 writeGate 门禁（交互确认 / 无头自动）。
 * 纪律：记忆写操作先获同意（writeGate）；绝不写入敏感凭据（系统提示词约束 + 人工 gate 双保险）。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ── 写类工具门禁（读类工具永放行为 auto）──────────────────────── */
export const WRITE_TOOLS = new Set([
    "memory_write", "memory_feedback", "memory_cite",
    "obsidian_import", "obsidian_export", "obsidian_write_note",
    "task_assign", "task_claim", "task_done", "task_supersede",
]);

/** 组装系统提示词（工具用法约定 + 记忆纪律） */
export function buildSystemPrompt(agentName, extra = "") {
    return [
        `你是 ${agentName}，MemoryOS 共享记忆中心的本地 agent。你通过 MCP 工具读写团队共享记忆库与多 Agent 任务队列。`,
        `工具用法约定：`,
        `1. 会话/关键任务开始先调用 memory_context（project=<scope>）一键注入当前项目高价值记忆；scope 不确定先 memory_projects 看一眼。`,
        `2. 检索用 memory_search（语义+关键词混合，scope 隔离）；命中片段要精确引用/展开时用 memory_read。`,
        `3. 写记忆（memory_write）纪律：只写「可跨会话复用的结论」（决策/踩坑/隐藏约定/可复用资产）；≤200 字、自包含、含具体数值/路径/命令；重复内容宁可不写；绝不写入敏感凭据。`,
        `4. 发现记忆已过时/有误 → memory_feedback 标记；落地方案实际采用了某条记忆 → memory_cite 声明。`,
        `5. 任务队列：task_next 查可做集（含依赖拓扑与优先级）；task_claim 领取（pending→in_progress）；完成实质工作后 task_done 附结论；发现跨链路重复任务用 task_supersede 归档到主任务。`,
        `回答风格：结论先行；引用记忆时带 [#记忆ID]；无工具结果支撑的内容明确标注「（推测）」。`,
        `节制原则：拿到足够工具结果后立即用文本给出最终答案，不要为调工具而调工具；同一工具同参数不要重复调用。`,
        extra,
    ].filter(Boolean).join("\n");
}

/* ── LLM 端点（可插拔）─────────────────────────────────────────── */
/** 解析 LLM 配置：运行时 llm 覆盖 > 环境变量 > 默认本地 Ollama
 *  兼容本项目既有惯例变量：Electron 壳把设置页配置注入为 MIMOS_URL / INGEST_MODEL / INGEST_KEY
 *  （见 services/core-process.js），其中 MIMOS_URL 是**完整端点**（…/v1/chat/completions），需归一化成 base。 */
export function resolveLlm(llm = {}) {
    const env = process.env;
    const rawUrl = String(llm.baseUrl || env.LLM_BASE_URL || env.MIMOS_URL || "http://127.0.0.1:11434/v1").trim();
    const baseUrl = rawUrl.replace(/\/chat\/completions\/?$/i, "").replace(/\/+$/, "");
    const model = String(llm.model || env.LLM_MODEL || env.INGEST_MODEL || "qwen3:8b").trim();
    const apiKey = String(llm.apiKey ?? env.LLM_API_KEY ?? env.INGEST_KEY ?? "");
    // Ollama 默认上下文 4096 不够装 18 个工具 schema + 长对话；对 Ollama 端点注入 options.num_ctx
    const isOllama = /:11434|ollama/i.test(baseUrl);
    const numCtx = Number(llm.numCtx || env.LLM_NUM_CTX || (isOllama ? 8192 : 0));
    return {
        baseUrl,
        model,
        apiKey,
        numCtx,
        temperature: Number(llm.temperature ?? env.LLM_TEMPERATURE ?? 0.3),
        maxTokens: Number(llm.maxTokens ?? env.LLM_MAX_TOKENS ?? 2048),
        timeoutMs: Number(llm.timeoutMs ?? env.LLM_TIMEOUT_MS ?? 180000),
    };
}

/** 调一次 OpenAI 兼容 chat/completions（带 tools）。返回 message（content + tool_calls）。 */
export async function callLlm(cfg, messages, tools, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    const body = {
        model: cfg.model,
        messages,
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        stream: false,
    };
    if (tools?.length) {
        body.tools = tools;
        body.tool_choice = "auto";
    }
    if (cfg.numCtx) body.options = { num_ctx: cfg.numCtx }; // Ollama 扩展字段；非 Ollama 端点会忽略
    try {
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
            },
            body: JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
        });
        if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        const msg = data?.choices?.[0]?.message;
        if (!msg) throw new Error("LLM 返回空 choices");
        return msg;
    }
    finally { clearTimeout(timer); }
}

/* ── MCP 客户端（stdio 拉起 server.js）─────────────────────────── */
export async function createMcpClient({ serverPath, agentName, agentFpath, cwd, env } = {}) {
    const server = serverPath || fileURLToPath(new URL("./server.js", import.meta.url));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [server],
        cwd: cwd || undefined,
        env: {
            ...process.env,
            MEMORY_AGENT: agentName || "unknown",
            ...(agentFpath ? { MEMORY_AGENT_FPATH: agentFpath } : {}),
            EMBED_MODE: process.env.EMBED_MODE || "local",
            ...(env || {}),
        },
        stderr: "pipe",
    });
    const client = new Client({ name: "memoryos-agent", version: "1.0.0" });
    await client.connect(transport);
    return {
        client,
        transport,
        async tools() {
            const r = await client.listTools();
            return r.tools;
        },
        async callTool(name, args) {
            const r = await client.callTool({ name, arguments: args || {} });
            const text = (r.content ?? [])
                .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
                .join("\n");
            if (r.isError) return { text: `⚠ ${text}`, isError: true };
            return { text };
        },
        async close() {
            try { await client.close(); } catch { /* 已断 */ }
        },
    };
}

/** MCP 工具（JSON Schema inputSchema）→ OpenAI tools 格式 */
export function mcpToolsToOpenai(mcpTools) {
    return mcpTools.map((t) => {
        const schema = t.inputSchema || { type: "object", properties: {} };
        const parameters = {
            type: "object",
            properties: schema.properties || {},
        };
        if (schema.required?.length) parameters.required = schema.required;
        // 透传 enum/默认值描述（对工具调用质量有帮助）
        if (schema.description) parameters.description = schema.description;
        return {
            type: "function",
            function: {
                name: t.name,
                description: String(t.description ?? "").slice(0, 500),
                parameters,
            },
        };
    });
}

/* ── Agent 循环 ───────────────────────────────────────────────── */
const MAX_TOOL_RESULT = 3000; // 工具结果截断：护本地小模型上下文
const MAX_SAME_CALL = 2;      // 同工具同参数最多真跑几次；超出的重复不再执行（弱模型常见死循环）

/**
 * 跑一轮 agent（用户消息已置于 messages 末尾）。
 * @param {object} o
 * @param {object} o.llm        resolveLlm() 结果
 * @param {object} o.mcp       createMcpClient() 结果
 * @param {Array}  o.messages  对话（会被原地追加；调用方负责 system/user 起步）
 * @param {number} [o.maxSteps] 最大 LLM 轮次（默认 12）
 * @param {fn}    [o.onStep]   进度回调 {type:'llm'|'tool_call'|'tool_result'|'tool_repeat'|'answer'|'write_denied'|'max_steps', ...}
 * @param {fn}    [o.writeGate] (toolName, args) → Promise<boolean>；写类工具门禁。默认交互式 y/N 由 CLI 提供；无头默认全拒。
 * @param {string[]} [o.toolsFilter] 只暴露这些工具（最小权限：如收尾阶段只给 task_done）
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{answer: string, steps: number, toolCalls: number}>}
 */
export async function runAgent(o) {
    const { llm, mcp, messages, signal } = o;
    const maxSteps = o.maxSteps ?? 12;
    const onStep = o.onStep || (() => {});
    const allTools = mcpToolsToOpenai(await mcp.tools());
    const tools = o.toolsFilter?.length ? allTools.filter((t) => o.toolsFilter.includes(t.function.name)) : allTools;
    const seen = new Map(); // 调用签名 → 次数（死循环护栏）
    let steps = 0;
    let toolCalls = 0;
    for (;;) {
        if (signal?.aborted) throw new Error("aborted");
        // 末轮：不再给工具，强制模型基于已有结果出文本收尾（弱模型常无限调工具不收口）
        const last = steps + 1 >= maxSteps;
        const msg = await callLlm(llm, messages, last ? [] : tools, signal);
        steps++;
        const tcs = last ? [] : (msg.tool_calls || []);
        if (!tcs.length) {
            const answer = String(msg.content ?? "").trim() || "（模型未返回内容）";
            if (last) onStep({ type: "max_steps", note: `达到最大步数 ${maxSteps}，已强制收尾` });
            messages.push({ role: "assistant", content: answer });
            onStep({ type: "answer", answer });
            return { answer, steps, toolCalls };
        }
        messages.push({ role: "assistant", content: msg.content || null, tool_calls: tcs });
        let allRepeats = true; // 本轮是否全是重复调用
        for (const tc of tcs) {
            const name = tc.function?.name;
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || "{}"); }
            catch { /* 弱模型偶发坏 JSON：传空参让工具报错，LLM 下一轮自纠 */ }
            // 死循环护栏：同工具同参数第 3 次起不再执行，改为回灌提醒
            const sig = `${name}|${JSON.stringify(args)}`;
            const n = (seen.get(sig) || 0) + 1;
            seen.set(sig, n);
            if (n > MAX_SAME_CALL) {
                onStep({ type: "tool_repeat", tool: name, count: n });
                messages.push({ role: "tool", tool_call_id: tc.id, content: `⚠ 你已用相同参数调用 ${name} ${n - 1} 次，结果不会变化。停止重复调用，直接基于已有结果给出最终答案。` });
                continue;
            }
            allRepeats = false;
            // 写门禁：写类工具且 writeGate 提供时过审
            if (WRITE_TOOLS.has(name) && o.writeGate) {
                let ok = false;
                try { ok = !!(await o.writeGate(name, args)); }
                catch { ok = false; }
                if (!ok) {
                    onStep({ type: "write_denied", tool: name, args });
                    messages.push({ role: "tool", tool_call_id: tc.id, content: "⚠ 用户拒绝了该写操作。不要重试，基于已有信息完成回答或改为只读建议。" });
                    continue;
                }
            }
            onStep({ type: "tool_call", tool: name, args });
            toolCalls++;
            let res;
            try {
                res = await mcp.callTool(name, args);
                onStep({ type: "tool_result", tool: name, ok: !res.isError, result: res.text.slice(0, 500) });
            }
            catch (e) {
                res = { text: `⚠ ${name} 调用失败：${e instanceof Error ? e.message : String(e)}` };
                onStep({ type: "tool_result", tool: name, ok: false, error: res.text });
            }
            let content = res.text;
            if (content.length > MAX_TOOL_RESULT) content = content.slice(0, MAX_TOOL_RESULT) + `\n…（结果截断，原长 ${res.text.length} 字）`;
            messages.push({ role: "tool", tool_call_id: tc.id, content });
        }
        // 整轮都在重复 → 直接把下一轮变成末轮（无工具）逼出文本答案，避免空转到 maxSteps
        if (allRepeats) {
            onStep({ type: "tool_repeat", tool: "(整轮重复)", count: 0, note: "强制进入收尾轮" });
            messages.push({ role: "user", content: "你刚才的调用全部与之前重复。现在不要再调用任何工具，直接用文本给出最终答案。" });
            steps = Math.max(steps, maxSteps - 1);
        }
    }
}
