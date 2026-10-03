/* ═══════════════════════════════════════════════════════════════════════════
 * dashboard-reg-cliexec.js — 节点画布 P2：CLI 直控执行器（2026-10-04）
 * 能力：agent_profiles(channel='cli') 的卡片派发不走内部 agent run，而是以 headless
 *       模式直接拉起本机智能体 CLI（codex/claude/…），工作区=spawn cwd、模型/推理强度
 *       =启动参数、任务提示词走 stdin；stdout/stderr 逐块经 SSE 回填卡片终端区。
 * 设计纪律（设计报告 §5.3 / D7/D8）：
 *  - 串行队列：同档案并发上限 concurrency（缺省 1），多派发排队；
 *  - 心跳：执行期间每 60s 续卡租约 + 工作证租约（防治理回收误杀）；
 *  - 收口复用 finalizeCardDispatch（结算工作证/翻边/生成交接卡全套语义不变）；
 *  - 分隔符协议（D7）：提示词约定 <<<HANDOFF>>>…<</HANDOFF>>>；解析失败兜底=输出尾部
 *    截取 + 全量日志落盘，绝不因格式漂移丢结果；
 *  - 杀树（D8）：taskkill /T /F 连带子进程；超时自动杀；孤儿预防=detached:false。
 *  - launch_overrides 可整体覆盖 {cmd,args,useStdin,timeoutMinutes}（隔离测试/自定义 CLI）。
 * ═══════════════════════════════════════════════════════════════════════════ */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 已知 CLI 的启动预设（launch_overrides 可整体覆盖） */
const CLI_PRESETS = {
    codex: {
        cmd: "codex",
        args: ["exec", "--json", "--skip-git-repo-check", "-"], // `-` = 提示词走 stdin
        useStdin: true,
        modelArgs: (m) => (m ? ["--model", m] : []),
    },
    claude: {
        cmd: "claude",
        args: ["-p", "--output-format", "text", "--dangerously-skip-permissions"],
        useStdin: true,
        modelArgs: (m) => (m ? ["--model", m] : []),
    },
};
const HEARTBEAT_MS = 60000;
const DEFAULT_TIMEOUT_MS = 30 * 60000;
const MAX_BUFFER_LINES = 800;

export function registerCliExec(app, ctx) {
    const { db } = ctx;
    /** runId → job；queues: profileId → FIFO（串行队列，D5） */
    const jobs = new Map();
    const queues = new Map();

    const logDir = (() => {
        try {
            const dir = ctx.dataDirOf ? ctx.dataDirOf() : "";
            const full = dir ? path.join(dir, "cli-logs") : path.join(os.tmpdir(), "memoryos-cli-logs");
            fs.mkdirSync(full, { recursive: true });
            return full;
        }
        catch {
            return path.join(os.tmpdir(), "memoryos-cli-logs");
        }
    })();

    function pushLine(job, stream, text) {
        // 全量原文独立累积（供 HANDOFF 解析与日志落盘，D7）；lines 只服务 SSE、可截断
        job.fullText = (job.fullText ?? "") + text + (text.endsWith("\n") ? "" : "\n");
        for (const line of String(text).split(/\r?\n/)) {
            job.lines.push({ stream, text: line, at: Date.now() });
        }
        if (job.lines.length > MAX_BUFFER_LINES * 2)
            job.lines.splice(0, job.lines.length - MAX_BUFFER_LINES);
        job.waiters?.forEach((w) => w());
    }

    /** 队列泵：档案并发位空出即启动下一个（串行默认 1；计数在循环内累加，防连派并发击穿） */
    function pump(profileId) {
        const q = queues.get(profileId);
        if (!q?.length)
            return;
        const limit = Math.max(1, Number(q.concurrency) || 1);
        let running = [...jobs.values()].filter((j) => j.profileId === profileId && j.status === "running").length;
        while (running < limit && q.length) {
            launch(q.shift());
            running++;
        }
    }

    function launch(job) {
        job.status = "running";
        job.startedAt = Date.now();
        const p = job.profile;
        const ov = p.launch_overrides ? safeJson(p.launch_overrides) : null;
        const preset = CLI_PRESETS[String(p.agent_key ?? "")] ?? null;
        const cmd = ov?.cmd ?? preset?.cmd ?? String(p.agent_key ?? "");
        let args = ov?.args ?? (preset ? [...preset.args, ...(preset.modelArgs?.(p.model) ?? [])] : []);
        if (!ov && !preset && p.reasoning)
            args = [...args, "--reasoning", String(p.reasoning)]; // 无预设的自定义 CLI：推理强度按通用flag尽力传
        const cwd = p.workspace || os.homedir();
        job.cwd = cwd;
        job.cmd = cmd;
        try {
            // ★ Windows：npm shim（codex.cmd 等）裸 spawn 必 ENOENT，而 .cmd 出于安全 Node 禁止直接 spawn。
            //   方案：win32 统一 shell:true + 预引号整串 —— node 会把整串再包一层引号交给
            //   cmd /d /s /c，/s 恰好剥掉 node 加的外层引号，我们预置的内层引号原样保留
            //   （解决"C:\Program Files\..."带空格路径）；taskkill /T 仍可整树杀。
            if (process.platform === "win32") {
                const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
                const commandString = `${quote(cmd)} ${args.map(quote).join(" ")}`;
                job.proc = spawn(commandString, {
                    cwd, shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false,
                });
            }
            else {
                job.proc = spawn(cmd, args, {
                    cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false,
                });
            }
        }
        catch (e) {
            fail(job, `拉起失败：${e instanceof Error ? e.message : e}`);
            return;
        }
        job.pid = job.proc.pid ?? null;
        job.proc.stdin?.on("error", () => { }); // ★ CLI 提前退出时 stdin EPIPE 不能炸 dashboard
        pushLine(job, "sys", `[执行器] ${cmd} ${args.join(" ")} ｜ 工作区 ${cwd} ｜ PID ${job.pid ?? "?"}`);
        // 心跳：续卡租约 + 工作证租约（防治理回收误杀长任务）
        job.heartbeat = setInterval(() => {
            try {
                db.prepare(`UPDATE cards SET heartbeat_at=datetime('now'), lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes') WHERE id=? AND status='running'`).run(job.cardId);
                if (job.dispatchId)
                    ctx.touchDispatchLease?.(db, job.dispatchId, 10);
            }
            catch { /* 心跳失败不中断执行 */ }
        }, HEARTBEAT_MS);
        // 超时杀树
        job.timer = setTimeout(() => {
            if (job.status === "running") {
                pushLine(job, "sys", "[执行器] 超时，自动终止进程树");
                killTree(job);
                finish(job, false, "执行超时被终止");
            }
        }, ov?.timeoutMinutes ? ov.timeoutMinutes * 60000 : DEFAULT_TIMEOUT_MS);
        job.proc.stdout?.on("data", (d) => pushLine(job, "out", d.toString("utf8")));
        job.proc.stderr?.on("data", (d) => pushLine(job, "err", d.toString("utf8")));
        job.proc.on("error", (e) => { if (job.status === "running") fail(job, `进程错误：${e.message}`); });
        job.proc.on("close", (code) => {
            if (job.status !== "running")
                return; // 已被超时/手动收口
            pushLine(job, "sys", `[执行器] 进程退出 code=${code}`);
            finish(job, code === 0, code === 0 ? "CLI 执行完成" : `CLI 进程退出码 ${code}`);
        });
        // 提示词走 stdin（避免命令行长度/转义问题）
        if ((ov?.useStdin ?? preset?.useStdin ?? true) && job.proc.stdin) {
            job.proc.stdin.write(job.message + "\n");
            job.proc.stdin.end();
        }
        else {
            job.proc.stdin?.end();
        }
    }

    function killTree(job) {
        if (!job.pid || job.killed)
            return;
        job.killed = true;
        try {
            if (process.platform === "win32")
                execFile("taskkill", ["/PID", String(job.pid), "/T", "/F"], () => { /* 收口以 close 为准 */ });
            else
                job.proc?.kill("SIGKILL");
        }
        catch { /* 进程可能已退出 */ }
    }

    function fail(job, why) {
        pushLine(job, "sys", `[执行器] ${why}`);
        finish(job, false, why);
    }

    /** 收口：分隔符协议解析（D7）→ 兜底尾部；全量日志落盘；复用 finalizeCardDispatch 全套语义 */
    function finish(job, ok, detail) {
        if (job.status === "done" || job.status === "failed")
            return;
        job.status = ok ? "done" : "failed";
        job.finishedAt = Date.now();
        clearTimeout(job.timer);
        clearInterval(job.heartbeat);
        killTree(job);
        const all = job.fullText ?? job.lines.map((l) => l.text).join("\n"); // 全量原文（不受 SSE 缓冲截断影响）
        let answer = "";
        const m = all.match(/<<<HANDOFF>>>([\s\S]*?)(?:<<\/HANDOFF>>>|$)/);
        if (m?.[1]?.trim())
            answer = m[1].trim().slice(0, 1200);
        else {
            const tail = all.trim().slice(-1000);
            answer = tail || detail;
            pushLine(job, "sys", "[执行器] 未按约定输出交接段（<<<HANDOFF>>>），已用输出尾部兜底");
        }
        try {
            fs.writeFileSync(path.join(logDir, `${job.runId}.log`), all, "utf8");
            pushLine(job, "sys", `[执行器] 全量日志：${path.join(logDir, job.runId + ".log")}`);
        }
        catch { /* 日志落盘失败不影响收口 */ }
        try {
            ctx.finalizeCardDispatch?.({
                cardId: job.cardId, dispatchId: job.dispatchId, ok, runId: job.runId,
                answer, detail: `${detail}（CLI 直控 ${job.cmd}）`,
            });
        }
        catch (e) {
            pushLine(job, "sys", `[执行器] 收口异常：${e instanceof Error ? e.message : e}`);
        }
        job.waiters?.forEach((w) => w());
        pruneJobs();
        pump(job.profileId);
    }

    /** 收口后的 job 只留最近 20 条（防常驻内存无界增长）；active/queued 永不清理 */
    function pruneJobs() {
        const finished = [...jobs.entries()].filter(([, j]) => j.status === "done" || j.status === "failed");
        if (finished.length > 20)
            for (const [id] of finished.slice(0, finished.length - 20))
                jobs.delete(id);
    }

    /** 启动时清理 14 天前的历史日志（防 cli-logs 无界吃磁盘） */
    function cleanOldLogs() {
        try {
            const cutoff = Date.now() - 14 * 86400000;
            for (const f of fs.readdirSync(logDir)) {
                const fp = path.join(logDir, f);
                if (fs.statSync(fp).mtimeMs < cutoff)
                    fs.rmSync(fp, { force: true });
            }
        }
        catch { /* 清理失败不影响启动 */ }
    }
    cleanOldLogs();

    function safeJson(s) {
        try {
            return JSON.parse(s ?? "null");
        }
        catch {
            return null;
        }
    }

    /** 派发入口（dispatch-agent 路由到本执行器）：入队并返回 runId */
    ctx.startCliRun = ({ cardId, agentCardId, profile, dispatchId, dispatchKey, taskId, message }) => {
        const runId = `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const job = {
            runId, cardId, agentCardId: agentCardId ?? null, profileId: profile.id, dispatchId: dispatchId ?? null, dispatchKey: dispatchKey ?? null,
            taskId: taskId ?? null, message, profile, status: "queued", lines: [], startedAt: null, finishedAt: null,
        };
        jobs.set(runId, job);
        if (!queues.has(profile.id))
            queues.set(profile.id, []);
        const q = queues.get(profile.id);
        q.concurrency = profile.concurrency;
        q.push(job);
        const queueAhead = q.indexOf(job); // 必须在 pump 前取（启动即出队会变 -1）
        pump(profile.id);
        return { runId, queued: job.status === "queued", queueAhead };
    };

    // 实时执行流（SSE）：先重放缓冲，再持续推送；done/failed 即关闭
    app.get("/api/agent-cards/:id/exec/stream", (req, reply) => {
        const cardId = Number(req.params.id);
        const runId = String(req.query.runId ?? "");
        const job = [...jobs.values()].reverse().find((j) => (j.cardId === cardId || j.agentCardId === cardId) && (!runId || j.runId === runId));
        if (!job)
            return reply.code(404).send({ ok: false, error: "该卡没有执行记录" });
        reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
        });
        let sent = 0;
        const write = (event, data) => {
            reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const flush = () => {
            while (sent < job.lines.length) {
                const l = job.lines[sent++];
                write("line", { stream: l.stream, text: l.text });
            }
            if (job.status !== "running") {
                write("end", { status: job.status, runId: job.runId });
                cleanup();
            }
        };
        const interval = setInterval(() => {
            flush();
            reply.raw.write(": ping\n\n");
        }, 1500);
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
    });

    // 手动停止（杀树）
    app.post("/api/agent-cards/:id/exec/stop", async (req, reply) => {
        const cardId = Number(req.params.id);
        const job = [...jobs.values()].reverse().find((j) => (j.cardId === cardId || j.agentCardId === cardId) && j.status === "running");
        if (!job)
            return reply.code(404).send({ ok: false, error: "该卡当前没有执行中的任务" });
        pushLine(job, "sys", "[执行器] 用户手动停止");
        killTree(job);
        finish(job, false, "用户手动停止");
        return { ok: true, runId: job.runId };
    });

    // 执行记录（供卡片状态区取 PID/时长）
    app.get("/api/agent-cards/:id/exec", async (req, reply) => {
        const cardId = Number(req.params.id);
        const list = [...jobs.values()].filter((j) => j.cardId === cardId || j.agentCardId === cardId)
            .map((j) => ({ runId: j.runId, status: j.status, pid: j.pid, cmd: j.cmd, cwd: j.cwd,
                startedAt: j.startedAt, finishedAt: j.finishedAt, lines: j.lines.length }));
        return { ok: true, runs: list };
    });

    ctx.cliLogDir = logDir;
}
