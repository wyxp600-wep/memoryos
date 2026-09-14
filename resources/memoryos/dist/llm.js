/**
 * MemoryOS — LLM 提炼客户端（采集消化用）
 * 经本地 mimo-proxy (http://127.0.0.1:18900) 调用用户自定义模型任一观察/规则/记忆片段提炼成结构化记忆。
 * 配置：MIMOS_URL（默认 18900）、INGEST_MODEL（默认 agnes-2.5-flash，成本敏感可换）。
 * 只读调用，不做任何写库。
 */
import { env } from "node:process";
const MIMOS_URL = env.MIMOS_URL?.trim() || "http://127.0.0.1:18900/v1/chat/completions";
const INGEST_MODEL = env.INGEST_MODEL?.trim() || "agnes-2.5-flash";
/** 调本地 LLM 提炼一段原文为 0~N 条结构化记忆（JSON 数组）。失败/超时返回空并抛错由上层决定跳过。 */
export async function extractFromSource(original, kind, sourceLabel) {
    const typeHint = kind === "rule"
        ? "优先抽取可作为「规则/约定」的约束（供所有 AI Agent 复用）。"
        : kind === "memory"
            ? "优先抽取「经验/踩坑/决策」型结论。"
            : "优先抽取「决策 / 踩坑 / 隐藏约定」型结论。";
    const system = `你是记忆提取器（不是摘要器）：从原文中提取【值得跨会话/跨工具复用的工程记忆】，而不是复述过程。\n` +
        `${typeHint}\n` +
        `只提取这四类：\n` +
        `  ① decision  做了什么选择 + 为什么（含被否掉的备选方案）\n` +
        `  ② pitfall   现象 + 根因 + 解法（三者齐全才收；缺根因或解法的不要）\n` +
        `  ③ convention 不写在代码里、但必须遵守的隐藏约定\n` +
        `  ④ experience/rule 可复用的资产：脚本/工具/路径/命令的存在与用法\n` +
        `不提取：过程叙述、计划与待办、讨论中间态、闲聊寒暄、任何 LLM 已通识（如"如何写好代码""审计注意事项"）。\n` +
        `要求：每条 ≤200 字；自包含（脱离上下文他人也可读懂）；含具体数值/路径/命令，拒绝模糊。\n` +
        `情绪信号（★ M10）：若原文含明显情绪——负面（烦/崩溃/搞不定/气死/头大）或纠错（又错了/说多少遍/别这样）或强正向偏好（太好了/就这样）——请给该条目补 valence(-1~1) 与 arousal(0~1) 字段；无情绪信号则省略。\n` +
        `输出 0~3 条，宁缺毋滥；没有合格的条目就输出 [ ]。\n` +
        `只输出 JSON 数组，每个元素形如 {"content":"一句话精炼结论","type":"decision|pitfall|convention|experience|rule","valence":-0.8,"arousal":0.7}。除了 JSON 数组，不要输出任何其它字。`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000); // per-call 超时防挂起
    try {
        const res = await fetch(MIMOS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                model: INGEST_MODEL,
                messages: [
                    { role: "system", content: system },
                    {
                        role: "user",
                        content: `来源：${sourceLabel}\n` + `请对下面原文提炼（原文可超出，仅提炼要点）：\n\n${original.slice(0, 6000)}`,
                    },
                ],
                max_tokens: 700,
                temperature: 0.3,
            }),
        });
        if (!res.ok)
            throw new Error(`LLM HTTP ${res.status}`);
        const data = (await res.json());
        const text = String(data?.choices?.[0]?.message?.content ?? "");
        return parseItems(text);
    }
    catch (e) {
        throw new Error(`LLM 提炼失败：${e instanceof Error ? e.message : String(e)}`);
    }
    finally {
        clearTimeout(timer);
    }
}
const TYPES = ["experience", "rule", "decision", "pitfall", "convention"];
/** 规范化模型输出的单条条目：content 为空返回 null；type 非法回退 experience；valence/arousal 非法数值丢弃 */
function normalizeItem(x) {
    const c = String(x?.content ?? "").trim();
    if (!c)
        return null;
    const out = { content: c, type: TYPES.includes(x?.type) ? x.type : "experience" };
    const v = Number(x?.valence);
    if (Number.isFinite(v) && v >= -1 && v <= 1)
        out.valence = Math.round(v * 100) / 100;
    const a = Number(x?.arousal);
    if (Number.isFinite(a) && a >= 0 && a <= 1)
        out.arousal = Math.round(a * 100) / 100;
    return out;
}
/** 容错解析模型输出的 JSON（可能带 ```json 围栏或前后噪音），失败回退为单条 experience */
function parseItems(text) {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (m ? m[1] : text).trim();
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr))
            throw new Error("not-array");
        return arr.map(normalizeItem).filter((x) => !!x);
    }
    catch {
        // 容错回退：去掉围栏/前后噪音后再解析（模型可能输出单个对象而非数组）
        const cleaned = stripJsonFence(text);
        if (!cleaned)
            return [];
        try {
            const j = JSON.parse(cleaned);
            if (Array.isArray(j))
                return j.map(normalizeItem).filter((x) => !!x);
            if (j && typeof j === "object") {
                const n = normalizeItem(j);
                return n ? [n] : [];
            }
        }
        catch {
            /* 仍非 JSON，按纯文本回落 */
        }
        return [{ content: cleaned, type: "experience" }];
    }
}
function stripJsonFence(text) {
    return text
        .replace(/```json\s*/gi, "")
        .replace(/```/g, "")
        .replace(/^\s*\[\s*/, "")
        .replace(/\s*\]\s*$/, "")
        .trim();
}
/**
 * 探测 LLM 代理可用性（定时采集的快速门禁）。
 * 背景：定时采集若遇代理离线，会对每个源各跑一次 45s 超时 → 一轮白等几十分钟。
 * 先发一个 max_tokens=1 的极低成本请求，不可用则整轮跳过。
 */
export async function probeLlm(timeoutMs = 5000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(MIMOS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: ctrl.signal,
            body: JSON.stringify({
                model: INGEST_MODEL,
                messages: [{ role: "user", content: "ping" }],
                max_tokens: 1,
            }),
        });
        return res.ok;
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(t);
    }
}
