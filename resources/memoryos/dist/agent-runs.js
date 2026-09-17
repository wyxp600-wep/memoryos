/**
 * MemoryOS — Agent 执行中心：per-run 内存模型 + SSE 事件流 + onStep 适配
 * 定位：dashboard 内置 agent 的「执行过程可视化」后端。
 * 纪律（对应 docs/agent-completion/expert-前端.md 与 FACTS-PACK）：
 *  ① 呈现层模块：只读/只推，不改 writeGate 行为；审批三键端点未启用时一律 501 占位（B1）。
 *  ② F15 收敛：SSE/预览一律 ≤300 字（脱敏白名单内的工具名+参数摘要），工具结果全文只走
 *     exec 域 artifact（data/artifacts/<tool>-<ts>.txt）按 range 拉取，**不进事件流**。
 *  ③ 无持久化：run 存内存（Map，默认保留最近 50 个）；崩溃丢 run 不丢任务（任务态在共享库）。
 * ④ 任务联动：message 命中「任务 #N」且 agent 真的 task_done 成功 → 推 task_done 事件；
 *     不自动 claim（L1 写走既有写门禁，B1）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_RUNS = 50;            // 内存保留的 run 数（超限丢最老）
const MAX_EVENTS = 500;         // 单 run 环形事件队列（Last-Event-ID 回补窗口）
const PREVIEW_MAX = 300;        // SSE/预览单字段上限（F15）
const ARTIFACT_DIR_NAME = "artifacts";
const ARTIFACT_NAME_MAX = 64;   // 从工具结果文本提取 artifact 路径的名称长度上限
const ARTIFACT_LINE = /完整输出[：:]\s*(\S{4,256})/;   // exec-tools.js exec_run 截断输出的固定句式
const TASK_DONE_LINE = /^任务\s*#(\d+)\s*已完成/;          // server.js task_done 成功回执的固定句式
const TASK_LINE = /任务\s*#(\d+)/;                        // 用户消息里的任务引用

/** 从工具结果全文提取 exec artifact 路径（exec-tools.js 截断时回传「完整输出：<abs>」；非截断结果无此句 → 不记路径） */
export function extractArtifactPath(fullText) {
    const m = ARTIFACT_LINE.exec(String(fullText ?? ""));
    if (!m) return null;
    const p = m[1];
    const name = path.basename(p);
    if (!/^[A-Za-z0-9._\-]+$/.test(name) || name.length > ARTIFACT_NAME_MAX) return null;
    return p;
}

/** 从 agent 答案/工具结果里检测 task_done 成功（回执「任务 #N 已完成…）」→ 联动事件的任务号 */
export function detectTaskDone(text) {
    const m = TASK_DONE_LINE.exec(String(text ?? ""));
    return m ? Number(m[1]) : null;
}

/** 从用户消息里提取任务号（「任务 #123」）→ 呈现层 join 用 */
export function extractTaskHint(message) {
    const m = TASK_LINE.exec(String(message ?? ""));
    return m ? Number(m[1]) : null;
}

/* ── diff：写文件类步骤的前后快照 → unified diff（呈现层只生成，不算 LCS 于前端） ── */
const WRITE_TOOLS = new Set(["file_write", "file_edit"]);

/** 简易行级 diff（Myers 太重；写文件场景多为整文件覆盖 → 退化为整块替换 + 前后公共行保留） */
export function simpleDiff(oldText, newText, filePath) {
    const a = String(oldText ?? "").split(/\r?\n/);
    const b = String(newText ?? "").split(/\r?\n/);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    const ctx = (lines) => lines.map((l) => " " + l).join("\n");
    const del = a.slice(head, a.length - tail).map((l) => "-" + l).join("\n");
    const add = b.slice(head, b.length - tail).map((l) => "+" + l).join("\n");
    const hunks = [{
        oldStart: head + 1, oldCount: a.length - head - tail,
        newStart: head + 1, newCount: b.length - head - tail,
        lines: [
            ...a.slice(0, head).map((l) => ({ type: "ctx", noOld: 0, noNew: 0, text: l })),
            ...del.split("\n").map((l, i) => ({ type: "del", noOld: head + i + 1, noNew: 0, text: l.slice(1) })),
            ...add.split("\n").map((l, i) => ({ type: "add", noOld: 0, noNew: head + i + 1, text: l.slice(1) })),
            ...b.slice(b.length - tail).map((l) => ({ type: "ctx", noOld: 0, noNew: 0, text: l })),
        ].filter((l) => l.type === "ctx" ? true : true),
    }];
    return { file: filePath, hunks, additions: add ? add.split("\n").filter((l) => l.startsWith("+")).length : 0, deletions: del ? del.split("\n").filter((l) => l.startsWith("-")).length : 0 };
}

/* ── run 内存模型 ───────────────────────────────────────────────── */
export function createRunRegistry() {
    const runs = new Map();        // runId → run
    let seq = 0;

    function newRunId() {
        seq += 1;
        return `r_${Date.now().toString(36)}_${seq}_${crypto.randomBytes(2).toString("hex")}`;
    }

    function ev(run, type, data) {
        run.seq += 1;
        run.events.push({ seq: run.seq, event: type, data, t: Date.now() });
        if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
        for (const sub of run.subscribers) {
            try { sub.onEvent(type, data, run.seq); } catch { /* 订阅者异常不断流 */ }
        }
        return run.seq;
    }

    function evSince(run, sinceSeq, out) {
        for (const e of run.events) {
            if (e.seq > sinceSeq) out.push(e);
        }
    }

    /**
     * @param {object} o { sessionId?, title?, taskHint? }
     * @returns {run, onStep}  onStep(step) 喂 agent-core 的 onStep 事件；run.finished() 标记终态
     */
    function createRun(o = {}) {
        const id = newRunId();
        const abortCtrl = new AbortController();      // ★ A1：中止运行 —— signal 传给 runAgent（agent-core 轮次间 + LLM fetch 可中断）
        const run = {
            id,
            sessionId: o.sessionId || id,
            title: String(o.title || "").slice(0, 120),
            taskHint: o.taskHint || null,          // 关联任务号（呈现层 join 用，不自动 claim）
            status: "running",                      // running / done / failed / aborted
            startedAt: Date.now(),
            finishedAt: null,
            steps: [],                               // [{stepId, tool, argsPreview, risk, state, ok, elapsedMs, outChars, artifactPath?, diff?, preview, denied?}]
            events: [],                              // 环形事件队列（Last-Event-ID 回补）
            seq: 0,
            subscribers: new Set(),
            answer: "",
            toolCalls: 0,
            llmSteps: 0,
            error: null,
            usage: null,                             // ★ A5：LLM token 用量 {prompt, completion, total}（有则真值）
            estimatedTokens: 0,                      // ★ A5：估算（usage 缺失时的 chars/4 兜底）
            abortCtrl,                                // 路由侧 abortRun(id) → abortCtrl.abort()
        };
        runs.set(id, run);
        while (runs.size > MAX_RUNS) {
            const oldest = runs.keys().next().value;
            if (oldest === id) break;
            runs.delete(oldest);
        }

        let curStep = null;
        function onStep(s) {
            switch (s.type) {
                case "tool_face":
                    ev(run, "tool_face", { exposed: s.exposed, total: s.total });
                    break;
                case "tool_call": {
                    curStep = {
                        stepId: run.steps.length + 1,
                        tool: s.tool,
                        argsPreview: JSON.stringify(s.args ?? {}).slice(0, PREVIEW_MAX),
                        state: "pending",
                        t0: Date.now(),
                    };
                    run.steps.push(curStep);
                    ev(run, "step", { stepId: curStep.stepId, tool: s.tool, argsPreview: curStep.argsPreview, t: Date.now() });
                    break;
                }
                case "tool_result":
                    if (curStep) {
                        const ms = Date.now() - curStep.t0;
                        curStep.state = s.ok ? "ok" : "error";
                        curStep.ok = s.ok;
                        curStep.elapsedMs = ms;
                        curStep.outChars = s.result ? String(s.result).length : (s.error ? String(s.error).length : 0);
                        curStep.preview = String(s.ok ? s.result : s.error).slice(0, PREVIEW_MAX);
                        // 写文件类：diff 由路由侧在 tool_result 前后取快照生成（此处仅标记），
                        // 避免 agent-runs 直接读盘（保持模块无副作用，diff 数据源在路由层注入）
                        if (WRITE_TOOLS.has(curStep.tool) && s.ok) curStep.hasDiff = true;
                        // 任务联动：task_done 成功回执（「任务 #N 已完成…」）→ 标记任务号，路由侧推 task_done 事件
                        if (curStep.tool === "task_done" && s.ok) {
                            const tid = detectTaskDone(s.result);
                            if (tid) curStep.taskDone = tid;
                        }
                        // 大输出：执行域工具把全文落 artifact，事件只带路径（F15 收敛）。
                        // 路由侧在喂 onStep 前用 extractArtifactPath(s.result) 把 s.artifactPath 注入（agent-core 原文不截断，此处保持 agent-runs 无副作用）
                        if (s.artifactPath) curStep.artifactPath = s.artifactPath;
                        else if (curStep.outChars > 4096 && s.result) {
                            const ap = extractArtifactPath(s.result);
                            if (ap) curStep.artifactPath = ap;
                        }
                        run.toolCalls = s.ok ? run.toolCalls + 1 : run.toolCalls;
                        ev(run, "step_end", {
                            stepId: curStep.stepId, tool: curStep.tool, ok: s.ok,
                            elapsedMs: ms, outChars: curStep.outChars,
                            preview: curStep.preview,
                            hasDiff: !!curStep.hasDiff,
                            artifactPath: curStep.artifactPath || null,
                        });
                        curStep = null;
                    }
                    break;
                case "tool_repeat":
                    ev(run, "tool_repeat", { tool: s.tool, count: s.count });
                    break;
                case "write_denied":
                    ev(run, "write_denied", { tool: s.tool, argsPreview: JSON.stringify(s.args ?? {}).slice(0, PREVIEW_MAX) });
                    break;
                case "answer":
                    run.answer = s.answer;
                    run.llmSteps = s.steps ?? run.llmSteps;
                    // ★ A5：usage 累加（agent-core runAgent 返回的 usage；Ollama 常 null → 估算兜底）
                    if (s.usage) {
                        run.usage = {
                            prompt: (run.usage?.prompt || 0) + (s.usage.prompt_tokens ?? s.usage.prompt_eval_count ?? 0),
                            completion: (run.usage?.completion || 0) + (s.usage.completion_tokens ?? s.usage.eval_count ?? 0),
                        };
                        run.usage.total = run.usage.prompt + run.usage.completion;
                    }
                    if (s.estimatedTokens) run.estimatedTokens = s.estimatedTokens;
                    ev(run, "answer", {
                        preview: String(s.answer || "").slice(0, PREVIEW_MAX),
                        usage: run.usage,
                        estimatedTokens: run.estimatedTokens,
                    });
                    break;
                case "max_steps":
                    ev(run, "max_steps", { note: s.note });
                    break;
                default:
                    break;
            }
        }

        function finish(status, extra = {}) {
            if (run.status !== "running") return;
            run.status = status;
            run.finishedAt = Date.now();
            Object.assign(run, extra);
            ev(run, "done", {
                status, answer: run.answer, toolCalls: run.toolCalls,
                elapsedMs: run.finishedAt - run.startedAt,
                usage: run.usage, estimatedTokens: run.estimatedTokens,   // ★ A5
                ...extra,
            });
        }
        /** ★ A1：中止运行 —— 触发 runAgent 的 AbortSignal（轮次间 + LLM fetch 可中断；
         *  进行中的 mcp.callTool 会跑完，不硬杀进程）。调用侧（路由）：handle.abort(reason)。 */
        function abort(reason) {
            try { run.abortCtrl.abort(); } catch { /* 已 aborted */ }
            finish("aborted", { error: reason });
        }

        function subscribe(sub) {
            run.subscribers.add(sub);
            return () => run.subscribers.delete(sub);
        }

        function list() {
            return {
                runId: run.id, sessionId: run.sessionId, title: run.title, taskHint: run.taskHint,
                status: run.status, stepIndex: run.steps.length, maxSteps: run.llmSteps || 0,
                toolCalls: run.toolCalls, startedAt: run.startedAt, finishedAt: run.finishedAt,
                error: run.error, usage: run.usage, estimatedTokens: run.estimatedTokens,
                steps: run.steps.map((s) => ({
                    stepId: s.stepId, tool: s.tool, argsPreview: s.argsPreview,
                    state: s.state, ok: s.ok ?? null, elapsedMs: s.elapsedMs ?? null,
                    outChars: s.outChars ?? 0, preview: s.preview ?? "",
                    hasDiff: !!s.hasDiff, artifactPath: s.artifactPath || null,
                    taskDone: s.taskDone ?? null,
                })),
            };
        }

        /** 路由侧在写文件类工具的 onStep tool_result 前后调用：把前后快照写进该步 diff 字段 */
        function setStepDiff(stepId, diffPayload) {
            const st = run.steps.find((x) => x.stepId === stepId);
            if (st) st.diff = diffPayload;
        }

        // ★ 暴露 run 对象本体给路由侧（abort/mcp 端点直接读 status/abortCtrl；
        //   getRun 此前误返回 runs.get(id) = run 对象，与 createRun 的 handle{run} 结构不一致）
        return { run, onStep, finish, abort, subscribe, ev, evSince, list, setStepDiff };
    }

    function getRun(id) {
        const r = runs.get(id);
        if (!r) return null;
        // ★ 返回 {run, abort, list} 形态 handle（路由侧读 h.run.status / 调 h.abort() / h.list()）。
        //   finish/abort/list 逻辑内联在 getRun 作用域（不复用 createRun 的局部闭包，因跨 run 不可共享）。
        const finishOf = (status, extra = {}) => {
            if (r.status !== "running") return;
            r.status = status;
            r.finishedAt = Date.now();
            Object.assign(r, extra);
            ev(r, "done", {
                status, answer: r.answer, toolCalls: r.toolCalls,
                elapsedMs: r.finishedAt - r.startedAt,
                usage: r.usage, estimatedTokens: r.estimatedTokens, ...extra,
            });
        };
        return {
            run: r,
            abort: (reason) => { try { r.abortCtrl.abort(); } catch { } finishOf("aborted", { error: reason }); },
            list: () => listRun(r),
        };
    }
    /** 单 run 全量（与 createRun.list 同构；路由侧 h.list() 用） */
    function listRun(r) {
        return {
            runId: r.id, sessionId: r.sessionId, title: r.title, taskHint: r.taskHint,
            status: r.status, stepIndex: r.steps.length, maxSteps: r.llmSteps || 0,
            toolCalls: r.toolCalls, startedAt: r.startedAt, finishedAt: r.finishedAt,
            error: r.error, usage: r.usage, estimatedTokens: r.estimatedTokens,
            steps: r.steps.map((s) => ({
                stepId: s.stepId, tool: s.tool, argsPreview: s.argsPreview,
                state: s.state, ok: s.ok ?? null, elapsedMs: s.elapsedMs ?? null,
                outChars: s.outChars ?? 0, preview: s.preview ?? "",
                hasDiff: !!s.hasDiff, artifactPath: s.artifactPath || null,
                taskDone: s.taskDone ?? null,
            })),
        };
    }
    function allRuns() {
        return [...runs.values()].map((r) => ({
            runId: r.id, sessionId: r.sessionId, title: r.title, taskHint: r.taskHint,
            status: r.status, stepIndex: r.steps.length, toolCalls: r.toolCalls,
            startedAt: r.startedAt, finishedAt: r.finishedAt, error: r.error,
        }));
    }

    return { createRun, getRun, allRuns };
}

/** 读 exec artifact 全文（呈现层只读；越界/不存在返回 null，不抛） */
export function readArtifact(dataDir, artifactPath, range = null) {
    try {
        const abs = artifactPath.startsWith("/") ? artifactPath : path.join(dataDir, ARTIFACT_DIR_NAME, artifactPath);
        const p = fs.realpathSync(abs);
        const root = fs.realpathSync(path.join(dataDir, ARTIFACT_DIR_NAME));
        if (p !== root && !p.startsWith(root + path.sep)) return { ok: false, error: "artifact 越界" };
        const text = fs.readFileSync(p, "utf8");
        const lines = text.split(/\r?\n/);
        let from = 0, to = lines.length;
        if (range && range.length === 2) {
            from = Math.max(0, Number(range[0]) || 0);
            to = Math.min(lines.length, Number(range[1]) || lines.length);
            if (to <= from) to = from + 1;
        }
        return { ok: true, lines: lines.slice(from, to), totalLines: lines.length, from, to, totalBytes: Buffer.byteLength(text, "utf8") };
    }
    catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
