/* ═══════════════════════════════════════════════════════════════════════════
 * dashboard-exec-util.js — 节点画布执行器共享工具（2026-10-04，对抗性审查 C 类去重）
 * 只收 cliexec/cdpexec 之间逐行同构的骨架：杀树 / JSON 解析 / 任务修剪 / 找任务 / SSE 流。
 * 刻意不做的合并：两个执行器的 finish 流程差异实质存在（CLI 有协议解析+日志落盘，
 * CDP 有 neverDrove 杀 App）——塞进基类只会加间接层不减总逻辑，保持各自直写。
 * ═══════════════════════════════════════════════════════════════════════════ */
import { execFile } from "node:child_process";

export function safeJson(s) {
    try {
        return JSON.parse(s ?? "null");
    }
    catch {
        return null;
    }
}

/** 杀整棵进程树（Windows taskkill /T；其余 SIGKILL）。收口以 close 事件为准，此处失败不抛。 */
export function killTree(pid) {
    if (!pid)
        return;
    try {
        if (process.platform === "win32")
            execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => { });
        else
            process.kill(pid, "SIGKILL");
    }
    catch { /* 进程可能已退出 */ }
}

/** 收口后的 job 修剪：终态只留最近 maxFinished 条（防 jobs Map / 帧缓冲常驻内存无界增长）。 */
export function pruneFinishedJobs(jobs, maxFinished = 20) {
    const finished = [...jobs.entries()].filter(([, j]) => j.status === "done" || j.status === "failed");
    if (finished.length > maxFinished)
        for (const [id] of finished.slice(0, finished.length - maxFinished))
            jobs.delete(id);
}

/** 按卡片找任务（任务卡与智能体卡都能命中）；runningOnly 时只返回执行中的。 */
export function findJobByCard(jobs, cardId, { runningOnly = false, runId = "" } = {}) {
    return [...jobs.values()].reverse().find((j) => (j.cardId === cardId || j.agentCardId === cardId)
        && (!runningOnly || j.status === "running" || j.status === "launching" || j.status === "driving")
        && (!runId || j.runId === runId));
}

/** SSE 任务流：重放 lines → 持续推送 → end 关闭。extraFlush 供 CDP 推帧等差量。 */
export function streamJobSSE(reply, job, { intervalMs = 1500, ping = false, extraFlush } = {}) {
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let sent = 0;
    const write = (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const flush = () => {
        while (sent < job.lines.length)
            write("line", job.lines[sent++]);
        extraFlush?.(write);
        if (job.status === "done" || job.status === "failed") {
            write("end", { status: job.status, runId: job.runId });
            cleanup();
        }
    };
    const interval = setInterval(() => {
        flush();
        if (ping)
            reply.raw.write(": ping\n\n");
    }, intervalMs);
    const cleanup = () => {
        clearInterval(interval);
        reply.raw.end();
    };
    job.waiters = job.waiters ?? [];
    job.waiters.push(flush);
    reply.raw.on("close", () => {
        clearInterval(interval);
        job.waiters = (job.waiters ?? []).filter((w) => w !== flush);
    });
    flush();
}
