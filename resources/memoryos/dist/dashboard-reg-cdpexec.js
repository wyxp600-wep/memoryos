/* ═══════════════════════════════════════════════════════════════════════════
 * dashboard-reg-cdpexec.js — 节点画布 P3：CDP 驾驶执行器（2026-10-04）
 * 能力：channel='cdp' 的智能体卡派发 → 带参拉起桌面智能体（工作区目录 +
 *       --remote-debugging-port 独占端口）→ CDP 连入 renderer：
 *       ① screencast 帧流经 SSE 回填卡片"直播"画面；② 尽力把任务文本注入聊天输入框并
 *       回车（选择器可经 launch_overrides.chatSelector 配置）。
 * 纪律（设计报告 §5.3 / D8/D10）：
 *  - CDP 唯一主路径；注入失败不重试不 UIA 死磕，降档为"请手动粘贴任务文本"；
 *  - 结果回收不走界面：App 内智能体经 MemoryOS MCP task_done 回写，或用户手动收口；
 *  - 停止 = 断开驾驶连接（不杀用户的 App）；超时上限防漏关；
 *  - 收口复用 finalizeCardDispatch（结算/翻边/交接卡语义不变）。
 * 依赖：Node ≥22 内置 WebSocket 全局（runtime v24 实测可用），零新依赖。
 * ═══════════════════════════════════════════════════════════════════════════ */
import { spawn } from "node:child_process";
import { renewCardLease } from "./db.js";
import { killTree, safeJson, pruneFinishedJobs, findJobByCard, streamJobSSE } from "./dashboard-exec-util.js";

const HEARTBEAT_MS = 60000;
const CDP_WAIT_DEFAULT_MS = 30000;
const DEFAULT_MAX_MS = 2 * 60 * 60000; // 驾驶会话上限 2 小时（App 不会自己退出）
const PORT_BASE = 9300;

export function registerCdpExec(app, ctx) {
    const { db } = ctx;
    let jobs = new Map();
    let portCursor = 0;
    // scanAgents 是 spawnSync 秒级同步扫描，绝不能在派发热路径裸调（会卡住所有 SSE/HTTP）——60s TTL 缓存
    let _scanCache = { list: null, at: 0 };
    async function scanAgentsCached() {
        const now = Date.now();
        if (_scanCache.list && now - _scanCache.at < 60000)
            return _scanCache.list;
        try {
            const { scanAgents } = await import("./scan.js");
            _scanCache = { list: scanAgents()?.agents ?? [], at: now };
        }
        catch {
            _scanCache = { list: null, at: now };
        }
        return _scanCache.list;
    }

    function pushLine(job, stream, text) {
        job.lines.push({ stream, text: String(text), at: Date.now() });
        if (job.lines.length > 500)
            job.lines.splice(0, job.lines.length - 400);
        job.waiters?.forEach((w) => w());
    }

    function pollHttp(url, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        return new Promise((resolve) => {
            const tick = async () => {
                try {
                    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
                    if (r.ok) {
                        const list = await r.json();
                        if (Array.isArray(list) && list.length)
                            return resolve(list);
                    }
                }
                catch { /* 未就绪继续等 */ }
                if (Date.now() > deadline)
                    return resolve(null);
                setTimeout(tick, 500);
            };
            tick();
        });
    }


    /** 注入任务文本：chatSelector 找输入框 → 原生 setter 赋值 → input 事件 → 找发送按钮或回车 */
    const injectScript = (selector, sendSelector, text) => `
      (() => {
        const sel = ${JSON.stringify(selector)};
        const ta = document.querySelector(sel || "textarea");
        if (!ta) return { ok: false, why: "未找到输入框（选择器 " + (sel || "textarea") + "）" };
        const set = Object.getOwnPropertyDescriptor(ta.constructor.prototype ?? HTMLTextAreaElement.prototype, "value")?.set
          ?? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        set.call(ta, ${JSON.stringify(text)});
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.focus();
        const send = ${JSON.stringify(sendSelector)} ? document.querySelector(${JSON.stringify(sendSelector)}) : null;
        if (send) { send.click(); return { ok: true, how: "点击发送按钮" }; }
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        return { ok: true, how: "模拟回车" };
      })()`;

    async function start(job) {
        job.status = "launching";
        const p = job.profile;
        const ov = p.launch_overrides ? safeJson(p.launch_overrides) : null;
        // 可执行文件：launch_overrides.exe > scanAgents 路径
        let exe = ov?.exe ?? null;
        if (!exe) {
            try {
                const hit = ((await scanAgentsCached()) ?? []).find((a) => a.id === p.agent_key && a.path && a.path.includes(".exe"));
                exe = hit?.path ?? null;
            }
            catch { /* 扫描失败走降档 */ }
        }
        if (!exe)
            return fail(job, "未找到该智能体的可执行文件（请确认已安装，或在配置 launch_overrides.exe 中手动指定）");
        const port = PORT_BASE + ((job.profileId * 7 + (++portCursor)) % 600);
        job.port = port;
        const args = ov?.args ?? [];
        const launchArgs = [...(p.workspace ? [p.workspace] : []), ...args, `--remote-debugging-port=${port}`, "--no-first-run"];
        pushLine(job, "sys", `[驾驶] 拉起 ${exe} ${launchArgs.join(" ")}`);
        try {
            job.proc = spawn(exe, launchArgs, { cwd: p.workspace || undefined, detached: true, windowsHide: false, stdio: "ignore" });
            job.pid = job.proc.pid ?? null;
        }
        catch (e) {
            return fail(job, `拉起失败：${e instanceof Error ? e.message : e}`);
        }
        job.proc.on("error", (e) => pushLine(job, "err", `[驾驶] 进程错误：${e.message}`));
        // 等 CDP 端口
        const waitMs = ov?.cdpTimeoutMs ?? CDP_WAIT_DEFAULT_MS;
        const targets = await pollHttp(`http://127.0.0.1:${port}/json/list`, waitMs);
        if (!targets)
            return fail(job, `CDP 调试端口 ${port} 未就绪（等待 ${Math.round(waitMs / 1000)}s）——应用可能不支持 --remote-debugging-port 或启动过慢`);
        pushLine(job, "sys", `[驾驶] CDP 已连接（端口 ${port}，${targets.length} 个页面）`);
        // 选目标页：targetMatch 正则优先（非法正则降级为不匹配，不能崩进程），否则第一个 page
        const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
        let match = null;
        if (ov?.targetMatch) {
            try {
                const re = new RegExp(ov.targetMatch);
                match = pages.find((t) => re.test(`${t.title} ${t.url}`));
            }
            catch (e) {
                pushLine(job, "sys", `[驾驶] targetMatch 正则非法（${e.message}），已忽略`);
            }
        }
        const target = match ?? pages[0];
        if (!target)
            return fail(job, "没有可驾驶的页面目标");
        pushLine(job, "sys", `[驾驶] 目标页：${String(target.title || target.url).slice(0, 80)}`);
        // WebSocket 连入
        try {
            job.ws = new WebSocket(target.webSocketDebuggerUrl);
        }
        catch (e) {
            return fail(job, `WebSocket 连接失败：${e.message}`);
        }
        job.status = "driving";
        job.ws.addEventListener("open", async () => {
            pushLine(job, "sys", "[驾驶] 已连入应用界面，开始画面直播");
            cdpSend(job, "Page.enable", {});
            cdpSend(job, "Runtime.enable", {});
            cdpSend(job, "Page.startScreencast", { format: "jpeg", quality: 45, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2 });
            // 尽力注入任务文本（失败降档不重试，D10）
            try {
                const res = await cdpCall(job, "Runtime.evaluate", {
                    expression: injectScript(ov?.chatSelector ?? "", ov?.sendSelector ?? "", job.message.slice(0, 4000)),
                    returnByValue: true,
                }, 8000);
                const v = res?.result?.value;
                if (v?.ok)
                    pushLine(job, "sys", `[驾驶] 任务文本已注入（${v.how}）——若未发出请手动补发`);
                else {
                    pushLine(job, "sys", `[驾驶] 注入失败：${v?.why ?? "未知原因"}——已降档，请手动粘贴任务文本（D10）`);
                }
            }
            catch (e) {
                pushLine(job, "sys", `[驾驶] 注入异常：${e.message}——已降档，请手动粘贴任务文本`);
            }
        });
        job.ws.addEventListener("message", (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.method === "Page.screencastFrame" && msg.params?.data) {
                job.frame = msg.params.data;
                cdpSend(job, "Page.screencastFrameAck", { sessionId: msg.params.sessionId });
                job.waiters?.forEach((w) => w("frame"));
            }
        });
        job.ws.addEventListener("close", () => {
            // ★ App 被用户关闭 → 会话终止并收口，不能让心跳把租约无限续命（reaper 失效）
            if (job.status === "driving")
                finish(job, false, "调试连接断开（应用可能被关闭）");
        });
        // 心跳 + 会话上限（SQL 单点在 db.js renewCardLease）
        job.heartbeat = setInterval(() => {
            try {
                renewCardLease(db, job.cardId, job.dispatchId);
            }
            catch { /* 不中断驾驶 */ }
        }, HEARTBEAT_MS);
        job.timer = setTimeout(() => finish(job, false, "驾驶会话到达上限，自动收口"), ov?.maxMinutes ? ov.maxMinutes * 60000 : DEFAULT_MAX_MS);
    }

    let msgId = 0;
    function cdpSend(job, method, params) {
        if (!job.ws || job.ws.readyState !== 1)
            return;
        job.ws.send(JSON.stringify({ id: ++msgId, method, params }));
    }
    function cdpCall(job, method, params, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            if (!job.ws || job.ws.readyState !== 1)
                return reject(new Error("WS 未连接"));
            const id = ++msgId;
            const timer = setTimeout(() => {
                job.ws.removeEventListener("message", onMsg);
                reject(new Error(`${method} 超时`));
            }, timeoutMs);
            const onMsg = (ev) => {
                let m;
                try { m = JSON.parse(ev.data); } catch { return; }
                if (m.id === id) {
                    clearTimeout(timer);
                    job.ws.removeEventListener("message", onMsg);
                    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
                }
            };
            job.ws.addEventListener("message", onMsg);
            job.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    function fail(job, why) {
        pushLine(job, "sys", `[驾驶] ${why}`);
        finish(job, false, why);
    }
    function finish(job, ok, detail) {
        if (job.status === "done" || job.status === "failed")
            return;
        // ★ 从未成功驾驶过（启动/等 CDP 阶段失败）→ 我们拉起的 App 是废实例，杀掉防泄漏；
        //   已进入 driving 的（用户停止/超时）→ App 归用户，只断连接不杀。
        const neverDrove = job.status !== "driving";
        job.status = ok ? "done" : "failed";
        job.finishedAt = Date.now();
        clearTimeout(job.timer);
        clearInterval(job.heartbeat);
        try { job.ws?.close(); } catch { /* 忽略 */ }
        if (neverDrove && job.pid)
            killTree(job.pid);
        pushLine(job, "sys", `[驾驶] 收口：${detail}`);
        try {
            ctx.finalizeCardDispatch?.({ cardId: job.cardId, dispatchId: job.dispatchId, ok, runId: job.runId, detail: `${detail}（CDP 驾驶）` });
        }
        catch (e) {
            pushLine(job, "sys", `[驾驶] 收口异常：${e instanceof Error ? e.message : e}`);
        }
        job.waiters?.forEach((w) => w("end"));
        job.waiters = [];
        // 收口后的会话只留最近 10 条（帧 base64 每条可达数百 KB，防常驻内存无界增长）
        pruneFinishedJobs(jobs, 10);
    }

    /** 派发入口：启动驾驶会话（不排队——每个驾驶会话独占一个 App 实例/端口） */
    ctx.startCdpRun = ({ cardId, agentCardId, profile, dispatchId, dispatchKey, taskId, message }) => {
        const runId = `cdp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const job = {
            runId, cardId, agentCardId: agentCardId ?? null, profileId: profile.id, dispatchId: dispatchId ?? null,
            taskId: taskId ?? null, message, profile, status: "queued", lines: [], frame: null, startedAt: null, finishedAt: null,
        };
        jobs.set(runId, job);
        // start 是 async：必须接住 rejection（launch_overrides 正则写错等不能崩整个 dashboard）
        start(job).catch((e) => fail(job, `驾驶启动异常：${e instanceof Error ? e.message : e}`));
        return { runId, queued: false, queueAhead: 0 };
    };

    // 直播 SSE：帧 + 行 + 结束
    app.get("/api/agent-cards/:id/live", (req, reply) => {
        const cardId = Number(req.params.id);
        const job = findJobByCard(jobs, cardId);
        if (!job)
            return reply.code(404).send({ ok: false, error: "该卡没有驾驶会话" });
        let lastFrame = null; // 帧去重按连接独立
        streamJobSSE(reply, job, {
            intervalMs: 700,
            extraFlush: (write) => {
                if (job.frame && job.frame !== lastFrame) {
                    lastFrame = job.frame;
                    write("frame", { frame: job.frame });
                }
            },
        });
    });

    // 停止 = 断开驾驶连接并收口（不杀用户的 App）
    app.post("/api/agent-cards/:id/live/stop", async (req, reply) => {
        const cardId = Number(req.params.id);
        const job = findJobByCard(jobs, cardId, { runningOnly: true });
        if (!job)
            return reply.code(404).send({ ok: false, error: "该卡当前没有驾驶会话" });
        finish(job, false, "用户断开驾驶");
        return { ok: true, runId: job.runId, note: "已断开驾驶连接；桌面应用本身未被关闭" };
    });

    app.get("/api/agent-cards/:id/live/status", async (req, reply) => {
        const cardId = Number(req.params.id);
        const list = [...jobs.values()].filter((j) => j.cardId === cardId || j.agentCardId === cardId)
            .map((j) => ({ runId: j.runId, status: j.status, pid: j.pid, port: j.port, startedAt: j.startedAt, finishedAt: j.finishedAt, lines: j.lines.length, hasFrame: !!j.frame }));
        return { ok: true, runs: list };
    });

    ctx.cdpJobs = () => jobs;
}
