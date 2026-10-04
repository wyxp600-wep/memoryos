/* ═══════════════════════════════════════════════════════════════════════════
 * dashboard-reg-cdpexec.js — 节点画布 P3：CDP 驾驶执行器（2026-10-04）
 * 能力：channel='cdp' 的智能体卡派发 → 带参拉起桌面智能体（工作区目录 +
 *       --remote-debugging-port 独占端口）→ CDP 连入 renderer：
 *       ① screencast 帧流经 SSE 回填卡片"直播"画面；② 尽力把任务文本注入聊天输入框并
 *       回车（选择器可经 launch_overrides.chatSelector 配置）；
 *       ③ launch_overrides.openChat 配置了开面板按键 → 先探到面板没开才按（VS Code
 *          Ctrl+Alt+I 是 toggle，盲按会把已开的面板关掉）；
 *       ④ launch_overrides.injectVia:"cdp" → CDP 可信输入（Input.insertText 打字+回车），
 *          用于没有 textarea 的应用（VS Code 聊天输入是 native-edit-context，DOM 赋值无效）；
 *       ⑤ launch_overrides.trustWorkspace:true → 自动点"信任文件夹并继续"（改变用户安全
 *          状态，必须显式 opt-in）；登录类前置（OAuth 引导）不自动化——探测到就降档并给
 *          明确原因，不假装成功。
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

    /* ── 驾驶注入链（D10：链路有界——最多一次按键 + 一次打字，不重试死磕）────── */

    /** CDP 可信按键（rawKeyDown → char? → keyUp）：合成 DOM 事件骗不过应用快捷键 */
    async function cdpKey(job, k) {
        const base = { key: k.key, code: k.code || "", windowsVirtualKeyCode: k.keyCode || 0, nativeVirtualKeyCode: k.keyCode || 0, modifiers: k.modifiers || 0 };
        await cdpCall(job, "Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" }, 4000);
        if (k.text)
            await cdpCall(job, "Input.dispatchKeyEvent", { ...base, type: "char", text: k.text }, 4000);
        await cdpCall(job, "Input.dispatchKeyEvent", { ...base, type: "keyUp" }, 4000);
    }

    /** CDP 可信点击（合成 element.click() 不触发应用内手势） */
    async function cdpClick(job, x, y) {
        await cdpCall(job, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 }, 4000);
        await cdpCall(job, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, 4000);
        await cdpCall(job, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, 4000);
    }

    /**
     * 界面探测：面板是否开 / 输入面文本 / 信任弹窗 / 登录引导 / 焦点是否在输入面。
     * 选择器可用 launch_overrides.chatContainer / chatText 覆盖（默认 VS Code 聊天面）。
     */
    async function probeUi(job, ov) {
        const expr = `(() => {
        const cs = ${JSON.stringify(ov?.chatContainer ?? ".chat-input-container")};
        const ts = ${JSON.stringify(ov?.chatText ?? ".chat-input-container .view-line")};
        const c = document.querySelector(cs);
        const txt = Array.from(document.querySelectorAll(ts)).map(e => e.innerText || "").join("\\n");
        const dlg = Array.from(document.querySelectorAll(".monaco-dialog-box, [role=dialog]"));
        const trust = dlg.flatMap(d => Array.from(d.querySelectorAll("button, a, [role=button], .monaco-button")))
          .find(b => /^(信任文件夹并继续|Trust Folder and Continue)\\b/i.test((b.innerText || "").trim()));
        const signIn = dlg.some(d => /登录以使用|Sign in to use/i.test(d.innerText || ""));
        const dialog = dlg.length > 0
          ? (dlg.map(d => (d.innerText || "").replace(/\\n+/g, " | ").slice(0, 80))[0] || "")
          : "";
        const r = c ? c.getBoundingClientRect() : null;
        const ae = document.activeElement;
        return JSON.stringify({
          panel: !!c, text: txt.slice(0, 80), dialog,
          trust: trust ? { x: Math.round(trust.getBoundingClientRect().x + trust.getBoundingClientRect().width / 2),
                           y: Math.round(trust.getBoundingClientRect().y + trust.getBoundingClientRect().height / 2) } : null,
          signIn,
          focused: !!(ae && ae.closest && ae.closest(cs)),
          box: r && r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null
        });
      })()`;
        try {
            const res = await cdpCall(job, "Runtime.evaluate", { expression: expr, returnByValue: true }, 6000);
            const v = res?.result?.value;
            return typeof v === "string" ? JSON.parse(v) : null;
        }
        catch {
            return null;
        }
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /** ⑤ 工作区信任弹窗（配置 trustWorkspace:true 才自动点——默认不改用户安全状态） */
    async function handleTrustDialog(job, ov) {
        if (!ov?.trustWorkspace)
            return false;
        const ui = await probeUi(job, ov);
        if (!ui?.trust)
            return false;
        pushLine(job, "sys", "[驾驶] 检测到工作区信任弹窗，按配置自动信任（launch_overrides.trustWorkspace=true）");
        await cdpClick(job, ui.trust.x, ui.trust.y);
        await sleep(1000);
        return true;
    }

    /** DOM 注入（原路径，行为不变）：返回 {ok, how|why} */
    async function domInject(job, ov, text) {
        try {
            const res = await cdpCall(job, "Runtime.evaluate", {
                expression: injectScript(ov?.chatSelector ?? "", ov?.sendSelector ?? "", text),
                returnByValue: true,
            }, 8000);
            const v = res?.result?.value;
            return v?.ok ? { ok: true, how: v.how } : { ok: false, why: v?.why ?? "未知原因" };
        }
        catch (e) {
            return { ok: false, why: `异常：${e.message}` };
        }
    }

    /**
     * 等应用界面就绪（可选）：launch_overrides.readySelector 命中才开始注入。
     * 拉起后 CDP 秒连 ≠ 工作台就绪——VS Code 实测连上后 1.25s 按快捷键无反应，
     * 必须等聊天等贡献加载完（默认等 15s，每 700ms 探一次，有界不算死磕）。
     */
    async function waitForReady(job, ov) {
        const sel = ov?.readySelector;
        if (!sel)
            return { ok: true, waited: 0 };
        const timeoutMs = ov?.readyTimeoutMs ?? 15000;
        const deadline = Date.now() + timeoutMs;
        const started = Date.now();
        while (Date.now() < deadline) {
            try {
                const res = await cdpCall(job, "Runtime.evaluate", { expression: `!!document.querySelector(${JSON.stringify(sel)})`, returnByValue: true }, 4000);
                if (res?.result?.value === true)
                    return { ok: true, waited: Date.now() - started };
            }
            catch { /* 界面还没起来，继续等 */ }
            await sleep(700);
        }
        return { ok: false, waited: Date.now() - started };
    }

    /**
     * CDP 打字注入（injectVia:"cdp"）：
     *  就绪等待 → 有界状态机（信任弹窗→点击 / 登录引导→降档 / 面板没开→按 openChat，最多按 openChat.attempts 次）
     *  → 定焦点 → 清空 → Input.insertText → 落字校验 →（send!==false）回车。
     * 每步失败立即降档返回原因，不循环重试（D10）。
     */
    async function cdpTypeInject(job, ov, text) {
        const head = text.trim().replace(/\s+/g, "").slice(0, 6);
        // ① 等界面就绪（没配 readySelector 就直接开始）
        const ready = await waitForReady(job, ov);
        if (!ready.ok)
            return { ok: false, why: `应用界面未就绪（等 ${Math.round(ready.waited / 1000)}s 未见 readySelector ${ov.readySelector}）` };
        if (ready.waited > 1000)
            pushLine(job, "sys", `[驾驶] 界面就绪（等待 ${Math.round(ready.waited / 1000)}s）`);
        // ② 有界状态机：处理弹窗与面板开关（最多 6 步，按键最多 attempts 次）
        const maxPress = ov?.openChat ? (ov.openChat.attempts ?? 2) : 0;
        let pressed = 0;
        let escPressed = 0;
        let ui = null;
        for (let step = 0; step < 10; step++) {
            ui = await probeUi(job, ov);
            if (!ui)
                return { ok: false, why: "界面探测失败（CDP 未返回值）" };
            if (ui.trust && ov?.trustWorkspace) {
                pushLine(job, "sys", "[驾驶] 检测到工作区信任弹窗，按配置自动点击（launch_overrides.trustWorkspace=true）");
                await cdpClick(job, ui.trust.x, ui.trust.y);
                await sleep(1000);
                continue;
            }
            if (ui.signIn)
                return { ok: false, why: "应用要求先登录（登录引导对话框挡住输入）——请在窗口里完成一次性登录后重新派发" };
            // 未知模态（Git 仓库确认、更新提示等）→ Esc 关掉再探（有界 2 次；信任/登录对话框在此分支之前已分流）
            if (ui.dialog && escPressed < 2) {
                escPressed++;
                pushLine(job, "sys", `[驾驶] 界面有对话框挡路，按 Esc 关闭（第 ${escPressed}/2 次）：${String(ui.dialog).slice(0, 60)}`);
                await cdpKey(job, { key: "Escape", code: "Escape", keyCode: 27 });
                await sleep(600);
                continue;
            }
            if (ui.panel)
                break;
            if (ov?.openChat && pressed < maxPress) {
                pressed++;
                pushLine(job, "sys", `[驾驶] 会话面板未开，按 openChat（第 ${pressed}/${maxPress} 次）`);
                await cdpKey(job, ov.openChat);
                await sleep(ov.openChat.waitMs ?? 1200);
                continue;
            }
            break; // 面板没开、也没有可按的了
        }
        if (!ui?.panel) {
            const dialogHint = ui?.dialog ? `；有对话框未能关闭：${String(ui.dialog).slice(0, 60)}` : "";
            return { ok: false, why: `未找到会话输入面（选择器 ${ov?.chatContainer ?? ".chat-input-container"}${ov?.openChat ? `，openChat 已按 ${pressed} 次仍未出现` : "，且未配置 openChat"}${dialogHint}）` };
        }
        if (ui.signIn)
            return { ok: false, why: "应用要求先登录（登录引导对话框挡住输入）——请完成登录后重新派发" };
        // ② 定焦点：点输入面中心；模态遮挡时点不进去 → 降档
        if (!ui.focused) {
            if (!ui.box)
                return { ok: false, why: "会话输入面不可见（宽高为 0）" };
            await cdpClick(job, ui.box.x, ui.box.y);
            await sleep(400);
            ui = await probeUi(job, ov);
        }
        if (!ui?.focused)
            return { ok: false, why: "输入面无法获得焦点（可能有模态对话框遮挡）" };
        // ③ 清空 → 打字 → 落字校验（不清空会把旧文本拼在前面）
        await cdpKey(job, { key: "A", code: "KeyA", keyCode: 65, modifiers: 2 });
        await sleep(150);
        await cdpKey(job, { key: "Backspace", code: "Backspace", keyCode: 8 });
        await sleep(150);
        await cdpCall(job, "Input.insertText", { text }, 8000);
        await sleep(500);
        ui = await probeUi(job, ov);
        const seen = String(ui?.text ?? "").replace(/\s+/g, "");
        if (!head || !seen.includes(head))
            return { ok: false, why: `打字未落入输入面（探到 ${JSON.stringify(String(ui?.text ?? "").slice(0, 30))}）` };
        // ④ 回车发送（send:false 可关）
        if (ov?.send === false)
            return { ok: true, how: "CDP 打字（未发送）" };
        await cdpKey(job, { key: "Enter", code: "Enter", keyCode: 13 });
        // ★ 发送后才弹的登录引导（VS Code 在 submit 时触发）：实测比回车慢 >700ms，
        //   所以有界轮询 3×900ms 抓它——文本进去了但 AI 不会应答，必须按失败如实报
        ui = null;
        for (let i = 0; i < 3; i++) {
            await sleep(900);
            ui = await probeUi(job, ov);
            if (ui?.signIn)
                return { ok: false, why: "文本已提交，但应用要求先登录（Copilot 登录引导在回车后弹出）——AI 不会应答，请完成一次性登录后重新派发" };
        }
        const left = String(ui?.text ?? "").replace(/\s+/g, "");
        return { ok: true, how: left ? `CDP 打字+回车（输入面仍残留 ${left.length} 字，可能未发出）` : "CDP 打字+回车（输入面已清空=已提交）" };
    }

    /** 注入主链：信任弹窗 → dom 路径（原行为）或 cdp 打字路径 → 成败都给明确原因 */
    async function driveInject(job, ov) {
        const text = job.message.slice(0, 4000);
        await handleTrustDialog(job, ov);
        if (ov?.injectVia === "cdp") {
            const r = await cdpTypeInject(job, ov, text);
            pushLine(job, "sys", r.ok
                ? `[驾驶] 任务文本已注入（${r.how}）`
                : `[驾驶] 注入失败：${r.why}——已降档，请手动粘贴任务文本（D10）`);
            return;
        }
        // DOM 路径：先注入；失败且配置了 openChat → 探到面板没开就按一下 → 再注入一次
        let r = await domInject(job, ov, text);
        if (!r.ok && ov?.openChat) {
            const ui = await probeUi(job, ov);
            if (!ui?.panel) {
                await cdpKey(job, ov.openChat);
                await sleep(ov.openChat.waitMs ?? 1200);
                r = await domInject(job, ov, text);
            }
        }
        pushLine(job, "sys", r.ok
            ? `[驾驶] 任务文本已注入（${r.how}）——若未发出请手动补发`
            : `[驾驶] 注入失败：${r.why}——已降档，请手动粘贴任务文本（D10）`);
    }

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
            // 尽力注入任务文本（链路有界：信任弹窗 → dom/CDP 打字 → 降档，不重试死磕 D10）
            try {
                await driveInject(job, ov);
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
            ctx.finalizeCardDispatch?.({ cardId: job.cardId, dispatchId: job.dispatchId, ok, runId: job.runId, actor: job.agent || "dispatch-agent", detail: `${detail}（CDP 驾驶）` });
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
    ctx.startCdpRun = ({ cardId, agentCardId, profile, dispatchId, dispatchKey, taskId, message, agent }) => {
        const runId = `cdp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const job = {
            runId, cardId, agentCardId: agentCardId ?? null, profileId: profile.id, dispatchId: dispatchId ?? null,
            taskId: taskId ?? null, message, profile, status: "queued", lines: [], frame: null, startedAt: null, finishedAt: null,
            agent: agent || "dispatch-agent", // ★ 收口比对用：须与卡上 assignee 同源（见 finish 的 actor）
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
