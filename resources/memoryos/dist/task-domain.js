import { queueVisibleSql, queueVisibleSqlFor, queueClaimError, linkQueueClaim, settleQueueEdges } from './targeted-queue.js';
/**
 * MemoryOS — 任务域领域逻辑（架构重构第 2 条「统一操作注册表，消除双传输层」· 批次 A · 2026-10-14）
 *
 * ── 单一真相源 ──────────────────────────────────────────────────────
 *   本模块承载 REST `GET /api/tasks`（dashboard-reg-memory.js）那套领域语义：任务头解析 / 状态归一 /
 *   依赖提取 / 结论提取 / blocked 补标记 / 七态分桶装配。**逐字自原实现搬出，行为逐字节不变**
 *   （原实现见 git 历史 dashboard-reg-memory.js 中 `app.get("/api/tasks", ...)` 一段）。
 *   注册表（ops-registry.js 的 `tasks.list`）与 REST 路由都指向本模块 —— 领域逻辑只有一份。
 *
 * ── ★ 边界（本批刻意，勿越界"统一"）──────────────────────────────────
 *   仅承载 REST 看板语义。MCP `task_next`（server-reg-task.js）**未**并入本模块 ——
 *   实测两者**非同一套语义**，主要差异：
 *     ① 取数范围：REST = queryByType(status:'active') 取 limit*3；task_next = status IN('active','trial')
 *        且 project IN(?, 'global')，LIMIT 500，另全表扫描算 done 集合。
 *     ② 头字段作用域：REST 对**整段 content** 匹配 assignee/depends；task_next 只匹配**头行**（headLineOf）。
 *     ③ 头正则：REST 用共享 TASK_HEAD_RE（枚举态 | open|claimed）；task_next 用本地 /^...[status:([a-z_]+)]/（更宽）。
 *     ④ 无头处理：REST 回落 status="unknown"；task_next 直接跳过该行（readTaskState 返回 null）。
 *     ⑤ 正文剥离：REST 另剥 [plan:][taskid:] 与「→ 结论(...)」；task_next 只剥头与头行依赖段。
 *     ⑥ 输出形状：REST = 结构化行 + 分桶 JSON；task_next = 多段中文文案（可做集/阻塞/我在做/待决策 + 依赖
 *        传递解析(merged)/死端†/卡片优先级/会话隔离/租约提示等 REST 没有的语义）。
 *   强行合并会造成行为漂移，故本批**只做 REST 侧迁移**，task_next 留待后续批次按各自语义收敛。
 *
 * ── 依赖 ────────────────────────────────────────────────────────────
 *   dashboard-task-util.js（头正则 / 依赖段 / 桶名 —— 与 REST 侧同一份共享常量，不新增副本）
 *   db.js（queryByType —— 只读查询，无写副作用）
 */
import { queryByType, writeMemory, updateMemory, readMemory, appendEvent, logUsage, bumpConfidence, markMerged, logExecAudit, createDispatch, readDispatchByKey, readActiveDispatch, settleDispatch, releaseDispatch, withTx, parseRecordRef, readTaskEventLatest, readTaskEventRows, taskLastActivityDays, upsertVector, syncGrams, invalidateVectorCache, normalizeSector, sectorLambda } from "./db.js";
import { TASK_HEAD_RE, TASK_NORMALIZE, TASK_DEP_RE, TASK_BUCKETS } from "./dashboard-task-util.js";
import { TxAbort, runTaskTx, stateReceipt } from "./tx.js"; // ★ Step 0：事务/回执原语落叶子模块，双方共用无循环依赖
import { a1Hard, A1_HINT } from "./a1-mode.js";
import { setMemoryTerms, refreshMemoryMetadata } from "./memory-metadata.js"; // ★ B4 组1b：任务写入复用同一套关键词/元数据索引
import { createTaskStore } from "./task-store.js"; // ★ 2026-11-16（B4 组1）：任务物理表直连，不再经 temp.memories 跨库 UNION 视图
import { createTaskRow } from "./task-writer.js"; // ★ 2026-11-16（B4 组1b）：任务写入唯一入口（叶子模块，避免与 targeted-queue 环形依赖）

/** ★ 2026-11-16（B4 组1）：任务查询统一指向任务库物理表。
 *  与旧的 `temp.memories`（knowledge_records UNION task_records）在任务侧等价，
 *  但不再依赖跨库 UNION 视图——B8 删除视图后本文件行为不变。 */
const TASKS = "task_store.task_records"; // ★ 2026-11-16（B4 组1）：任务物理表限定名（不依赖 temp.memories 视图）

/** ★ 2026-11-16（B4 组1b）：任务写入统一入口在 task-writer.js（叶子模块），
 *  避免 task-domain ↔ targeted-queue 环形依赖；索引副作用清单一并在该模块维护。 */
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 解析任务行：type='task' 且列 status=status 的记忆 → 结构化行数组（逐字段与原 REST 实现一致）。
 * @param {import("node:sqlite").Database} db
 * @param {{limit?:number, status?:string}} opts
 *   limit —— **调用方（传输适配器）须先行 clamp 到 [1,500]**；本函数按 limit*3 取原始窗口（与原实现同口径，
 *            多取以覆盖「头 status 与列 status 不一致」的存量行）。
 *   status —— 列过滤（REST 侧恒为 "active"）。
 * @returns 行数组：{id,status,assignee,submittedBy,deps,blocked,body,conclusion,concludedBy,confidence,created_at}
 */
export function parseTaskRows(db, { limit = 100, status = "active" } = {}) {
    const raw = createTaskStore({ db }).listTasks({ limit: limit * 3, status });
    const rows = raw.map((r) => {
        const header = headLineOf(r.content);
        const m = header.match(TASK_HEAD_RE);
        const am = header.match(/\[assignee:([^\]]*)\]/);
        const cm = String(r.content).match(/\n→ 结论\(([^)]*)\)[：:]([\s\S]*)$/);
        const dm = header.match(TASK_DEP_RE);
        const rawStatus = m ? m[1] : "unknown";
        const status = rawStatus === "unknown" ? "unknown" : (TASK_NORMALIZE[rawStatus] ?? rawStatus);
        const assignee = am ? am[1] : null;
        const deps = dm ? dm[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : [];
        const body = taskBody(cm ? r.content.slice(0, cm.index) : r.content);
        // ★ 第 5 步：看板与卡/task_next/回执同源（同一解析器 + 同一措辞），字段名统一 acceptance / progress
        const hl = headLineOf(r.content); // 只认头行，避免正文里引用的 [accept:]/[progress:] 被误当元数据
        const acceptance = acceptanceOf(hl);
        return { id: r.id, status, assignee, submittedBy: r.agent, deps, blocked: false, body, body_preview: body.slice(0, 200), body_truncated: false, acceptance, acceptance_text: acceptanceLineOf(acceptance), progress: progressOf(hl), conclusion: cm ? cm[2].trim() : null, concludedBy: cm ? cm[1] : null, confidence: r.confidence, created_at: r.created_at };
    });
    markTaskBlocked(rows);
    return rows;
}

/**
 * 匹配 status 的任务总数（与 parseTaskRows 同一过滤口径：memories 兼容视图 + type/status）。
 * 用途：让调用方知道「库里一共多少 / 本次给了多少」，杜绝看板静默截断。
 */
export function countTaskRows(db, { status = "active" } = {}) {
    return Number(db.prepare(`SELECT COUNT(*) n FROM ${TASKS} WHERE status=? AND type='task'`).get(status)?.n ?? 0);
}

/**
 * 看板载荷：七态分桶 + 完整度契约。
 *   total   —— 保持原语义（本次分桶行数），老调用方逐字节兼容；
 *   totalAll—— 库内匹配该 status 的总数；
 *   shown   —— 本次实际返回行数；truncated/missing —— 是否被窗口截断、还差多少；
 *   hint    —— 仅截断时出现的中文提示（未截断时零新增文案）。
 */
export function taskBoard(db, { limit = 100, status = "active" } = {}) {
    const rows = parseTaskRows(db, { limit, status });
    const totalAll = countTaskRows(db, { status });
    const shown = rows.length;
    const missing = Math.max(0, totalAll - shown);
    const payload = bucketizeTaskRows(rows);
    payload.totalAll = totalAll;
    payload.shown = shown;
    payload.truncated = missing > 0;
    payload.missing = missing;
    if (missing > 0)
        payload.hint = `任务池共 ${totalAll} 条，本次只返回 ${shown} 条，还有 ${missing} 条未显示（调大 limit 可多取，单次上限 500）。`;
    return payload;
}

/**
 * 补 blocked 标记（原地写入行对象的既有 blocked 字段，不改变键序）：
 *   pending 且依赖未全部 done（done 集合仅取**本次行数组内** status==='done' 者，且依赖须在本行集内出现）。
 */
export function markTaskBlocked(rows) {
    const doneIds = new Set(rows.filter((t) => t.status === "done").map((t) => t.id));
    rows.forEach((t) => { t.blocked = t.status === "pending" && t.deps.some((d) => !doneIds.has(d) && rows.some((x) => x.id === d)); });
}

/**
 * 七态分桶装配（与原 REST 返回体同形）。
 * @returns {{total:number} & Record<string, Array>}  { total, pending, in_progress, blocked, done, cancelled, merged, archived }
 */
export function bucketizeTaskRows(rows) {
    const buckets = {};
    TASK_BUCKETS.forEach((b) => { buckets[b] = []; });
    for (const t of rows) {
        if (buckets[t.status])
            buckets[t.status].push(t);
    }
    return { total: rows.length, ...buckets };
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ 2026-10-15（架构重构第 2 条「统一操作注册表」· 批次 B）：MCP `task_next` 的领域计算。
 *
 *   逐字自 server-reg-task.js 的 `task_next.execute` 搬出（**逻辑一字不改**），拆成两半：
 *     · nextTasks(ctx, args)          → 结构化领域值（可做集 / 本人在办 / 待决策 分段，含依赖拓扑入度、
 *                                       状态归一、卡片优先级、派发提示、租约、会话隔离、死端标记、跨 project 提示）；
 *     · renderTaskNextText(structured)→ 中文文案（**一个字符都不改**：空格 / 换行 / `#` / `†` / `…` / 括号 / 顺序）。
 *   这样领域逻辑只留一份，MCP 侧（server-reg-task.js）只做薄适配：invokeOp → renderTaskNextText。
 *
 *   ★ ctx 契约（身份必须在**调用时**解析，严禁注册期冻成常量 —— 那是 1b 刚修掉的坑）：
 *     { db, agentName, readTaskState, taskBody }
 *     · agentName —— accessor（函数），在 nextTasks 内部按调用时刻取值（决定 who 分支）；
 *     · readTaskState / taskBody —— 任务头解析器（server-reg-task.js 内的共享 helper，经 ctx 注入，
 *       **不在本模块复制一份**，避免"同名两份解析逻辑"重新长回来）。
 *
 *   ★ 与 REST 看板语义（parseTaskRows）**不是同一套**（6 处实质差异见文件头），故各自独立、不合并。
 * ══════════════════════════════════════════════════════════════════════ */
export function nextTasks(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const readTaskState = ctx.readTaskState;
    const taskBody = ctx.taskBody;
    // ★ 2026-11-07（#700053）：limit 真正生效（默认 5，上限 50）；task_id 走单卡只读分支。
    const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 50);
    if (args.task_id !== undefined && args.task_id !== null && String(args.task_id).trim() !== "") {
        const id = Number(String(args.task_id).trim().replace(/^[#Tt]-?/, ""));
        if (!Number.isFinite(id))
            return { single: { id: String(args.task_id), error: `无法识别任务号「${args.task_id}」；请用纯数字，如 700053。` } };
        const r = db.prepare(`SELECT id, content, agent, status, project, source_ref, created_at FROM ${TASKS} WHERE id=? AND type='task'`).get(id);
        if (!r)
            return { single: { id, error: `#${id} 不存在或不是任务卡。用 task_next（不带 task_id）看当前可做集。` } };
        const st = readTaskState(r.content);
        const card = String(r.source_ref ?? "").match(/^card:(\d+)$/);
        return {
            single: {
                id: r.id,
                title: taskTitle(r.content),
                body: taskBody(r.content),
                status: st?.status ?? String(r.status),
                assignee: st?.assignee ?? "?",
                project: r.project,
                deps: st?.deps ?? [],
                scope: st?.scope ?? [],
                acceptance: st?.acceptance ?? [],
                progress: st?.progress ?? null,
                created_at: r.created_at,
                source: card ? `卡片#${card[1]}` : "[agent任务]",
                listStatus: String(r.status),
            },
        };
    }
    const rows = db.prepare(`SELECT id, content, agent, source_ref, created_at FROM ${TASKS}
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret' AND ${queueVisibleSqlFor(TASKS)}
       ORDER BY julianday(created_at) DESC, id DESC LIMIT 500`).all(args.project,agentName());
    // ★ 2026-09-19（弊端 M5）：按创建时间降序（新任务优先）+ 超上限显式提示——原升序在积压超 500 条时把新任务埋没
    const totalOpen = db.prepare(`SELECT COUNT(*) n FROM ${TASKS}
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret' AND ${queueVisibleSqlFor(TASKS)}`).get(args.project,agentName()).n;
    // 全体任务状态/依赖解码 + done 集合
    const states = new Map();
    const invalid = []; // ★ C2：头格式异常的任务显式入列（原静默跳过——agent 看不到 = 任务静默消失，问题 #7）
    // ★ 2026-11-07（#700053）：task_next 是清单不是详情页——验收只给条数 + 第 1 条（≤36 字），
    //   进度摘要只给前 30 字；完整清单用 task_next(task_id=…) 或任务卡看。措辞与卡/回执同源。
    const whoLabel = (a) => (!a || a === "?" || isPublicTaskAssignee(a)) ? "未指派" : a;
    const accTagOf = (s) => {
        const acc = s.acceptance ?? [];
        if (!acc.length)
            return "";
        // 清单只给第 1 条（够判断是什么活）；完整清单走 task_id 详情，避免 8 条验收把每行撑到 200+ 字。
        return ` · 验收（${acc.length} 条）：① ${acc[0].slice(0, 36)}${acc.length > 1 ? "…" : ""}`;
    };
    const prTagOf = (s) => {
        const pr = s.progress ?? null;
        if (!pr)
            return "";
        return ` · 进度摘要：${pr.slice(0, 30)}${pr.length > 30 ? "…" : ""}`;
    };
    const compactTagOf = (s) => `${accTagOf(s)}${prTagOf(s)}`;
    for (const r of rows) {
        const st = readTaskState(r.content);
        if (!st) {
            invalid.push({ id: r.id, head: headLineOf(r.content).slice(0, 80) });
            continue;
        }
        states.set(r.id, { st });
    }
    // ★ 2026-09-19（实操复盘查漏）：依赖判定不能只看 active/trial 行 —— 实测 31 条「头 done 但列已归档」
    //   的任务不在上面查询结果里，依赖它们的 pending 任务被永久误判阻塞（生产库实证 6 条假阻塞）。
    //   done 判据改为「头文本 done，不看列」；列 merged 的行不播种（由 winner 状态裁决），
    //   依赖指向 merged 的沿 superseded_by 传递解析到 winner（带环保护）。
    const allTasks = db.prepare(`SELECT id, content, status, superseded_by FROM ${TASKS} WHERE type='task' AND sensitivity != 'secret'`).all();
    const mergeTo = new Map();
    for (const t of allTasks) {
        if (t.status === "merged" && t.superseded_by != null)
            mergeTo.set(Number(t.id), Number(t.superseded_by));
    }
    const resolveTaskId = (id, seen = new Set()) => {
        let cur = Number(id);
        while (mergeTo.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            cur = mergeTo.get(cur);
        }
        return cur;
    };
    const doneIds = new Set();
    for (const t of allTasks) {
        const st = readTaskState(t.content);
        if (st?.status === "done" && t.status !== "merged")
            doneIds.add(resolveTaskId(t.id));
    }
    const depDoneOf = (deps) => deps.every((d) => doneIds.has(resolveTaskId(d)));
    // ★ 2026-09-19（弊端 M6）：依赖死端检测——依赖处于终态（cancelled/archived）或不存在时永远等不到 done，
    //   标注出来让调用方重挂依赖，而不是永久挂起
    const taskById = new Map(allTasks.map((t) => [Number(t.id), t]));
    const depDeadOf = (d) => {
        const t = taskById.get(resolveTaskId(d));
        if (!t)
            return true;
        const stt = readTaskState(t.content)?.status;
        return String(t.status) === "archived" || stt === "cancelled" || stt === "archived";
    };
    const who = !args.as || args.as === "any" ? agentName() : args.as;
    // ★ 2026-09-19（实操问题 #7）：同 agent 多会话隔离 —— 取最近 task_claim 事件的 session_id，
    //   与调用方 session_id 比对：非本会话 → 单列「同名其他会话」，消除「我在做」串台。
    const claimSessionOf = (mid) => {
        try {
            // ★ 2026-11-14（第4项）：先读任务库新表，读不到回退主库旧表（历史事件仍可见）。
            const ev = readTaskEventLatest(db, mid, "task_claim");
            return ev ? (JSON.parse(ev.payload).session_id ?? null) : null;
        }
        catch { return null; }
    };
    const mineOther = [];
    // ★ 2026-09-19（实操问题 #12）：task_next 信息增强 —— mine 附租约剩余（julianday 差值，UTC 安全），
    //   blocked 附最后活动时间（memory_events 最晚一条），减少「要另开接口/直读库才知道」的绕行。
    const leaseTagOf = (mid) => {
        try {
            const r = db.prepare(`SELECT (julianday(lease_expires_at) - julianday('now')) * 1440 AS m FROM cards WHERE id=(SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1)`).get(mid);
            if (!r || r.m == null)
                return " [无租约]";
            return r.m <= 0 ? " [租约已过期，待回收]" : ` [租约剩 ${Math.round(r.m)}min]`;
        }
        catch { return ""; }
    };
    const lastEvtOf = (mid) => {
        try {
            // ★ 2026-11-14（第4项）：任务事件新旧表合并取最近，历史活动时间不丢。
            const d = taskLastActivityDays(db, mid);
            if (d == null)
                return "";
            return d >= 1 ? ` · 最后活动 ${Math.floor(d)} 天前` : ` · 最后活动 ${Math.max(1, Math.round(d * 24))} 小时前`;
        }
        catch { return ""; }
    };
    const avail = [];
    const blocked = [];
    const mine = [];
    // ★ A 2026-09-14：区分卡任务 vs 手动任务；B：优先取卡片 priority 排序
    const isCardTask = (r) => String(r.source_ref ?? "").startsWith("card:");
    // ★ P15（开关默认关）：source_ref 取不到时（task_assign 直派任务），经 dispatch 链接回退——
    //   默认关时 cardOf 恒走 source_ref 单路，与改前逐字节一致。
    const dspMap = prioViaDispatchOn() ? dispatchCardMap(db, rows.map((r) => r.id)) : new Map();
    const cardOf = (r) => {
        const m = String(r.source_ref ?? "").match(/^card:(\d+)$/);
        if (m)
            return Number(m[1]);
        return dspMap.get(Number(r.id)) ?? null;
    };
    // 一次性拉取所涉卡片的 priority
    const cardIds = [...new Set(rows.map(cardOf).filter((n) => n !== null))];
    const cardPrio = new Map();
    if (cardIds.length) {
        const ph = cardIds.map(() => "?").join(",");
        db.prepare(`SELECT id, priority FROM cards WHERE id IN (${ph})`).all(...cardIds).forEach((r) => cardPrio.set(r.id, Number(r.priority ?? 0)));
    }
    const srcTag = (r) => {
        if (isCardTask(r))
            return `[卡片#${cardOf(r)}]`;
        return "[agent任务]";
    };
    const prioOf = (r) => {
        const cid = cardOf(r);
        return cid !== null ? (cardPrio.get(cid) ?? 0) : 0;
    };
    const tsOf = (r) => Date.parse(r.created_at) || 0;
    for (const r of rows) {
        const s = states.get(r.id)?.st;
        if (!s)
            continue;
        const depDone = depDoneOf(s.deps);
        const blockedBy = s.deps.filter((d) => !doneIds.has(resolveTaskId(d)));
        const depLabel = blockedBy.map((dd) => "#" + dd + (depDeadOf(dd) ? "†" : "")).join(", ");
        if (s.status === "pending") {
            if (args.as === "" || args.as === "any" || isPublicTaskAssignee(s.assignee) || s.assignee === who) {
                if (depDone)
                    avail.push({ prio: prioOf(r), key: tsOf(r), label: `#${r.id} ${srcTag(r)} ${whoLabel(s.assignee)}${compactTagOf(s)}\n  ${taskTitle(r.content, 60)}` });
                else
                    blocked.push({ prio: prioOf(r), key: tsOf(r), label: `#${r.id} ${srcTag(r)} 阻塞（等 ${depLabel}） · ${whoLabel(s.assignee)}${lastEvtOf(r.id)}${blockedBy.some(depDeadOf) ? "（†=依赖已终态/不存在：需重挂依赖才能解锁）" : ""}${compactTagOf(s)}\n  ${taskTitle(r.content, 50)}` });
            }
        }
        else if (s.status === "in_progress" && s.assignee === who) {
            const sid = claimSessionOf(r.id);
            const isThisSession = !args.session_id || !sid || sid === args.session_id;
            const leaseTag = leaseTagOf(r.id); // ★ #12：租约剩余一目了然
            const meta = `#${r.id} ${srcTag(r)} 进行中 · by ${s.assignee}${leaseTag}${compactTagOf(s)}`;
            const label = `${meta}\n  ${taskTitle(r.content, 60)}`;
            (isThisSession ? mine : mineOther).push(isThisSession ? label : `${label}（会话 ${sid}）`);
        }
    }
    // ★ B 排序：卡片 priority 高优先，同优先级按创建时间旧的在前
    const sortLane = (a, b) => b.prio - a.prio || a.key - b.key;
    avail.sort(sortLane);
    blocked.sort(sortLane);
    // ★ 2026-10-03（批次 A2）：待决策段 —— 把「租约到期仍挂着 / 已贴条待回收」的活显式列出。
    //   对标 Orca J2：到期与沉默只是检查点，不授权回收；但必须让人看得见，否则无人裁决 = 永久积压。
    const fmtDur = (min) => {
        const m = Math.max(0, Number(min) || 0);
        if (m < 60)
            return `${Math.round(m)} 分钟`;
        if (m < 1440)
            return `${Math.round(m / 60)} 小时`;
        return `${Math.round(m / 1440)} 天`;
    };
    const pendMap = new Map(); // memoryId（卡无关联任务时退化为 card:<id>）→ { who, tags[] }
    try {
        const overdue = db.prepare(`SELECT memory_id, agent, (julianday('now') - julianday(lease_expires_at)) * 1440 AS m
           FROM dispatches WHERE state='active' AND julianday(lease_expires_at) < julianday('now')
           ORDER BY lease_expires_at ASC LIMIT 50`).all();
        for (const o of overdue) {
            const mid = Number(o.memory_id);
            const e = pendMap.get(mid) ?? { who: o.agent, tags: [] };
            e.tags.push(`工作证过期 ${fmtDur(o.m)}`);
            pendMap.set(mid, e);
        }
        // ★ 批次 B1（2026-10-03）：stale 工作证（reaper 已标「待裁决」）显式进「待处理」——
        //   不再自动回收后，这是人/agent 发现积压卡的**唯一入口**；据此决定 heartbeat 复活 / takeover 接管 / release 归还。
        const staleDsp = db.prepare(`SELECT memory_id, agent, generation FROM dispatches WHERE state='stale' ORDER BY id ASC LIMIT 50`).all();
        for (const s of staleDsp) {
            const mid = Number(s.memory_id);
            const e = pendMap.get(mid) ?? { who: s.agent, tags: [] };
            e.tags.push(`工作证已置 stale（gen=${s.generation}，待裁决：heartbeat 复活 / takeover 接管 / release 归还）`);
            pendMap.set(mid, e);
        }
    }
    catch { /* 待决策段失败不影响主清单 */ }
    try {
        const graceH = Math.max(0, Number(process.env.MEMORYOS_LEASE_GRACE_HOURS ?? 24));
        const noticed = db.prepare(`SELECT id AS card_id, assignee, (julianday('now') - julianday(lease_notice_at)) * 24 AS h
           FROM cards WHERE status='running' AND lease_notice_at IS NOT NULL
           ORDER BY lease_notice_at ASC LIMIT 50`).all();
        for (const n of noticed) {
            let mid = null;
            try {
                const rel = db.prepare(`SELECT memory_id FROM card_memory WHERE card_id=? AND relation='dispatch' LIMIT 1`).get(Number(n.card_id));
                mid = rel ? Number(rel.memory_id) : null;
            }
            catch { mid = null; }
            const key = mid ?? `card:${n.card_id}`;
            const e = pendMap.get(key) ?? { who: n.assignee, tags: [] };
            e.tags.push(`已贴提醒条 ${fmtDur(Number(n.h) * 60)}（超 ${graceH} 小时转「待裁决」，不再自动回收）`);
            pendMap.set(key, e);
        }
    }
    catch { /* 同上：卡片侧查询失败不阻断 */ }
    const pendingDecisions = [];
    for (const [key, e] of pendMap) {
        if (typeof key === "number") {
            const row = taskById.get(key);
            const body = row ? `\n  ${taskTitle(row.content, 40)}` : "";
            pendingDecisions.push(`#${key} ${whoLabel(e.who)} · ${e.tags.join(" · ")}${lastEvtOf(key)}${body}`);
        }
        else
            pendingDecisions.push(`卡片 #${String(key).slice(5)} ${whoLabel(e.who)} · ${e.tags.join(" · ")}`);
    }
    // ★ 2026-09-15：跨 project 回退提示 —— 指定 project 无开放任务且确实存在其他 project 的任务时，
    //   明确提示而非静默空结果（避免『任务存在但领不到』）。
    //   （原实现把这段拼在文案末尾；此处归为**领域计算**：它要查库，只把结果串交给渲染层）
    let crossProjectHint = "";
    if (avail.length === 0 && args.project !== "global") {
        try {
            const other = db.prepare(`SELECT project, COUNT(*) c FROM ${TASKS} WHERE type='task' AND status IN ('active','trial') AND project != 'global' AND project != ? AND sensitivity != 'secret' GROUP BY project`).all(args.project);
            if (other.length) {
                crossProjectHint = `\n\n跨 project 提示：当前 project='${args.project}' 无可用任务。其他 project 有开放任务 ${other.map((o) => `${o.project}(${o.c})`).join("、")}，可用 project 参数切换查询。`;
            }
        }
        catch {
            /* 统计失败不回退原返回 */
        }
    }
    // ★ 2026-11-07（#700053）：每段默认只给 limit 条，余量用一行提示带出，避免「一次 4KB 淹掉重点」。
    return {
        who,
        limit,
        avail: avail.map((x) => x.label).slice(0, limit),
        availTotal: avail.length,
        blocked: blocked.map((x) => x.label).slice(0, limit),
        blockedTotal: blocked.length,
        mine,
        mineOther,
        pendingDecisions: pendingDecisions.slice(0, limit),
        pendingTotal: pendingDecisions.length,
        invalid, // ★ C2：格式异常段（空集时渲染层不输出，零漂移）
        crossProjectHint,
        totalOpen,
        rowsShown: rows.length,
    };
}

/**
 * 把 nextTasks 的结构化领域值渲染成 MCP 文案。
 * ★ 2026-11-07（#700053）：改为「元信息一行 + 标题一行」的清单式输出；每段受 limit 约束，
 *   余量用一行提示带出；task_id 分支渲染单卡详情。
 * @param {{single?:object, who:string, avail:string[], blocked:string[], mine:string[], mineOther:string[],
 *          pendingDecisions:string[], crossProjectHint:string, totalOpen:number, rowsShown:number,
 *          limit?:number, availTotal?:number, blockedTotal?:number, pendingTotal?:number}} s
 * @returns {string}
 */
export function renderTaskNextText(s) {
    if (s?.single)
        return renderTaskStatusText(s.single);
    const more = (total, shown) => (Number(total) > shown ? `\n…另有 ${total - shown} 条（传 limit=${Math.min(50, total)} 查看，上限 50）` : "");
    // ★ 2026-11-08（卡外 item6）：整段输出**硬上限 1500 字符**。
    //   limit 只决定「最多取几条」，真正显示条数还必须受字符预算约束 ——
    //   否则 limit=50 时四段各 50 条会把输出撑到 2300+ 字符（实测 2331），超过 MCP 输出线。
    //   分配方式：各段**轮转**（每轮每段各加一条），保证每段都有代表，而不是前段吃光预算；
    //   默认 limit=5 且条目不多时预算充足，输出与改前逐字一致（实测默认 469 字符）。
    const HARD = 1500;
    const FIXED_RESERVE = 340; // 头 + 各段标题 + 空态文案 + more/上限提示的保守开销
    let budget = HARD - FIXED_RESERVE;
    const segs = [
        { list: s.avail, total: s.availTotal, omitEmpty: false, title: "可做（pending 且依赖done，按优先级）", empty: "（暂无，检查阻塞项）" },
        { list: s.blocked, total: s.blockedTotal, omitEmpty: false, title: "阻塞（依赖未完成）", empty: "（无）" },
        { list: s.mine, total: s.mine.length, omitEmpty: false, title: "我在做", empty: "（无进行中任务）" },
        { list: s.mineOther ?? [], total: (s.mineOther ?? []).length, omitEmpty: true, title: "同名其他会话进行中（非本会话，勿动）", empty: "" },
        { list: s.pendingDecisions, total: s.pendingTotal, omitEmpty: false, title: "待处理（需要拿主意）", empty: "（无）" },
        { list: (s.invalid ?? []).map((x) => `#${x.id} ${x.head}`), total: (s.invalid ?? []).length, omitEmpty: true, title: "格式异常（任务头无法解析，工具/地图均不可见，需修 content 首行头）", empty: "" },
    ];
    const idx = segs.map(() => 0);
    const shown = segs.map(() => []);
    for (let progressed = true; progressed && budget > 0;) {
        progressed = false;
        for (let k = 0; k < segs.length; k++) {
            const g = segs[k];
            if (idx[k] >= g.list.length)
                continue;
            const line = g.list[idx[k]];
            const cost = line.length + 1;
            if (cost > budget)
                continue; // 这条放不下 → 先给别的段腾挪机会；整轮无进展则结束
            budget -= cost;
            shown[k].push(line);
            idx[k]++;
            progressed = true;
        }
    }
    let out = `【task_next · as=${s.who}】`;
    if (s.totalOpen != null)
        out += ` 开放 ${s.totalOpen} 条`;
    segs.forEach((g, k) => {
        if (!g.list.length && g.omitEmpty)
            return;
        const body = shown[k].length
            ? shown[k].join("\n")
            : (g.list.length ? `（${g.list.length} 条未展开：受输出长度限制，用 task_next(task_id=…) 或看板查看）` : g.empty);
        out += `${k === 0 ? "\n" : "\n\n"}${g.title}:\n${body}${more(g.total, shown[k].length)}`;
    });
    if (s.crossProjectHint)
        out += s.crossProjectHint;
    // ★ 2026-09-19（弊端 M5）：超上限显式提示——任务数超过 500 条窗口时旧部分不显示
    if (s.totalOpen > s.rowsShown)
        out += "\n（上限提示：共 " + s.totalOpen + " 条任务，仅显示最近 " + s.rowsShown + " 条）";
    return out;
}
/** 单卡详情（task_next(task_id=…)）：状态/负责人/进度/验收一次看全，不必开网页。 */
function renderTaskStatusText(t) {
    if (t.error)
        return `【task_next · task ${t.id}】\n${t.error}`;
    const who = !t.assignee || t.assignee === "?" ? "未指派" : t.assignee;
    let out = `【task_next · task #${t.id}】\n`;
    out += `状态：${t.status}\n负责人：${who}\n标题：${t.title}\n`;
    out += `项目：${t.project ?? "global"} · 来源：${t.source} · 创建：${t.created_at}\n`;
    if (t.deps?.length)
        out += `依赖：${t.deps.map((d) => "#" + d).join(", ")}\n`;
    if (t.scope?.length)
        out += `占用范围：${t.scope.join(", ")}\n`;
    out += `验收（${t.acceptance?.length ?? 0} 条）：${t.acceptance?.length ? acceptanceLineOf(t.acceptance).replace(/^验收（[^）]*）：/, "") : "无验收标准"}\n`;
    out += `进度摘要：${t.progress ?? "（无）"}`;
    if (t.body != null)
        out += `\n\n任务正文（${t.body.length} 字，完整）：\n${t.body}`;
    return out;
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ 2026-10-15（批次 B）：REST `POST /api/task`（看板人工建任务）的领域逻辑。
 *   逐字自 dashboard-reg-memory.js 该路由搬出（**入参校验后的 content 拼装 + embedding + 写库**），
 *   RESTRICTED 门禁与「标题非空」400 校验留在**传输层**（属 HTTP 协议行为，不属领域）。
 *   返回值 = 裸领域结果 `{ ok:true, id, status, assignee, deps }`（与改前响应体逐字节一致）。
 *   ctx 契约：{ db, writeMemory, logUsage, logDaemon, getEmbedder }（embed 经 ctx 注入，
 *   使本模块**不**依赖 embed.js/ML 层 —— 避免把 543MB ONNX 运行时拖进 MCP 工具面）。
 * ══════════════════════════════════════════════════════════════════════ */
export async function createTaskMemory(ctx, args = {}) {
    const { db, writeMemory, logUsage, logDaemon, getEmbedder } = ctx;
    const b = args ?? {};
    const title = String(b.title ?? "").trim();
    const statusRaw = String(b.status ?? "pending").trim();
    const status = TASK_BUCKETS.includes(statusRaw) ? statusRaw : "pending";
    const assignee = isPublicTaskAssignee(b.assignee) ? "?" : String(b.assignee).trim();
    const deps = Array.isArray(b.depends)
        ? b.depends.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
    const summary = String(b.summary ?? "").trim();
    const depTag = deps.length ? `[depends:${deps.join(",")}]` : "";
    const content = `[task][assignee:${assignee}][status:${status}]${depTag} ${title}${summary ? "\n\n" + summary : ""}`;
    let embedding = null;
    try {
        const [v] = await (await getEmbedder()).embedTexts([content]);
        embedding = v ?? null;
    }
    catch {
        embedding = null; // 嵌入暂不可用 → 建任务照常
    }
    let result;
    withTx(db, () => {
        const row = createTaskRow(db, {
        content,
        type: "task",
        agent: "human:dashboard",
        agent_fpath: null,
        project: String(b.project ?? "global").trim() || "global",
        embedding,
        confidence: 0.8,
    });
    // ★ 2026-11-08（卡外 item5）：嵌入失败不再「静默丢向量」。
    //   取舍：选「置 embedding_stale=1 交给 daemon 每小时 reembedStale 补算」，不选「建卡请求内同步重试」——
    //   ① 重试仍是同步阻塞，用户建卡要等一个可能持续失败的嵌入；② 进程重启/暂时不可用时重试也救不回来，
    //   而 stale 标记是落盘的、跨重启有效、幂等；③ 补算通道已存在（reembedStale），且 upsertVector 会按
    //   recordOwnership 自动把任务向量落到任务库，无需新增第二条写入路径。
    if (!embedding)
        db.prepare(`UPDATE ${TASKS} SET embedding_stale=1 WHERE id=?`).run(row.id);
    logUsage(db, { memory_id: row.id, event: "write", reader_agent: "human:dashboard", writer_agent: "human:dashboard", project: row.project, is_task: true });
    logDaemon(db, {
        task: "manual-task",
        op: "create",
        memory_id: row.id,
        operator: "human:dashboard",
        detail: `看板新建任务 #${row.id}（${status} · ${assignee}）：${title.slice(0, 60)}`,
    });
    const mappedStatus = ({pending:'ready',open:'ready',in_progress:'running',claimed:'running',blocked:'blocked',done:'done',cancelled:'cancelled',archived:'archived'})[status] || 'ready';
    const cardId = Number(db.prepare("INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,assignee,priority) VALUES('default','task',?,?,?,'memory',?,?,3)").run(title,summary,mappedStatus,row.id,assignee).lastInsertRowid);
    db.prepare("INSERT INTO card_memory(card_id,memory_id,relation) VALUES(?,?,'dispatch')").run(cardId,row.id);
    for(const dep of deps) {
      const target = db.prepare("SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1").get(dep);
      if(target) db.prepare("INSERT OR IGNORE INTO links(src_kind,src_id,dst_kind,dst_id,kind) VALUES('card',?,'card',?,'depends')").run(cardId,target.card_id);
    }
    if(deps.length && mappedStatus==='ready') db.prepare("UPDATE cards SET status='todo' WHERE id=?").run(cardId);
    db.prepare("INSERT INTO card_events(card_id,actor,action,to_status,detail) VALUES(?,'human:dashboard','create',?,'创建任务与地图卡')").run(cardId,mappedStatus);
    result = { ok: true, id: row.id, task_id:row.id, card_id:cardId, status, assignee, deps };
    });
    return result;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * ★ Step 0（2026-10-18）：MCP task_* 写工具的**领域核心** —— 自 server-reg-task.js 注册闭包**逐字搬出**。
 *
 * 动机：写逻辑此前窝在传输层闭包里，探针无法调用真实代码（只能复述行号），也违反本仓
 *   「传输层零领域逻辑」纪律。搬出后：MCP 传输层只留 zod 入参 + 幂等包装 + addTool 注册 +
 *   文案组装入口；领域函数可被探针/其他传输直接调用。
 *
 * ctx 契约（调用方注入，**调用时解析**，严禁注册期冻成常量——1b 刚修掉的坑）：
 *   {
 *     db,                    // DatabaseSync
 *     agentName, agentFpath, // 调用方身份 accessor（server-tools.js · AsyncLocalStorage）
 *     envCredential,         // MCP 配置注入的本 agent 凭据 accessor
 *     isCredentialValid,     // A1 凭据校验（server-tools.js）
 *     nowIso,                // ISO 时间
 *     requestAbortSignal,    // 请求取消信号（direct 模式恒 null）
 *     killTree,              // exec-tools.js：验收子进程被取消时杀进程树
 *   }
 *
 * 纪律：① 回执文案（含 ⟨state⟩ 终态行）属领域回执，逐字节不变——冒烟 smoke-mcp / smoke-p26 断言即契约；
 *   ② 与 REST 看板语义（parseTaskRows 等）仍**不是同一套**（6 处差异见文件头），各自独立不合并；
 *   ③ 慢活（runTaskGate 子进程）绝不进事务；卡片投影 best-effort（失败留痕不阻断）。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** ★ E-0 裁决落码：持久状态集合（review/failed 已取消，存量经 TASK_NORMALIZE 归一；archived 为记忆轴终态） */
export const TASK_STATUSES = ["pending", "in_progress", "blocked", "done", "cancelled", "merged", "archived"];
/** 合法迁移白名单：源状态 → 允许的目标状态；终态不可直接转回，重开走 task_reopen（reopened 语义留痕） */
export const TASK_TRANSITIONS = {
    pending: ["in_progress", "cancelled"],
    in_progress: ["blocked", "done", "cancelled"],
    blocked: ["in_progress", "cancelled"],
    done: [],
    cancelled: [],
    merged: [],
    archived: [],
};
/** 校验迁移合法性，非法返回错误提示；空/可写由调用方决定 */
export function assertTransition(from, to) {
    const allowed = TASK_TRANSITIONS[from] || [];
    if (!allowed.includes(to)) {
        return `非法状态迁移 ${from} → ${to}（白名单: ${allowed.join(", ") || "终态不可迁移"}）`;
    }
    return null;
}
/** ★ 2026-09-19（实操问题 #6）：assignee 白名单 —— 小写 kebab；"?" 为未指派哨兵放行 */
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
// Public assignment markers are task data; as="any" remains an explicit privileged operation.
export function isPublicTaskAssignee(name) {
    return ["", "?", "any", "unassigned"].includes(String(name ?? "").trim());
}
export function assertAssignee(name) {
    if (name === undefined || name === null || name === "" || name === "?")
        return null;
    if (typeof name !== "string" || !AGENT_NAME_RE.test(name))
        return `assignee「${name}」不合规：须为小写字母开头的 kebab 标识（[a-z][a-z0-9_-]{0,31}，如 codex/trae/zcode/workbuddy）；"?" 表示未指派。`;
    return null;
}
/** ★ 2026-09-18（实操问题 #1，P0）：按 id 分支的列守卫。readMemory 是裸 WHERE id=?（无 status 过滤），
 *  实测 29 条任务「头 pending 但列已 archived/merged」——列表分支有列过滤挡住，按 id 分支只看头文本会放行。 */
export function assertTaskAlive(row) {
    if (!["active", "trial"].includes(String(row.status ?? ""))) {
        return `#${row.id} 列状态为 ${row.status}（${row.status === "merged" ? "已被其他任务取代" : "已归档"}），不可按 id 操作；请用 task_next 取当前可做集。`;
    }
    return null;
}
/** content 头正则：兼容七态 + 存量三态（open/claimed/done）。
 *  ⚠ 与 REST 侧 dashboard-task-util.js 的 TASK_HEAD_RE **同名不同义**（枚举态集合不同）——故此处加 _MCP 后缀防混用。 */
const TASK_HEAD_RE_MCP = /^\[task\]\[assignee:[^\]]*\]\[status:([a-z_]+)\]/;
export function taskHead(status, assignee) {
    return `[task][assignee:${assignee}][status:${status}]`;
}
/** ★ 2026-09-19（弊端 H4/H5）：头字段（status/assignee/depends/gate）只解析头行——正文里引用的标记视为普通正文 */
export function headLineOf(content) {
    const s = String(content ?? "");
    const i = s.indexOf("\n");
    return i < 0 ? s : s.slice(0, i);
}
export function readTaskState(content) {
    const m = String(content ?? "").match(TASK_HEAD_RE_MCP);
    if (!m)
        return null;
    const hl = headLineOf(content);
    const am = hl.match(/\[assignee:([^\]]*)\]/);
    const dm = hl.match(TASK_DEP_RE);
    const deps = dm ? dm[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : [];
    const sm = hl.match(TASK_SCOPE_SEG_RE);
    const scope = sm ? sm[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
    const acceptance = acceptanceOf(hl);
    const progress = progressOf(hl);
    return { assignee: am ? am[1] : "?", status: TASK_NORMALIZE[m[1]] || m[1], deps, scope, acceptance, progress };
}
/** 拆掉状态头、头行占用范围段与依赖段的纯正文（正文中引用的标记属正文，不剥） */
export function taskBody(content) {
    const source = String(content ?? "");
    const header = headLineOf(source);
    if (!TASK_HEAD_RE_MCP.test(header)) return source.trim();
    // 只剥首行紧随任务头的元数据；换行后的 [scope:] 等必须原样保留。
    const first = header.replace(TASK_HEAD_RE_MCP, "")
        .replace(/^(?:[ \t]*\[(?:scope|depends|accept|progress|plan|taskid|gate):[^\]\r\n]*\])*/, "");
    return (first + source.slice(header.length)).trim();
}
/** ★ 2026-11-07（#700053）：任务标题 = 正文第一条**非空、非分隔线**的行，剥掉 markdown 标记。
 *  旧实现直接 taskBody().slice(0,80)，正文以「# 标题」开头时把 `#` 与后续行一起塞进任务行，
 *  单条跨四五行的根因之一。标题只取一行、最多 80 字。 */
export function taskTitle(content, max = 80) {
    for (const raw of taskBody(content).split("\n")) {
        const line = raw.trim();
        if (!line)
            continue;
        if (/^[-=*_]{3,}$/.test(line)) // 分隔线
            continue;
        const t = line.replace(/^#{1,6}\s*/, "").replace(/^[*_`>\-\s]+/, "").trim();
        if (t)
            return t.slice(0, max);
    }
    return "(无标题)";
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ 第二批·第 5 步：验收标准（acceptance）与交接进度摘要（progress）
 *   存在任务头段（[accept:…]、[progress:…]），与 scope/depends 同源：
 *   卡 / task_next / 看板 / 回执四处都从这一份解析结果渲染，不各写一套。
 *   · 验收条目 `|` 分隔（条目内的 `]`/`|` 会被清洗掉），最多 8 条、每条 ≤80 字
 *   · 进度摘要单段 ≤ PROGRESS_MAX 字（提交/释放/换手/租约回收同一套格式）
 * ══════════════════════════════════════════════════════════════════════ */
const ACCEPT_SEP = "|";
const ACCEPT_MAX_ITEMS = 8;
const ACCEPT_MAX_LEN = 80;
export const PROGRESS_MAX = 120;
const ACCEPT_SEG_RE = /\[accept:([^\]]*)\]/;
const PROGRESS_SEG_RE = /\[progress:([^\]]*)\]/;
function sanitizeHeadText(s, max) {
    return String(s ?? "").replace(/[\[\]|]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
/** 规整验收标准入参：数组或换行/| 分隔字符串 → 清洗后的条目数组 */
export function normalizeAcceptance(v) {
    const raw = Array.isArray(v) ? v : String(v ?? "").split(/[\n|]/);
    const items = raw.map((s) => sanitizeHeadText(s, ACCEPT_MAX_LEN)).filter(Boolean);
    if (items.length > ACCEPT_MAX_ITEMS)
        return { ok: false, msg: `⚠ 验收标准最多 ${ACCEPT_MAX_ITEMS} 条（收到 ${items.length} 条），请合并或拆分任务。` };
    return { ok: true, items };
}
/** 头段 → 条目数组（taskBodyWithDep 构造时也用它，保证写读同一口径） */
export function acceptanceOfSeg(v) {
    if (v == null)
        return [];
    const arr = Array.isArray(v) ? v : String(v).split(ACCEPT_SEP);
    return arr.map((s) => sanitizeHeadText(s, ACCEPT_MAX_LEN)).filter(Boolean).slice(0, ACCEPT_MAX_ITEMS);
}
/** 从任务正文解析验收条目（无 = 空数组） */
export function acceptanceOf(content) {
    const m = String(content ?? "").match(ACCEPT_SEG_RE);
    return m ? acceptanceOfSeg(m[1]) : [];
}
/** 从任务正文解析交接进度摘要（无 = null；超长按 PROGRESS_MAX 截断——外部直写/旧数据也守住「别写成长篇」） */
export function progressOf(content) {
    const m = String(content ?? "").match(PROGRESS_SEG_RE);
    return m ? m[1].trim().slice(0, PROGRESS_MAX) : null;
}
/** 验收条目 → 单行展示（卡 / task_next / 看板 / 回执共用这一份措辞） */
export function acceptanceLineOf(items) {
    const arr = acceptanceOfSeg(items);
    if (!arr.length)
        return "";
    const mark = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
    return `验收（${arr.length} 条）：${arr.map((s, i) => `${mark[i] ?? `(${i + 1})`} ${s}`).join("；")}`;
}
/** 进度摘要 → 统一措辞（提交/释放/换手/租约回收都走这里） */
export function progressLineOf(p) {
    const t = sanitizeHeadText(p, PROGRESS_MAX);
    return t ? `进度摘要：${t}` : "";
}
/** 构造正文时保留占用范围段与依赖段（scope 缺省 = 未声明，旧调用零影响）
 *  ★ 第 5 步：extra.acceptance / extra.progress 同步保留（不传 = 旧行为逐字节不变） */
export function taskBodyWithDep(status, assignee, deps, body, scope = [], extra = {}) {
    const depStr = deps.length ? ` [depends:${deps.join(",")}]` : "";
    const scopeStr = scope.length ? ` [scope:${scope.join(",")}]` : "";
    const accept = acceptanceOfSeg(extra.acceptance ?? extra.accept);
    const acceptStr = accept.length ? ` [accept:${accept.join(ACCEPT_SEP)}]` : "";
    const prog = extra.progress ? ` [progress:${sanitizeHeadText(extra.progress, PROGRESS_MAX)}]` : "";
    return `${taskHead(status, assignee)}${scopeStr}${depStr}${acceptStr}${prog} ${body}`;
}
/** ★ 2026-09-19（弊端 H4，纵深一层）：写入任务正文的自由文本（结论/原因）中性化其可能引用的状态标记 */
export function sanitizeTaskText(t) {
    return String(t ?? "").replace(/\[(status|depends|gate|assignee|scope):/g, "〔$1:");
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ 第二批·第 3 步：任务级「占用范围」（scope）
 *   语义：任务卡可选声明自己要动的路径（工作区相对路径或目录前缀），认领时与**同一工作区内所有
 *   处于 in_progress 的任务**比对；撞同一片 → 排队（保持 pending），未声明 scope = 空集 = 永不冲突。
 *   为什么放在任务头而非卡片 meta：认领/回收走的是任务记忆 CAS，冲突判定与状态判定必须同一事务、
 *   同一份真相源；卡片只是投影，卡片侧再判会引入两套口径的漂移。
 * ══════════════════════════════════════════════════════════════════════ */
const TASK_SCOPE_SEG_RE = /\[scope:([^\]]*)\]/;
/** 规整 scope 入参：逗号分隔 → 去空白/去 `./` 前缀/反斜杠转 `/`/去尾 `/`；拒绝绝对路径与 `..` */
export function normalizeScope(v) {
    const raw = Array.isArray(v) ? v.join(",") : String(v ?? "");
    const items = raw.split(",").map((s) => s.trim()).filter(Boolean)
        .map((s) => s.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, ""))
        .filter(Boolean);
    const bad = items.find((s) => /^(?:\/|[A-Za-z]:\/)/.test(s) || s.split("/").includes(".."));
    if (bad)
        return { ok: false, msg: `⚠ scope 项「${bad}」不合法：只接受工作区相对路径或目录前缀（如 src/api、resources/memoryos/dist），不得为绝对路径、不得含 ..` };
    return { ok: true, scope: [...new Set(items)] };
}
/** 路径前缀重叠判定（Windows 大小写不敏感）：相等或一方是另一方的前缀（按 `/` 分段）→ 冲突 */
export function scopeOverlaps(a, b) {
    for (const p of a) {
        for (const q of b) {
            const x = String(p).toLowerCase().replace(/\/+$/, "");
            const y = String(q).toLowerCase().replace(/\/+$/, "");
            if (x === y || x.startsWith(y + "/") || y.startsWith(x + "/"))
                return `${p} ↔ ${q}`;
        }
    }
    return null;
}
/** 找同工作区内与该 scope 冲突的在办任务（排除自身；只认 in_progress 且已声明 scope 者） */
export function scopeConflictOf(db, selfId, scope) {
    if (!scope?.length)
        return null;
    try {
        const rows = db.prepare(`SELECT id, content FROM ${TASKS} WHERE type='task' AND status IN ('active','trial')
            AND sensitivity != 'secret' AND id != ?`).all(Number(selfId) || 0);
        for (const r of rows) {
            const st = readTaskState(r.content);
            if (!st || st.status !== "in_progress" || !st.scope?.length)
                continue;
            const hit = scopeOverlaps(scope, st.scope);
            if (hit)
                return `与在办任务 #${r.id}（${st.assignee || "?"}）声明的范围「${hit}」重叠`;
        }
    }
    catch { return null; }
    return null;
}
/** 读在办任务的到期租约：active/stale dispatch 优先，其次投影卡；无任何租约记录 → null（不自动回收，
 *  仍需显式 takeover —— 避免把「历史 in_progress 但没租约」的任务批量误回收）。 */
export function expiredLeaseOf(db, memoryId) {
    try {
        const d = db.prepare(`SELECT lease_expires_at, heartbeat_at, agent, generation FROM dispatches
            WHERE memory_id=? AND state IN ('active','stale') ORDER BY generation DESC LIMIT 1`).get(Number(memoryId));
        const c = db.prepare(`SELECT lease_expires_at, heartbeat_at, assignee FROM cards
            WHERE id=(SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1)`).get(Number(memoryId));
        const exp = d?.lease_expires_at || c?.lease_expires_at || null;
        if (!exp)
            return null;
        // ★ 必须用 julianday(?) 包住参数：直接写 `? - julianday('now')` 会走 SQLite 数值亲和，
        //   把 '2026-11-04T14:08:10Z' 强转成 2026 → 结果恒为负 → 所有在办任务都被误判「已过期」（实测踩到）。
        const late = db.prepare(`SELECT (julianday(?) - julianday('now')) * 1440 AS m`).get(String(exp).replace(" ", "T"))?.m;
        if (late == null || Number(late) > 0)
            return null; // 未到期
        return {
            expiredAt: String(exp), lateMinutes: Math.round(-Number(late)),
            prevAssignee: d?.agent ?? c?.assignee ?? "?", prevHeartbeat: d?.heartbeat_at ?? c?.heartbeat_at ?? null,
            generation: d?.generation ?? null,
        };
    }
    catch { return null; }
}
/** 前手留下的进度摘要（接手方可见）：最近一次检查点 → 心跳时间 → 兜底「无进度记录」 */
export function leaseProgressOf(db, memoryId) {
    const parts = [];
    try {
        const c = db.prepare(`SELECT id FROM cards WHERE id=(SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1)`).get(Number(memoryId));
        if (c?.id) {
            const cp = db.prepare(`SELECT author, created_at, task_state FROM task_checkpoints WHERE card_id=? ORDER BY version DESC LIMIT 1`).get(c.id);
            if (cp) {
                const ts = (() => { try { const o = JSON.parse(cp.task_state || "{}"); return o.note || o.summary || o.progress || ""; } catch { return ""; } })();
                parts.push(`检查点#${cp.id}（${cp.author}，${cp.created_at}）${ts ? `：${String(ts).replace(/\s+/g, " ").slice(0, 80)}` : ""}`);
            }
            const ev = db.prepare(`SELECT action, detail, created_at FROM card_events WHERE card_id=? ORDER BY id DESC LIMIT 1`).get(c.id);
            if (ev)
                parts.push(`最近卡事件「${ev.action}」（${ev.created_at}）`);
        }
    }
    catch { /* 进度是增值信息，取不到不影响回收 */ }
    return parts.length ? parts.join("；") : "无检查点/事件记录（前手未留进度）";
}

/* ══════════════════════════════════════════════════════════════════════
 * ★ 第二批·第 5 步：防重复发布（发布前查重）
 *   比对三个维度：标题相似 / 声明范围重叠 / 同一验收条件。
 *   · 有实质性命中（范围或验收撞）→ **拒绝**并点名，除非 force=true 显式强制；
 *   · 只有标题相似（范围与验收都不同）→ 只提示、不阻挡（按需求第三条）。
 * ══════════════════════════════════════════════════════════════════════ */
function normTitle(s) {
    return String(s ?? "").split("\n")[0].replace(/\[[^\]]*\]/g, "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}
const round2 = (n) => Math.round(n * 100) / 100;
/** ★ #700057：标题相似度改为**打分**（0..1，命中阈值仍是 0.6），供回执回显「凭什么判相似」。
 *  包含关系按长度比计分；否则 bigram Jaccard。原实现只返回布尔，回执里只有「标题相似」四个字。 */
function titleSimilarity(a, b) {
    if (!a || !b)
        return 0;
    if (a === b)
        return 1;
    if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)))
        return round2(Math.min(a.length, b.length) / Math.max(a.length, b.length));
    const grams = (s) => {
        const set = new Set();
        for (let i = 0; i < s.length - 1; i++)
            set.add(s.slice(i, i + 2));
        return set;
    };
    const A = grams(a), B = grams(b);
    if (!A.size || !B.size)
        return 0;
    let inter = 0;
    for (const g of A)
        if (B.has(g))
            inter++;
    return round2(inter / (A.size + B.size - inter));
}
const TITLE_SIMILAR_MIN = 0.6;
/** ★ #700057：通用验收句（测试全绿 / 控制台 0 报错 / 有回滚说明）不计入「同一验收条件」——
 *  这类句子放之四海皆可，拿它当实质重复会把查重变成狼来了（审核当场被误拦两次）。 */
const GENERIC_ACCEPT_RE = /(测试|用例|冒烟|smoke|test|lint|构建|build|编译|ci)[^，。;；]{0,12}(全绿|通过|0报错|无报错|成功|pass)|(控制台|console)[^，。;；]{0,10}(0|无|没有)[^，。;；]{0,6}(报错|错误|error)|(有|附|提供|给出)[^，。;；]{0,8}回滚|可回滚|回滚(说明|方式|路径)/i;
function isGenericAcceptance(s) {
    return GENERIC_ACCEPT_RE.test(String(s ?? "").replace(/\s+/g, "").toLowerCase());
}
/** ★ #700057：范围相似度（0..1）——命中前缀关系的一对按「公共路径段数 / 较长一方段数」计分，
 *  回执不再只写「范围重叠」，而能说明重叠到什么程度。 */
function scopeSimilarity(a, b) {
    for (const p of a) {
        for (const q of b) {
            const x = String(p).toLowerCase().replace(/\/+$/, "");
            const y = String(q).toLowerCase().replace(/\/+$/, "");
            if (!(x === y || x.startsWith(y + "/") || y.startsWith(x + "/")))
                continue;
            const xs = x.split("/").filter(Boolean), ys = y.split("/").filter(Boolean);
            let same = 0;
            while (same < xs.length && same < ys.length && xs[same] === ys[same])
                same++;
            return { pair: [p, q], score: round2(same / Math.max(xs.length, ys.length)) };
        }
    }
    return null;
}
/** 查重：返回 [{id, reasons[], substantive}]（substantive=撞范围/撞验收，会影响发布） */
export function findDuplicateTasks(db, { project, title, scope = [], acceptance = [] } = {}) {
    const out = [];
    try {
        const rows = db.prepare(`SELECT id, content FROM ${TASKS}
           WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'`).all(project);
        for (const r of rows) {
            const st = readTaskState(r.content);
            if (!st || !["pending", "in_progress", "blocked", "todo", "ready", "open", "claimed"].includes(st.status))
                continue;
            const reasons = [];
            let substantive = false; // ★ #700057：实质性命中只由「范围/验收」两维决定，不再靠文案前缀猜
            const ts = titleSimilarity(normTitle(title), normTitle(taskBody(r.content)));
            if (ts >= TITLE_SIMILAR_MIN)
                reasons.push(`标题相似度 ${ts.toFixed(2)}`);
            const ov = scope.length && st.scope.length ? scopeSimilarity(st.scope, scope) : null;
            if (ov) {
                reasons.push(`范围重叠 ${ov.score.toFixed(2)}（${ov.pair[0]} ↔ ${ov.pair[1]}）`);
                substantive = true;
            }
            if (acceptance.length) {
                // ★ #700057：通用验收句（测试全绿/控制台 0 报错/有回滚说明）两侧都排除，不参与「同验收」判定
                const cand = acceptance.map((x, i) => [x, i]).filter(([x]) => !isGenericAcceptance(x));
                const hit = cand.find(([x]) => st.acceptance.some((y) => y === x && !isGenericAcceptance(y)));
                if (hit) {
                    reasons.push(`同一验收条件 1.00（第 ${hit[1] + 1} 条：${hit[0].slice(0, 40)}）`);
                    substantive = true;
                }
            }
            if (reasons.length)
                out.push({ id: r.id, reasons, substantive });
        }
    }
    catch { return []; }
    return out;
}
/** 查重命中 → 单行点名（回执与拒绝文案共用同一措辞） */
export function duplicateHitText(hits) {
    return hits.slice(0, 3).map((h) => `#${h.id}，撞在：${h.reasons.join("、")}`).join("；");
}
/** ★ A1 身份与认证层：写工具统一入口。带凭据 → 严格校验（归属 + 未撤销未过期 + scope>=write）；
 *  ★ 2026-11-16（R02-04 / M-2）：默认**硬模式 fail-closed**；只有显式 MEMORYOS_A1_ENFORCE=0 才回到旧软模式。
 *  不带凭据 → 硬模式拒绝；软模式（显式 =0）放行并事件留痕 cred_id=null。 */
export function checkWriteCredential(ctx, who, credential) {
    const db = ctx.db;
    const HARD = a1Hard();
    const cred = credential || ctx.envCredential();
    if (!cred) {
        if (HARD)
            return { ok: false, credId: null, msg: `A1 门禁（默认开启，fail-closed）：${who} 必须携带 scope>=write 的凭据——先 memory_credential(action=issue, scope=write) 签发后随 credential 入参携带，或在 MCP 配置注入 MEMORYOS_A1_CREDENTIAL 环境变量（node dist/a1-bootstrap.js 一键签发）。${A1_HINT}` };
        return { ok: true, credId: null, msg: "" };
    }
    const row = db.prepare(`SELECT id, agent, scope, expires_at, revoked_at FROM agent_credentials WHERE credential=?`).get(String(cred));
    if (!row || row.agent !== who)
        return { ok: false, credId: null, msg: `A1 拒绝：凭据不属于 ${who} 或不存在（不接受他人凭据改写任务归属）。` };
    if (!ctx.isCredentialValid(row))
        return { ok: false, credId: row.id, msg: `A1 拒绝：凭据已${row.revoked_at ? "撤销" : "过期"}（id=${row.id}）；请 memory_credential(action=issue) 重新签发。` };
    if (row.scope === "read")
        return { ok: false, credId: row.id, msg: `A1 拒绝：凭据 scope=read 不足，改写任务需 scope>=write（id=${row.id}）。` };
    return { ok: true, credId: row.id, msg: "" };
}
/** ★ 2026-10-03 批次 A1（Dispatch 语义·**软模式**）：六处写入点的权威提示 —— 只告警不拒绝。
 *  判据与 task_done 硬校验同源：① key 可解析；② memory_id 相符；③ state='active'；④ agent 相符。 */
export function softDispatchNotice(ctx, memoryId, dispatchKey, who) {
    const db = ctx.db;
    const active = readActiveDispatch(db, memoryId);
    if (!dispatchKey) {
        return active
            ? `\ndispatch 提示（软模式）：任务 #${memoryId} 已有 active dispatch（${String(active.dispatch_key).slice(0, 12)}…，持有者 ${active.agent}，gen=${active.generation}），本次未携带 dispatch_key —— 已放行；接管/换代后建议携带以证明权威。`
            : `\ndispatch 提示（软模式）：任务 #${memoryId} 当前无 active dispatch（未经 task_claim 认领），本次未携带 dispatch_key —— 已放行。`;
    }
    const d = readDispatchByKey(db, dispatchKey);
    if (!d)
        return `\ndispatch 提示（软模式）：dispatch_key=${String(dispatchKey).slice(0, 12)}… 不存在，本次已放行。`;
    if (Number(d.memory_id) !== Number(memoryId))
        return `\ndispatch 提示（软模式）：该 dispatch 归属任务 #${d.memory_id} ≠ #${memoryId}（跨任务），本次已放行。`;
    if (d.state !== "active")
        return `\ndispatch 提示（软模式）：该 dispatch 已 ${d.state}（你已被取代或已结算）——权威只来自 active dispatch，本次已放行。`;
    if (d.agent !== who)
        return `\ndispatch 提示（软模式）：该 dispatch 由 ${d.agent} 持有，本次调用方为 ${who}，本次已放行。`;
    return "";
}
/** ★ 2026-10-03 批次 A3（fenced 位）：被取代者从心跳回执**主动**得知（对标 Orca fencing），
 *  避免「旧持有者继续写」的孤儿写入。A3 行优先于 A1 提示（语义重叠只播一次）。 */
export function fencedLine(ctx, memoryId, dispatchKey, who) {
    const db = ctx.db;
    const active = readActiveDispatch(db, memoryId);
    let mine = dispatchKey ? readDispatchByKey(db, dispatchKey) : null;
    if (!mine) {
        try {
            mine = db.prepare(`SELECT * FROM dispatches WHERE memory_id=? AND agent=? ORDER BY generation DESC LIMIT 1`).get(Number(memoryId), String(who)) ?? null;
        }
        catch {
            mine = null;
        }
    }
    if (!mine)
        return "";
    const fenced = String(mine.state) === "superseded" || (active != null && Number(active.id) !== Number(mine.id));
    if (!fenced)
        return `\nfenced=false：你的 dispatch（gen=${mine.generation}）仍为当前权威。`;
    return `\nfenced=true：你持有的 dispatch（gen=${mine.generation}）已被取代 —— 当前权威为 ${active ? `${String(active.dispatch_key).slice(0, 12)}… / gen=${active.generation} / ${active.agent}` : "无（已结算或释放）"}；请停止对该任务的写入，重新 task_next / task_claim 后再继续。`;
}
/** P3 确定性门控预设（融合架构「不信任 Agent 报告，由确定性代码验证」）：argv 全部字面量常量，
 *  固定 node 解释器 + 参数数组、shell:false，请求值仅做枚举匹配，绝不参与命令构造（Mimosa 命令注入防御）。 */
export const GATE_PRESETS = {
    "lint-sql": { label: "lint-sql", argv: ["dist/lint-sql-arity.js"] },
    "lint-catch": { label: "lint-catch", argv: ["dist/lint-silent-catch.js"] },
    "smoke-mcp": { label: "smoke-mcp", argv: ["dist/smoke-mcp.js"] },
    "smoke-task": { label: "smoke-task", argv: ["dist/smoke-task.js"] },
    "smoke-p26": { label: "smoke-p26", argv: ["dist/smoke-p26-lifecycle.js"] },
    "snapshot": { label: "snapshot --check", argv: ["dist/snapshot-routes.js", "--check"] },
};
export function taskGateName(content) {
    // ★ 弊端 H4：gate 标记只认头行——正文里引用的 [gate:预设] 不再触发验收（与 headLineOf 同源）
    const m = headLineOf(content).match(/\[gate:([a-z0-9-]+)\]/);
    return m ? m[1] : null;
}
/** 验收命令的确定性 cwd：resources/memoryos 目录（smoke 类脚本用 process.cwd() 拼相对路径）；
 *  env MEMORYOS_WORKSPACE 仅在显式注入时覆盖。 */
function _gateRoot() {
    const envRoot = (process.env.MEMORYOS_WORKSPACE || "").trim();
    if (envRoot)
        return envRoot;
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
/** ★ 2026-09-25 P0①：async（异步 execFile）——同步等待会把事件循环冻死（验收最长 180s）。
 *  ★ 1b：请求中断（核心侧 req close）→ killTree 杀掉验收子进程，不留孤儿。 */
export async function runTaskGate(ctx, gate, memoryId) {
    const db = ctx.db;
    const preset = GATE_PRESETS[gate];
    if (!preset) {
        const detail = `预设 '${gate}' 未定义（可选：${Object.keys(GATE_PRESETS).join(" / ")}）——fail-closed 不执行`;
        try { logExecAudit(db, { tool: "task_gate", risk: "L0", approval: "gate-reject", agent: ctx.agentName(), memory_id: memoryId, argsDigest: gate, detail, ok: false }); } catch { }
        return { ok: false, executed: false, detail };
    }
    const root = _gateRoot();
    let r;
    const sig = ctx.requestAbortSignal();
    let child = null;
    let aborted = false;
    const onAbort = () => {
        aborted = true;
        if (child)
            ctx.killTree(child);
    };
    if (sig) {
        if (sig.aborted)
            onAbort();
        else
            sig.addEventListener("abort", onAbort, { once: true });
    }
    try {
        r = { status: 0, ...(await new Promise((resolve, reject) => {
            child = execFile("node", preset.argv, { shell: false, cwd: root, encoding: "utf8", timeout: 180000, windowsHide: true }, (err, stdout, stderr) => {
                if (err) {
                    err.stdout = stdout;
                    err.stderr = stderr;
                    reject(err);
                }
                else
                    resolve({ stdout, stderr });
            });
            if (sig && sig.aborted)
                onAbort();
        })) };
    }
    catch (e) {
        r = {
            status: typeof e?.code === "number" ? e.code : null,
            stdout: e?.stdout ?? "",
            stderr: e?.stderr ?? (e?.message ?? String(e)),
        };
    }
    finally {
        if (sig) { try { sig.removeEventListener("abort", onAbort); } catch { /* 忽略 */ } }
    }
    const ok = r.status === 0 && !aborted;
    const detail = aborted
        ? `验收被取消（MCP 请求中断）：已终止验收子进程（${preset.label}）`
        : `${preset.label} exit=${r.status} ${String(r.stdout || r.stderr || "").trim().slice(0, 200)}`;
    try { logExecAudit(db, { tool: "task_gate", risk: "L0", approval: aborted ? "request-aborted" : "gate-auto", agent: ctx.agentName(), memory_id: memoryId, argsDigest: gate, detail, ok }); } catch { }
    return { ok, executed: !aborted, detail };
}
/** P2-6（C-2/#4198）：任务记忆 → 派发卡片（card_memory dispatch 关系）。无卡返回 null。 */
export function cardOfTask(db, memoryId) {
    try {
        const rel = db.prepare(`SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1`).get(memoryId);
        if (!rel)
            return null;
        return db.prepare(`SELECT * FROM cards WHERE id=?`).get(Number(rel.card_id)) ?? null;
    }
    catch {
        return null;
    }
}
/** ★ ③-A（2026-09-24）：任务记忆 → 全部 dispatch 卡（多卡全集合；租约/fencing/门控/清锁链全走它） */
export function cardsOfTask(db, memoryId) {
    try {
        const rels = db.prepare(`SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch'`).all(memoryId);
        const out = [];
        for (const rel of rels) {
            const card = db.prepare(`SELECT * FROM cards WHERE id=?`).get(Number(rel.card_id));
            if (card)
                out.push(card);
        }
        return out;
    }
    catch {
        return [];
    }
}
/** ★ 第二批·第 3 步：任务域统一租约时长（认领 / 心跳续租 / 过期回收判据**同一套**）。
 *  取数顺序：显式入参 → `MEMORYOS_LEASE_MINUTES` → 10；clamp 10..120（沿用卡片租约既有窗口）。
 *  改前后差异：此前 claim 传 args.lease_minutes（缺省 10）、heartbeat 独立 clamp、卡片侧硬编码 +10，
 *  三处口径各自漂移；自此统一经本函数，阈值只需改一处环境变量。 */
export function leaseMinutesOf(explicit) {
    const env = Number(process.env.MEMORYOS_LEASE_MINUTES);
    const raw = explicit != null && Number.isFinite(Number(explicit)) ? Number(explicit)
        : (Number.isFinite(env) && env > 0 ? env : 10);
    return Math.max(10, Math.min(120, Math.floor(Number.isFinite(raw) ? raw : 10)));
}
/** P2-6（C-2）：卡片租约触达（认领时发 lease token；heartbeat 续窗）——默认经 leaseMinutesOf（10..120）。
 *  ★ ③-A：全集合 running 卡逐张触达；⑦：续期即撕贴条；B1：心跳=正面存活证明，一并撤裁决标记。 */
export function touchCardLease(db, memoryId, lock, minutes = null) {
    let n = 0;
    try {
        const min = leaseMinutesOf(minutes);
        for (const c of cardsOfTask(db, memoryId)) {
            if (c.status !== "running")
                continue;
            db.prepare(`UPDATE cards SET claim_lock=?, lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now', ?), heartbeat_at=datetime('now'), lease_notice_at=NULL, lease_stale_at=NULL, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(lock, `+${min} minutes`, c.id);
            db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c.id, "dispatcher", lock ? "lease_set" : "heartbeat", "running", "running", lock ? `MCP 租约锁定（${min}min，lock=${String(lock).slice(0, 8)}…）` : `MCP 心跳续窗（${min}min）`);
            n++;
        }
    }
    catch (e) {
        console.error(`[lease] 卡片租约触达失败（任务 #${memoryId}）：${e instanceof Error ? e.message : String(e)}`);
    }
    return n > 0;
}
/** ★ 2026-09-15 根治「智能体领取/上传与看板不一致」：任务状态变更 → 关联卡片同步。
 *  反向于 cards-domain.js 的 syncCardToTask()。⚠ 投影语义：卡片状态是任务头的投影（C-5 卡向头对齐），
 *  故 UPDATE 不走 cards 的 CARD_TRANSITIONS 白名单，属设计内差异而非绕过。
 *  ★ B1 前置（Step 0）：opts.source 标注写入方（'agent'|'human'|'reconciler'|'dispatcher'），
 *    随事件 detail 落痕——单写入口 applyTransition 的 source 优先级治理由此起步（行为当前不变）。 */
export function syncTaskToCard(db, memoryId, cardStatus, opts = {}) {
    try {
        // ★ 弊端 U2：同步本任务的全部 dispatch 卡（多卡时逐一，原 LIMIT 1 会让多余的卡永久失同步）
        const rels = db.prepare(`SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch'`).all(memoryId);
        if (!rels.length)
            return false;
        let synced = 0;
        for (const rel of rels) {
            const cid = Number(rel.card_id);
            const card = db.prepare(`SELECT status, meta FROM cards WHERE id=?`).get(cid);
            if (!card)
                continue;
            // ★ B1（P2 · 开关 MEMORYOS_REVIEW_GUARD=1，默认关）：agent 的 done 同步不得覆盖 review 卡
            //   （人工验收/待验收）——doneTaskDomain 守卫分支之后的竞态兜底（check→sync 之间人工拖入
            //   review）；非 agent 源（dispatcher/reconcile）不受此限（reconcile 本就不碰 review）。
            if (reviewGuardOn() && cardStatus === "done" && opts.source === "agent" && card.status === "review")
                continue;
            // ★ 方案A守卫：只收敛开放态卡；cardStatus='done' 额外允许 review（验收后收口）；
            //   failed/cancelled/archived 等终态不覆盖（原 WHERE id=? 盲写会把验收/租约流转撕坏）。
            // ★ 跨区补全：源卡 running 是「已认领」而非终态——漏列会把 block/流转的收敛整段跳过。
            const allowed = cardStatus === "done" ? new Set(["triage", "todo", "ready", "blocked", "running", "review"]) : new Set(["triage", "todo", "ready", "running", "blocked"]);
            if (!allowed.has(card.status))
                continue;
            // ★ opts.assignee 三态 —— undefined=保持原值 / null=清空 / 字符串=设为该值
            const setAssignee = opts.assignee === undefined ? "" : ", assignee=?";
            const upd = db.prepare(`UPDATE cards SET status=?${setAssignee}, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`);
            if (opts.assignee === undefined)
                upd.run(cardStatus, cid);
            else
                upd.run(cardStatus, opts.assignee, cid);
            if (cardStatus === "done") {
                db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(cid);
                if (gateBreakerOn()) // ★ B3（P2 · 开关默认关）：成功收口清零门控失败计数（计数的"洗白"点之一；
                    db.prepare(`UPDATE cards SET gate_fail_count=0 WHERE id=?`).run(cid); //   人工介入清零见 cards-domain transitionCard/acceptCard）
            }
            const srcTag = opts.source ? `[source:${opts.source}]` : "";
            db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(cid, opts.actor ?? "dispatcher", opts.action ?? "mcp_sync", card.status, cardStatus, `${srcTag}${opts.detail ?? `任务 #${memoryId} MCP 流转同步`}`);
            synced++;
        }
        settleQueueEdges(db,memoryId,cardStatus);
        return synced > 0;
    }
    catch (e) {
        // 原为静默 catch { return false }——状态同步失败会完全隐身（外观与"卡本来就对"相同）。仅加一行日志。
        console.error(`[syncTaskToCard] 卡侧同步失败（记忆 #${memoryId} → ${cardStatus}）：${e.message}`);
        return false;
    }
}

/* ── 领域执行体（原 server-reg-task.js 各 addTool 的 execute 逐字搬入） ───────────────────
 * 传输层职责收敛为：zod 入参声明 + 幂等包装 + 以下领域函数的薄调用。
 * 返回串 = 领域回执（含 ⟨state⟩ 终态行）——冒烟对文案的逐字节断言即契约，改动即违约。 */

/* ── ★ C1（2026-10-18 · P0）：依赖校验开关 + 依赖满足判据 ─────────────────────────────
 * 病灶（§0.3 实证）：头 [depends:] 只在 task_next 展示层过滤，MCP claim by id / REST claim /
 *   assign 建卡即 ready 三条路径全部绕过；两套依赖（头 vs 卡片 links）互不知晓。
 * 收敛方案（开关 MEMORYOS_DEP_VALIDATE=1，默认关=行为逐字节不变）：
 *   ① assignTaskDomain：depends_on 存在性校验（拒不存在/已终态 id）+ 带头依赖时建卡落 todo
 *      并写卡片依赖边（与 daemon ④ 提升 / dispatch-agent 预检同一套 links 判据）；
 *   ② claimTaskDomain：认领前依赖闸门（takeover 逃生路径豁免）；
 *   ③ cards-domain.js::claimCard：卡级 pendingDepends 闸门（与 dispatch-agent 同口径）。
 * ⚠ nextTasks 为 500 行窗口性能把 allTasks 一次性 hoist 出循环；本函数单次全表扫（认领低频可接受）。
 *   两处判据（done 集合按头文本 / merged 传递解析 / 死端定义）**改动必须同步**。 */
export function depValidateOn() {
    return process.env.MEMORYOS_DEP_VALIDATE === "1";
}
/** ★ 第二批·第 4 步：任务状态的中文名（对外文案专用，避免把 pending/in_progress 这类内部枚举吐给调用方） */
export function taskStatusZh(s) {
    return {
        pending: "待认领",
        in_progress: "进行中",
        blocked: "被阻塞",
        trial: "待确认",
        done: "已完成",
        cancelled: "已取消",
        archived: "已归档",
        merged: "已并入",
        gone: "已删除",
    }[String(s ?? "")] ?? "状态未知";
}
/** ★ B3（2026-10-18 · P2 · 开关 MEMORYOS_GATE_BREAKER=1，默认关）：gate 连续失败熔断。
 *  病灶（问题 #6）：gate 失败卡回 ready（fail-closed 可重试），而熔断判据是
 *  status='failed' AND failure_count>=2——计数涨了条件永远不满足，缺陷任务被反复领取。
 *  本开关打开后：① doneTaskDomain 门控失败路径给任务全部 dispatch 卡 gate_fail_count+1；
 *  ② daemon/web 两侧 housekeep 扩展判据 ready AND gate_fail_count>=2 → blocked；
 *  ③ 清零点=成功收口（syncTaskToCard done / transitionCard done|human / acceptCard）——
 *    **agent 重领不清零**：每次重试都经 claim，若 claim 清零则计数永远到不了 2、
 *    熔断器永不可达（与 #6 目标自相矛盾），故对"claim 时清零"的原始决策作此偏离，
 *    理由与实证见报告 §3-B3 与探针 P14d。
 *  config.json（gateBreaker）→ env 的回填在进程入口三处（dashboard/server/daemon）。 */
export function gateBreakerOn() {
    return process.env.MEMORYOS_GATE_BREAKER === "1";
}
/** ★ P15（2026-10-18 · 开关 MEMORYOS_PRIO_VIA_DISPATCH=1，默认关）：task_next/pick 的卡片 priority
 *  排序对 task_assign 直派任务回退取数。病灶（存量缺口，探针 P12a 首实证）：task_assign 建卡双写
 *  card_memory(dispatch) 但**不写** source_ref——而 priority 查找只认 source_ref 正则 → 直派任务的
 *  卡片 priority 对排序完全失效。**不补写 source_ref**：其语义=「卡派生任务」，兼管 search 排除规则
 *  （search.js:544-546 09-14 决策：卡片派发任务不进检索，而 agent 手动 task_assign **刻意保留**在
 *  检索当经验片）——补写会把 agent 任务挤出检索，违背该决策。故只修查找路径：开关开时经权威任务→卡
 *  链接（card_memory relation='dispatch'，syncTaskToCard/cardsOfTask 同源）回退取数。 */
export function prioViaDispatchOn() {
    return process.env.MEMORYOS_PRIO_VIA_DISPATCH === "1";
}
/** ★ B1（2026-10-18 · P2 · 开关 MEMORYOS_REVIEW_GUARD=1，默认关）：agent 收口不得覆盖 review 卡。
 *  病灶（问题 #3，实证比"互相 409"更尖锐——是**单向覆盖**）：人工把卡拖到/流转到 review（=发起验收，
 *  用户拍板的语义）后，agent 的 task_done 经 syncTaskToCard 的 done 允许集（含 review）把卡强收为
 *  done，而 reconcile 不碰 review → 无任何纠正机制，人的验收被静默作废。
 *  修法（与 B2 同一回执语义，评审③定序"B2 先于 B1"的落实）：命中 review 卡时**不标记头 done**——
 *  头保持 in_progress + 结论留痕 + 回执「已提交，等待验收」，人工 /accept 后经 syncCardToTask 收口；
 *  syncTaskToCard 侧对 source=agent 的 done 同步跳过 review 卡（关 check→sync 间竞态的兜底）。
 *  默认关时原成功路径逐字节不动（缺陷复现见探针 P16c）。 */
export function reviewGuardOn() {
    return process.env.MEMORYOS_REVIEW_GUARD === "1";
}
/** 任务→卡 的权威链接映射（memory_id → card_id，一任务多卡取首行）。仅供 priority 回退取数。 */
function dispatchCardMap(db, memoryIds) {
    const out = new Map();
    const ids = memoryIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (!ids.length)
        return out;
    const ph = ids.map(() => "?").join(",");
    for (const r of db.prepare(`SELECT memory_id, card_id FROM card_memory WHERE relation='dispatch' AND memory_id IN (${ph})`).all(...ids)) {
        const mid = Number(r.memory_id);
        if (!out.has(mid))
            out.set(mid, Number(r.card_id));
    }
    return out;
}
/** ★ P1 开关族（均默认关=行为逐字节不变；调用时解析，与既有 MEMORY_RESTRICTED 同口径） */
export function taskSettleOn() { return process.env.MEMORYOS_TASK_SETTLE === "1"; }
export function atomicClaimOn() { return process.env.MEMORYOS_ATOMIC_CLAIM === "1"; }
export function doneAutoreviewOn() { return process.env.MEMORYOS_DONE_AUTOREVIEW === "1"; }
/** 依赖满足判定：done 集合按**头文本**判定（不看列），merged 沿 superseded_by 传递解析到 winner（带环保护）；
 *  死端（不存在 / 列 archived / 头 cancelled|archived）单独列出（调用方标 †）。
 *  allTasks 可预取（pick=next 批量选取时一次性传入，避免 N×全表扫）——判据与预取与否无关。 */
export function depsStateOf(db, deps, allTasks = null) {
    const all = allTasks ?? db.prepare(`SELECT id, content, status, superseded_by FROM ${TASKS} WHERE type='task' AND sensitivity != 'secret'`).all();
    const mergeTo = new Map();
    for (const t of all) {
        if (t.status === "merged" && t.superseded_by != null)
            mergeTo.set(Number(t.id), Number(t.superseded_by));
    }
    const resolveTaskId = (id, seen = new Set()) => {
        let cur = Number(id);
        while (mergeTo.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            cur = mergeTo.get(cur);
        }
        return cur;
    };
    const doneIds = new Set();
    for (const t of all) {
        const st = readTaskState(t.content);
        if (st?.status === "done" && t.status !== "merged")
            doneIds.add(resolveTaskId(t.id));
    }
    const taskById = new Map(all.map((t) => [Number(t.id), t]));
    const pending = [];
    const dead = [];
    const items = []; // ★ 第 4 步：明细（编号 + 头状态 + 当前持有人），供拒绝文案说清「缺哪件、它现在什么状态」
    for (const d of deps) {
        const rid = resolveTaskId(d);
        if (doneIds.has(rid))
            continue;
        const t = taskById.get(rid);
        if (!t) {
            dead.push(Number(d));
            items.push({ id: Number(d), status: "gone", assignee: null });
            continue;
        }
        const stt = readTaskState(t.content);
        if (String(t.status) === "archived" || stt?.status === "cancelled" || stt?.status === "archived") {
            dead.push(Number(d));
            items.push({ id: Number(d), status: stt?.status ?? String(t.status), assignee: stt?.assignee ?? null });
            continue;
        }
        pending.push(Number(d));
        items.push({ id: Number(d), status: stt?.status ?? "unknown", assignee: stt?.assignee ?? null });
    }
    return { satisfied: pending.length === 0 && dead.length === 0, pending, dead, items };
}
/** depends 字符串 → 正整数 id 数组（与 assign 入参过滤同口径） */
function parseDepIds(deps) {
    return String(deps ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
}

/** task_gate：查看任务 [gate:预设] 验收声明与结果 */
export function gateToolDomain(ctx, args = {}) {
    const db = ctx.db;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常。`;
    const gate = taskGateName(row.content);
    if (!gate)
        return `#${args.memory_id} 未声明验收门（任务头无 [gate:预设]）。task_done 不做确定性验收。白名单预设：${Object.keys(GATE_PRESETS).join(" / ")}`;
    const last = readTaskEventLatest(db, row.id, "task_gate");
    let lastRes = null;
    try { lastRes = last ? JSON.parse(last.payload) : null; } catch { }
    return `#${args.memory_id} 验收门 = [gate:${gate}]（预设：${Object.keys(GATE_PRESETS).join(" / ")}）\n当前状态=${st.status}${lastRes ? `\n最近验收：${lastRes.ok ? "PASS" : "FAIL"}（${String(lastRes.detail ?? "").slice(0, 120)}）` : "\n尚无验收记录（task_done 时自动执行）。"}`;
}

/** task_assign：把任务交给指定 Agent（depends_on 拓扑；同步建卡） */
export function assignTaskDomain(ctx, args = {}) {
    args = { ...args, assignee: isPublicTaskAssignee(args.assignee) ? "?" : args.assignee };
    const db = ctx.db;
    const agentName = ctx.agentName;
    const agentFpath = ctx.agentFpath;
    const asgErr = assertAssignee(args.assignee);
    if (asgErr)
        return asgErr;
    // ★ 第二批·第 3 步：占用范围（可选）——未声明 = 空集 = 与任何任务都不冲突
    const scopeNorm = normalizeScope(args.scope);
    if (!scopeNorm.ok)
        return scopeNorm.msg;
    const scope = scopeNorm.scope;
    // ★ 第 5 步：验收标准（可选）——逐条可核对短句，最多 8 条、每条 ≤80 字
    const accNorm = normalizeAcceptance(args.acceptance);
    if (!accNorm.ok)
        return accNorm.msg;
    const acceptance = accNorm.items;
    const isPublicAssign = args.assignee === "?";
    const body = args.content.trim();
    // ★ 第 4 步：依赖编号支持 T-12 / M-12 / #12（与 MCP 层 normRefList 同口径）——
    //   原 `/^\d+$/` 会把带前缀的引用**静默丢弃**，等于依赖不生效（直调 domain 时实证）。
    const deps = (args.depends_on ?? "")
        .split(",")
        .map((s) => parseRecordRef(s))
        .filter((n) => Number.isFinite(n) && n > 0)
        .join(",");
    // ★ C1（开关 MEMORYOS_DEP_VALIDATE=1，默认关）：depends_on 存在性校验——
    //   拒不存在/已终态 id（幽灵依赖/死端入库曾无任何校验，实证 P3d）。pending 依赖合法（等着即可）。
    if (depValidateOn() && deps) {
        const ds = depsStateOf(db, parseDepIds(deps));
        if (ds.dead.length) {
            const fmtDead = (d) => `#${d}（${taskStatusZh(ds.items.find((it) => it.id === d)?.status)}）`;
            return `depends_on 校验拒绝：${ds.dead.map(fmtDead).join("、")} 已取消/已归档/不存在，永远等不到完成——请改成有效任务编号后重试。`;
        }
    }
    // ★ 第 5 步：发布前查重——实质性命中（撞范围/撞验收）拒绝并点名，force=true 才强制发布；
    //   仅标题相似（范围与验收都不同）只提示不阻挡。
    const dupHits = findDuplicateTasks(db, { project: args.project, title: body, scope, acceptance });
    const dupSub = dupHits.filter((h) => h.substantive);
    const dupHint = dupHits.filter((h) => !h.substantive);
    const isForce = args.force === true;
    if (dupSub.length && !isForce)
        return `possible duplicate：${duplicateHitText(dupSub)}。若确认要另建一条，传 force=true 强制发布；或改用已有任务编号（task_claim）。`;
    const full = taskBodyWithDep("pending", args.assignee, deps ? parseDepIds(deps) : [], body, scope, { acceptance, progress: args.progress });
    // ★ 一致性①：记忆 + 事件 + 建卡 + 用量记账包成一笔事务——中途失败整体回滚，不出半笔账
    //   （建卡仍 best-effort：失败留文案，对账补卡兜底）。
    let row = null;
    let cardInfo = "";
    const asgAbort = runTaskTx(db, () => {
        row = createTaskRow(db, {
            content: full,
            type: "task",
            agent: agentName(),
            agent_fpath: agentFpath(),
            project: args.project,
        });
        appendEvent(db, {
            memory_id: row.id,
            op: "task_assign",
            payload: JSON.stringify({ from: agentName(), to: args.assignee, project: args.project, depends: deps || null, scope: scope.length ? scope : null, acceptance: acceptance.length ? acceptance : null, progress: args.progress ? sanitizeHeadText(args.progress, PROGRESS_MAX) : null, duplicate_override: dupSub.length && isForce ? dupSub.map((h) => h.id) : undefined, duplicate_hint: dupHint.length ? dupHint.map((h) => h.id) : undefined }),
            operator: `agent:${agentName()}`,
        });
        // ★ 2026-09-15：task_assign 同步建卡（默认开），避免任务地图无卡可领；
        //   复用 from-memory 的 ref 关联：ref_kind='memory', ref_id=task 记忆 id → 卡片状态流转可经此回写 memories。
        if (args.create_card !== false) {
            try {
                const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(row.id);
                const title = body.split("\n")[0].replace(/\[[^\]]*\]/g, "").trim().slice(0, 120) || `任务 #${row.id}`;
                // ★ C1（开关默认关）：带头依赖时建卡落 todo + 写卡片依赖边——与 daemon ④（todo→ready 依赖提升）/
                //   dispatch-agent（pendingDepends 预检）同一套 links 判据，两套依赖系统自此收敛（§0.3）。
                const depOn = depValidateOn() && !!deps;
                const cardStatus = depOn ? "todo" : "ready";
                const cardBody = `${body}${acceptance.length ? "\n\n" + acceptanceLineOf(acceptance) : ""}${args.progress ? "\n" + progressLineOf(args.progress) : ""}`;
                const cardId = dup
                    ? dup.id
                    : Number(db
                        .prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,priority,assignee) VALUES ('default','task',?,?,?,'memory',?,?,?)`)
                        .run(title, cardBody.slice(0, 2000), cardStatus, row.id, 3, isPublicAssign ? null : args.assignee).lastInsertRowid);
                db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'dispatch')`).run(cardId, row.id);
                // ★ 2026-11-14（个人版）：建卡后把关联写回任务记录。
                //   排序/卡片优先级默认只认 source_ref='card:N'（P15 的 dispatch 回退开关默认关），
                //   不回写会导致「有卡但按优先级排序失效」。只填空值，不覆盖任务已有的来源标记。
                db.prepare(`UPDATE ${TASKS} SET source_ref=? WHERE id=? AND (source_ref IS NULL OR source_ref='')`).run(`card:${cardId}`, row.id);
                if (depOn && !dup) {
                    // 依赖边 dst 须为**卡 id**：经 dep 任务的 dispatch 卡反查；无卡的依赖只靠 MCP 头侧闸门（已知边界）
                    for (const d of parseDepIds(deps)) {
                        const depCard = db.prepare(`SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1`).get(d);
                        if (depCard)
                            db.prepare(`INSERT OR IGNORE INTO links(vault_root,src_kind,src_id,dst_kind,dst_id,kind) VALUES (NULL,'card',?,'card',?,'depends')`).run(cardId, Number(depCard.card_id));
                    }
                }
                cardInfo = ` + 地图卡 #${cardId}`;
            }
            catch (e) {
                console.error(`[task_assign] 建卡失败（任务 #${row.id}）: ${e instanceof Error ? e.message : String(e)}`);
                cardInfo = `（建卡失败：${e instanceof Error ? e.message : String(e)}）`;
            }
        }
        logUsage(db, {
            memory_id: row.id, event: "write", reader_agent: agentName(), writer_agent: agentName(),
            project: row.project, session_id: args.session_id, task_hint: args.task_hint, is_task: true,
        });
    });
    if (asgAbort)
        return asgAbort;
    const dupNote = dupSub.length && isForce
        ? `（已强制发布；可能重复：${duplicateHitText(dupSub)}）`
        : dupHint.length ? `（提示：与 ${duplicateHitText(dupHint)}，范围与验收都不同，不阻挡）` : "";
    return `已分派任务 #${row.id}（T-${row.id}）→ ${isPublicAssign ? "待认领（谁领谁记名）" : args.assignee}（status=pending）${cardInfo}${scope.length ? ` + 占用范围 ${scope.join(",")}` : ""}${acceptance.length ? ` + 验收 ${acceptance.length} 条` : ""}${dupNote}[${row.type}|${row.agent}] ${row.content.replace(/\s+/g, " ").slice(0, 120)}`;
}

/** task_delegate：A2A 对等委派（复用 task_assign 的任务头/建卡/审计；目标无有效凭据 fail-closed 拒绝） */
export function delegateTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const agentFpath = ctx.agentFpath;
    const nowIso = ctx.nowIso;
    const caller = (args.from || agentName()).trim();
    // A1 认证层联动：目标 agent 必须持有有效（未撤销且未过期）凭据，否则 fail-closed 拒绝
    if (args.require_credential !== false) {
        const rows = db.prepare(`SELECT id FROM agent_credentials WHERE agent=? AND revoked_at IS NULL AND expires_at > ?`).all(args.to, nowIso());
        if (!rows.length)
            return `A2A 委派拒绝（fail-closed）：目标 agent=${args.to} 无有效凭据。请先 memory_credential(action=issue, agent=${args.to}) 签发短生命周期凭据，再委派。`;
    }
    const gate = args.gate && GATE_PRESETS[args.gate] ? args.gate : null;
    // ★ 第 5 步：委派同属「发布」——验收标准与交接进度同口径（与 task_assign 共用 helper / 措辞）
    const accNorm = normalizeAcceptance(args.acceptance);
    if (!accNorm.ok)
        return accNorm.msg;
    const acceptance = accNorm.items;
    const dupHits = findDuplicateTasks(db, { project: args.project, title: args.content.trim(), acceptance });
    const dupSub = dupHits.filter((h) => h.substantive);
    const dupHint = dupHits.filter((h) => !h.substantive);
    const isForce = args.force === true;
    if (dupSub.length && !isForce)
        return `possible duplicate：${duplicateHitText(dupSub)}。若确认要另建一条，传 force=true 强制发布；或改用已有任务编号（task_claim）。`;
    const body = `[a2a:${caller}→${args.to}]${gate ? ` [gate:${gate}]` : ""} ${args.content.trim()}`;
    const full = taskBodyWithDep("pending", args.to, [], body, [], { acceptance, progress: args.progress });
    let row = null;
    let cardInfo = "";
    const dlgAbort = runTaskTx(db, () => {
        row = createTaskRow(db, {
            content: full,
            type: "task",
            agent: caller,
            agent_fpath: agentFpath(),
            project: args.project,
        });
        appendEvent(db, {
            memory_id: row.id,
            op: "task_delegate",
            payload: JSON.stringify({ from: caller, to: args.to, gate, protocol: "a2a", project: args.project, acceptance: acceptance.length ? acceptance : null, progress: args.progress ? sanitizeHeadText(args.progress, PROGRESS_MAX) : null, duplicate_override: dupSub.length && isForce ? dupSub.map((h) => h.id) : undefined, duplicate_hint: dupHint.length ? dupHint.map((h) => h.id) : undefined }),
            operator: `agent:${caller}`,
        });
        try {
            const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(row.id);
            const title = `A2A ${caller}→${args.to}: ${args.content.split("\n")[0].replace(/\[[^\]]*\]/g, "").trim().slice(0, 90)}`;
            const cardBody = `${args.content.trim()}${acceptance.length ? "\n\n" + acceptanceLineOf(acceptance) : ""}${args.progress ? "\n" + progressLineOf(args.progress) : ""}`;
            const cardId = dup
                ? dup.id
                : Number(db
                    .prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,priority,assignee) VALUES ('default','task',?,?,?,'memory',?,?,?)`)
                    .run(title, cardBody.slice(0, 2000), "ready", row.id, 3, args.to).lastInsertRowid);
            db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'dispatch')`).run(cardId, row.id);
            cardInfo = ` + 地图卡 #${cardId}`;
        }
        catch (e) {
            console.error(`[task_delegate] 建卡失败（任务 #${row.id}）: ${e instanceof Error ? e.message : String(e)}`);
            cardInfo = `（建卡失败：${e instanceof Error ? e.message : String(e)}）`;
        }
        logUsage(db, {
            memory_id: row.id, event: "write", reader_agent: caller, writer_agent: caller,
            project: row.project, session_id: args.session_id, task_hint: args.task_hint, is_task: true,
        });
    });
    if (dlgAbort)
        return dlgAbort;
    const dupNote = dupSub.length && isForce
        ? `（已强制发布；可能重复：${duplicateHitText(dupSub)}）`
        : dupHint.length ? `（提示：与 ${duplicateHitText(dupHint)}，范围与验收都不同，不阻挡）` : "";
    return `A2A 已委派任务 #${row.id}：${caller} → ${args.to}${gate ? `（验收门 [gate:${gate}]，task_done 时确定性验收）` : ""}（status=pending）${cardInfo}${acceptance.length ? ` + 验收 ${acceptance.length} 条` : ""}${dupNote}`;
}

/** task_claim：领取 pending 任务（租约 10 分钟可延长；as=any 托管；takeover 接管须凭据） */
export function claimTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    if (args.memory_id) {
        const row = readMemory(db, args.memory_id);
        if (!row || row.type !== "task")
            return `#${args.memory_id} 不存在或非任务。`;
        const aliveErr = assertTaskAlive(row);
        if (aliveErr)
            return aliveErr;
        const st = readTaskState(row.content);
        if (!st)
            return `#${args.memory_id} 任务头格式异常，无法认领。`;
        // ★ 批次 B1（G2 裁决心跳）：接管路径——仅当调用方显式 takeover:true 且该任务当前**无 active dispatch**
        //   （被 reaper 标 stale，或已 release）时放行。依据 orca「absence never authorizes destruction」：
        //   缺席只标 stale，接力必须由新调度的**正向动作**完成；本分支即该正向入口。
        const takeover = args.takeover === true && st.status === "in_progress";
        // ★ 第二批·第 3 步（租约过期真退回）：in_progress 且**租约已过期** → 允许他人在认领时惰性回收换手；
        //   仍有效 / 无任何租约记录（历史任务）→ 维持原口径（拒领，后者仍需显式 takeover，防批量误回收）。
        const expired = st.status === "in_progress" ? expiredLeaseOf(db, row.id) : null;
        if (expired)
            // ★ 第 5 步：前手 [progress:] 摘要优先（与提交/释放同一套格式），没有才回退检查点/卡事件证据
            expired.progress = st.progress || leaseProgressOf(db, row.id);
        // ★ 2026-11-07（#700053）：显式传了 takeover 但任务不是 in_progress 时，说清参数边界并给下一步，
        //   不再回一句「仅 pending 可认领」让调用方以为参数没生效。
        if (args.takeover === true && st.status !== "in_progress") {
            const next = st.status === "pending"
                ? "该任务本来就是 pending，直接普通认领即可（不要传 takeover）。"
                : st.status === "blocked"
                    ? "阻塞任务先处理依赖或解除阻塞；持有者若已无法继续，让其 task_release 归还后再认领。"
                    : `该任务已是 ${st.status}，重开请用 task_admin(action=reopen)。`;
            return `#${args.memory_id} 当前 status=${st.status}：takeover 仅适用 in_progress 任务（接管失联持有者的待裁决工作证）。\n下一步：${next}`;
        }
        if (st.status !== "pending" && !takeover) {
            if (st.status !== "in_progress")
                return `#${args.memory_id} 当前 status=${st.status}，仅 pending 可认领；若任务已终态/归档，用 task_admin(action=reopen) 重开。`;
            if (!expired)
                return `#${args.memory_id} 当前 status=in_progress（${st.assignee} 持有有效租约或无租约记录），仅 pending 可认领。若原认领者已失联（其工作证已 stale），可传 takeover=true 显式接管。`;
        }
        if (takeover) {
            const act = readActiveDispatch(db, row.id);
            if (act)
                return `#${args.memory_id} 仍有 active dispatch（${String(act.dispatch_key).slice(0, 12)}… / ${act.agent} / gen=${act.generation}）——不得接管：原持有者权威仍有效。请等待其结算，或由本人 task_release 显式归还。`;
            const staleDsp = db.prepare(`SELECT id FROM dispatches WHERE memory_id=? AND state='stale'`).get(row.id);
            if (!staleDsp)
                return `#${args.memory_id} 无 stale dispatch 记录 —— 该任务不处于「待裁决」态，takeover 不适用（未认领走普通认领；已终态走 task_admin(action=reopen)）。`;
        }
        // ★ P2-6（C-2）fencing：乐观版本 + 租约锁——拒绝陈旧领取 / 僵尸领取
        // ★ ③-A：锁检查改全集合（存在锁且任一张锁不符才拒）
        const claimLocks = cardsOfTask(db, row.id).filter((cc) => cc.claim_lock);
        const claimMismatch = claimLocks.find((cc) => cc.claim_lock !== args.lease_token);
        if (args.lease_token && claimLocks.length && claimMismatch)
            return `#${args.memory_id} 租约已被他人接管（卡片 #${claimMismatch.id} 现锁 ${String(claimMismatch.claim_lock).slice(0, 8)}…），本次领取拒绝（fencing）；请重新 task_next 后再领。`;
        if (args.expected_version != null && args.expected_version !== row.version)
            return `#${args.memory_id} 版本漂移（期望 v${args.expected_version}，当前 v${row.version}）：任务已被其他操作改写，本次领取拒绝；请刷新后再领。`;
        const who = args.as && args.as !== "any" && args.as !== agentName() ? args.as : agentName();
        const asgErr = assertAssignee(who);
        if (asgErr)
            return asgErr;
        const cred = checkWriteCredential(ctx, who, args.credential);
        if (!cred.ok)
            return cred.msg;
        // ★ 弊端 H2：as="any" 托管认领会改写归属——默认软模式无凭据放行是治理漏洞；
        //   as="any" 必须携带 scope>=write 凭据（硬模式口径天然满足；本人认领保持软模式兼容）。
        if (args.as === "any" && !args.credential)
            return `as="any" 托管认领会改写任务归属：请先 memory_credential(action=issue, scope=write) 签发凭据并随 credential 入参携带；若以本人身份认领则不传 as。`;
        if (takeover && !args.credential)
            return `takeover 接管会改写任务归属：请先 memory_credential(action=issue, scope=write) 签发凭据并随 credential 入参携带。`;
        // ★ 第二批·第 3 步：过期租约回收时豁免归属校验——前手头里写着旧 assignee，但租约已到期、人已失联，
        //   此时「他人可重新领取」正是本批目标；未过期仍按原口径拒绝（软治理边界不变）。
        if (!expired && args.as !== "any" && !takeover && !isPublicTaskAssignee(st.assignee) && st.assignee !== who) {
            return `#${args.memory_id} 指派给 ${st.assignee}，你不是接收方（可传 as=any 强制托管认领）。`;
        }
        // ★ C1（开关默认关）：认领前依赖闸门——头 [depends:] 未满足即拒（与 task_next 可做集同判据）。
        //   takeover 逃生路径豁免：恢复卡死的任务不应被依赖二次卡住。
        if (depValidateOn() && !takeover && st.deps.length) {
            const ds = depsStateOf(db, st.deps);
            if (!ds.satisfied) {
                // ★ 第 4 步：给人看的文案——逐条说清「哪件前置、它现在什么状态、谁在做」，不吐内部枚举名
                const wait = ds.items.filter((it) => !ds.dead.includes(it.id));
                const gone = ds.items.filter((it) => ds.dead.includes(it.id));
                const fmtWait = (it) => `#${it.id}（${taskStatusZh(it.status)}${it.assignee && it.assignee !== "?" ? `，${it.assignee} 手上` : ""}）`;
                const fmtDead = (it) => `#${it.id}（${taskStatusZh(it.status)}）`;
                const parts = [];
                if (wait.length)
                    parts.push(`还在等 ${wait.map(fmtWait).join("、")} 完成`);
                if (gone.length)
                    parts.push(`${gone.map(fmtDead).join("、")} 永远不会完成了（已取消/已归档/已删除），这条依赖需要重挂或人工裁决`);
                return `#${args.memory_id} 还不能领：${parts.join("；")}。等前置完成后重新 task_claim 即可（task_next 可看当前可做集）。`;
            }
        }
        // ★ 第二批·第 3 步：占用范围冲突 → 排队（保持 pending），不是硬拒绝；未声明 scope 不参与比对
        const scopeClash = scopeConflictOf(db, row.id, st.scope ?? []);
        if (scopeClash)
            return `#${args.memory_id} 冲突中，排队：${scopeClash}。本任务保持 pending（未声明占用范围的任务永不冲突）；待对方 task_done / task_release 后重新 task_claim 即可。`;
        const queueError = queueClaimError(db,row.id,agentName(),args.as);
        if (queueError) return queueError;
        const minLease = leaseMinutesOf(args.lease_minutes);
        const newContent = taskBodyWithDep("in_progress", who, st.deps, taskBody(row.content), st.scope ?? [], {
            // 租约回收换手：保留前手进度摘要供接手方直接看到；普通认领可用 args.progress 覆盖/续写
            acceptance: st.acceptance, progress: expired ? (st.progress || (String(expired.progress ?? "").startsWith("无检查点") ? null : expired.progress)) : (args.progress ?? st.progress),
        });
        // ★ 并发竞态修复：CAS 认领——content 写 + version 递增原子化（WHERE version=?），
        //   两会话并发认领同一任务必有一个拿 null 拒绝，不再后写覆盖前写的 assignee/租约。
        // ★ 一致性①：CAS + 事件 + 卡投影 + 租约四笔写入包成一笔事务——中途失败整体回滚；
        //   锁竞争由 withTx 整段重试，事务回滚后 version 未变，「请刷新后重试」提示从此真实有效。
        let lock = null;
        let dsp = null;
        const claimAbort = runTaskTx(db, () => {
            const queueError=queueClaimError(db,row.id,agentName(),args.as);
            if(queueError)throw new TxAbort(queueError);
            const claimed = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version });
            if (!claimed)
                throw new TxAbort(`#${row.id} 并发认领冲突（版本已漂移 v${row.version}）：任务刚被其他会话领取或改写；请 task_next 刷新后重试。`);
            // ★ 第二批·第 3 步：过期租约回收（**排在 CAS 成功之后**——输家不产生任何回收副作用）
            if (expired) {
                db.prepare(`UPDATE dispatches SET evidence=? WHERE memory_id=? AND state IN ('active','stale')`)
                    .run(`lease_expired@${expired.expiredAt}; prev=${expired.prevAssignee}; late=${expired.lateMinutes}min`, row.id);
                for (const cc of cardsOfTask(db, row.id)) {
                    if (cc.status !== "running")
                        continue;
                    db.prepare(`UPDATE cards SET status='ready', assignee=NULL, claim_lock=NULL, lease_expires_at=NULL,
                        heartbeat_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL, version=version+1, updated_at=datetime('now') WHERE id=?`).run(cc.id);
                    db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`)
                        .run(cc.id, `agent:${agentName()}`, "lease_reclaim", "running", "ready",
                        `租约到期回收：前手 ${expired.prevAssignee}，到期 ${expired.expiredAt}（超时 ${expired.lateMinutes} 分钟）→ 由 ${who} 接手`);
                }
                appendEvent(db, {
                    memory_id: row.id, op: "task_lease_reclaim",
                    payload: JSON.stringify({
                        prev_assignee: expired.prevAssignee, expired_at: expired.expiredAt, late_minutes: expired.lateMinutes,
                        prev_heartbeat_at: expired.prevHeartbeat, dispatch_generation: expired.generation,
                        reclaimed_by: who, progress: expired.progress, reason: "lease_expired",
                    }),
                    operator: `agent:${agentName()}`,
                });
            }
            // ★ 2026-10-02：同一枚 token 同时是 dispatch_key——从「查不出持有者的锁」变为可查询/可换代/可取代的尝试句柄。
            //   形态保持纯 hex：既有冒烟断言 / 卡片 CAS 锁 / agent 侧解析均按 [0-9a-f]+ 提取，加前缀会被截断。
            lock = randomBytes(12).toString("hex");
            dsp = createDispatch(db, { key: lock, memoryId: row.id, agent: who, sessionId: args.session_id ?? null, credentialId: cred.credId, leaseMinutes: minLease });
            appendEvent(db, { memory_id: row.id, op: takeover ? "task_takeover" : "task_claim", payload: JSON.stringify({ by: who, as_any: args.as === "any" || undefined, takeover: takeover || undefined, prev_assignee: takeover ? (st.assignee ?? null) : undefined, lease_token: lock, dispatch_id: dsp?.id, generation: dsp?.generation, superseded: dsp?.superseded ?? undefined, version: row.version + 1, session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${agentName()}` });
            syncTaskToCard(db, row.id, "running", { assignee: who, actor: `agent:${who}`, action: takeover ? "takeover" : (expired ? "reclaim" : "claim"), source: "agent", detail: takeover ? `MCP 接管（agent ${who} ← ${st.assignee ?? "?"}，待裁决换代）` : (expired ? `MCP 接手（agent ${who} ← ${expired.prevAssignee} 租约过期回收）` : `MCP 认领（agent ${who}）`) });
            touchCardLease(db, row.id, lock, minLease);
            linkQueueClaim(db,row.id,dsp.id);
        });
        if (claimAbort)
            return claimAbort;
        const handoff = expired
            ? `接手：前手 ${expired.prevAssignee} 租约到期于 ${expired.expiredAt}（超时 ${expired.lateMinutes} 分钟未续），原因=lease_expired；${progressLineOf(expired.progress) || "进度摘要：无（前手未留）"}。已回收为 pending 并换手。\n`
            : st.progress ? `${progressLineOf(st.progress)}\n` : "";
        const accLine = acceptanceLineOf(st.acceptance);
        return `${handoff}已${takeover ? "接管（换代）" : "认领"}任务 #${row.id}（status=in_progress by ${who}）lease_token=${lock}（即 dispatch_key，task_done 时携带）${accLine ? `\n${accLine}` : ""}：${newContent.replace(/\s+/g, " ").slice(0, 120)}` + stateReceipt({ op: takeover ? "task_takeover" : "task_claim", id: row.id, status: "in_progress", version: row.version + 1, assignee: who, lease_token: lock, dispatch_key: lock, dispatch_id: dsp?.id, generation: dsp?.generation, superseded: dsp?.superseded ?? undefined, cred_id: cred.credId, session_id: args.session_id ?? null });
    }
    // ★ A3（P1 · 原子认领）：pick="next" —— 选取 + 认领一次调用完成，消除 task_next→task_claim 两步窗口
    //   （窗口内 LLM 延迟可达数秒，多 agent 下输家白跑）。选取判据与 task_next 可做集**同源**
    //   （pending + 归属匹配 + 依赖满足；卡片 priority DESC、创建时间 ASC）；选定后**复用本函数
    //   memory_id 分支的完整校验链**（状态/归属/凭据/依赖闸门/CAS）——零重复零漂移，CAS 保证不双认领。
    //   开关 MEMORYOS_ATOMIC_CLAIM=1（默认关：传 pick 也走原列表路径并提示，行为不变）。
    if (!args.memory_id && args.pick === "next") {
        if (!atomicClaimOn())
            return `pick="next" 需要 MEMORYOS_ATOMIC_CLAIM=1（当前未开）——不传 pick 时行为不变。`;
        const who = args.as && args.as !== "any" && args.as !== agentName() ? args.as : agentName();
        const allTasks = db.prepare(`SELECT id, content, status, superseded_by FROM ${TASKS} WHERE type='task' AND sensitivity != 'secret'`).all();
        const rows = db.prepare(`SELECT id, content, agent, source_ref, created_at FROM ${TASKS}
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'
       AND ${queueVisibleSqlFor(TASKS)} ORDER BY julianday(created_at) DESC, id DESC LIMIT 500`).all(args.project,agentName());
        // 卡片 priority 一次性批量取（同 nextTasks 口径；★ P15 开关开时对直派任务回退 dispatch 链接）
        const dspMap = prioViaDispatchOn() ? dispatchCardMap(db, rows.map((r) => r.id)) : new Map();
        const cardOfRow = (r) => {
            const m = String(r.source_ref ?? "").match(/^card:(\d+)$/);
            return m ? Number(m[1]) : (dspMap.get(Number(r.id)) ?? null);
        };
        const cardIds = [...new Set(rows.map(cardOfRow).filter((n) => n !== null))];
        const cardPrio = new Map();
        if (cardIds.length) {
            const ph = cardIds.map(() => "?").join(",");
            db.prepare(`SELECT id, priority FROM cards WHERE id IN (${ph})`).all(...cardIds).forEach((r) => cardPrio.set(r.id, Number(r.priority ?? 0)));
        }
        const cands = [];
        for (const r of rows) {
            const s = readTaskState(r.content);
            if (queueClaimError(db,r.id,agentName(),args.as))continue;
            if (!s || s.status !== "pending")
                continue;
            if (!(args.as === "any" || isPublicTaskAssignee(s.assignee) || s.assignee === who))
                continue;
            if (!depsStateOf(db, s.deps, allTasks).satisfied)
                continue;
            // ★ 第二批·第 3 步：占用范围撞车的候选直接跳过（否则会「选中 → 排队文案」空占一个候选位）
            if (scopeConflictOf(db, r.id, s.scope ?? []))
                continue;
            const cid = cardOfRow(r); // ★ P15：source_ref 优先，开关开时回退 dispatch 链接
            cands.push({ id: r.id, prio: cid !== null ? (cardPrio.get(cid) ?? 0) : 0, ts: Date.parse(r.created_at) || 0 });
        }
        if (!cands.length)
            return `当前无可认领的 pending 任务（pick=next 选取范围：project='${args.project}' + global，判据同 task_next 可做集）。`;
        cands.sort((a, b) => b.prio - a.prio || a.ts - b.ts);
        // 依次尝试前 3 候选（选取与认领间仍有毫秒级竞态；CAS 失败即换下一个，全部落空则回最后一条文案）
        let last = "";
        for (const c of cands.slice(0, 3)) {
            last = claimTaskDomain(ctx, { ...args, pick: undefined, memory_id: c.id });
            if (last.includes("已认领任务") || last.includes("已接管"))
                return last;
        }
        return last;
    }
    // 列可领任务：type='task' 且状态头 pending（★ H4：secret 任务不进工具通道）
    const rows = db.prepare(`SELECT id, content, agent, created_at FROM ${TASKS}
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'
       AND ${queueVisibleSqlFor(TASKS)} ORDER BY created_at DESC LIMIT ?`).all(args.project,agentName(), 50);
    const who = args.as && args.as !== "any" ? args.as : agentName();
    const open = rows.filter((r) => {
        const s = readTaskState(r.content);
        return s?.status === "pending" && (args.as === "any" || isPublicTaskAssignee(s.assignee) || s.assignee === who)
            && !queueClaimError(db,r.id,agentName(),args.as);
    });
    if (!open.length) {
        // ★ 2026-09-15：跨 project 回退提示（与 task_next 同口径）
        let hint = "";
        if (args.project !== "global") {
            try {
                const other = db.prepare(`SELECT project, COUNT(*) c FROM ${TASKS} WHERE type='task' AND status IN ('active','trial') AND project != 'global' AND project != ? AND sensitivity != 'secret' GROUP BY project`).all(args.project);
                if (other.length)
                    hint = `；其他 project 有开放任务 ${other.map((o) => `${o.project}(${o.c})`).join("、")}，可切换 project 查询`;
            } catch { /* 统计失败忽略 */ }
        }
        return `当前无可领的 pending 任务${hint}。`;
    }
    return open.map((r) => `#${r.id} [${readTaskState(r.content)?.assignee}] ${r.content.slice(30, 160)}`).join("\n");
}

/** ★ A1（P1 · task_settle）：凭 ticket 的结算/归还——治 #2「干完活交不了差」。
 *  上下文压缩丢 dispatch_key/lease_token/expected_version 后，agent 无法证明自己的认领；
 *  本工具让服务端反查票据完成收尾，**不需要 agent 记住任何令牌**。
 *  归属纪律（评审②）：只接受 dispatch_key，或 memory_id + session_id（必须命中该任务**当前 active 代**
 *  且 session 相符）——裸 memory_id 谁都能传=围栏失效，拒；已 superseded/settled 的代=僵尸会话，拒。
 *  效果：dispatch 结算/释放 + 任务头回 pending（CAS）+ 全集合卡回 ready 清锁 + 可选交接注记（结论留痕，
 *  活已干成但无法走 task_done 时把成果交给下一位，防「重试放弃或乱试」）。
 *  开关 MEMORYOS_TASK_SETTLE=1（默认关：工具不注册，工具面逐字节不变）。 */
export function settleTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    let dsp = null;
    if (args.dispatch_key) {
        dsp = readDispatchByKey(db, args.dispatch_key);
        if (!dsp)
            return `dispatch_key=${String(args.dispatch_key).slice(0, 12)}… 不存在——请确认票据来源（task_claim 回执的 lease_token/dispatch_key）。`;
        if (dsp.state !== "active")
            return `该 dispatch 已 ${dsp.state}（gen=${dsp.generation}）——权威只来自 active dispatch；已被取代/结算的票据不可再结算（防僵尸会话写）。`;
        if (args.session_id && dsp.session_id && dsp.session_id !== args.session_id)
            return `该 dispatch 属于会话 ${dsp.session_id}，与本次 session_id 不符——拒绝跨会话结算（同名 agent 多会话防串号）。`;
        if (dsp.agent !== agentName())
            return `该 dispatch 由 ${dsp.agent} 持有，你（${agentName()}）不是持有者——拒绝结算。`;
    }
    else {
        if (!args.memory_id || !args.session_id)
            return `task_settle 需要 dispatch_key，或 memory_id + session_id（二者齐备才能定位 active 代）——裸 memory_id 不接受（谁都能传 = 围栏失效）。`;
        const row0 = readMemory(db, args.memory_id);
        if (!row0 || row0.type !== "task")
            return `#${args.memory_id} 不存在或非任务。`;
        dsp = readActiveDispatch(db, args.memory_id);
        if (!dsp)
            return `任务 #${args.memory_id} 当前无 active dispatch——无需结算（未经认领、已释放或已结算）。`;
        if (dsp.session_id !== args.session_id)
            return `任务 #${args.memory_id} 的 active dispatch 属于会话 ${dsp.session_id ?? "?"}（${dsp.agent}），与本次 session_id 不符——拒绝跨会话结算（防同名 agent 多会话串号）。`;
        if (dsp.agent !== agentName())
            return `该 dispatch 由 ${dsp.agent} 持有，你（${agentName()}）不是持有者——拒绝结算。`;
    }
    const memoryId = Number(dsp.memory_id);
    const row = readMemory(db, memoryId);
    if (!row || row.type !== "task")
        return `#${memoryId} 不存在或非任务。`;
    const st = readTaskState(row.content);
    if (!st)
        return `#${memoryId} 任务头格式异常，无法结算。`;
    const conclusion = String(args.conclusion ?? "").trim();
    const failed = args.outcome === "failed";
    const settleAbort = runTaskTx(db, () => {
        const body = conclusion
            ? `${taskBody(row.content)}\n→ 交接(${agentName()})：${sanitizeTaskText(conclusion)}`
            : taskBody(row.content);
        const released = updateMemory(db, memoryId, { content: taskBodyWithDep("pending", st.assignee, st.deps, body, st.scope ?? [], { acceptance: st.acceptance, progress: sanitizeHeadText(conclusion, PROGRESS_MAX) || st.progress }), expectedVersion: row.version });
        if (!released)
            throw new TxAbort(`#${memoryId} 并发写冲突（版本已漂移 v${row.version}）：请刷新后重试。`);
        // 带交接注记 = 活已干成（succeeded + 证据）；无注记 = 未完工归还（release 语义）——两种原语不混用
        if (conclusion)
            settleDispatch(db, dsp.id, "succeeded", `task_settle by ${agentName()}：${conclusion.slice(0, 200)}`);
        else
            releaseDispatch(db, dsp.id, `task_settle by ${agentName()}${failed ? "（自报 failed）" : ""}`);
        appendEvent(db, { memory_id: memoryId, op: "task_settle", payload: JSON.stringify({ by: agentName(), dispatch_id: dsp.id, generation: dsp.generation, session_id: args.session_id ?? null, handoff: conclusion || null, outcome: conclusion ? "succeeded" : (failed ? "failed" : "released") }), operator: `agent:${agentName()}` });
        try {
            for (const c2 of cardsOfTask(db, memoryId)) { // ★ ③-A：全集合归还（review 卡一并回 ready——B2 转入待验收后也可凭 ticket 反悔）
                if (c2.status !== "running" && c2.status !== "review")
                    continue;
                db.prepare(`UPDATE cards SET status='ready', assignee=NULL, claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(c2.id);
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c2.id, `agent:${agentName()}`, "mcp_settle", c2.status, "ready", `任务 #${memoryId} ticket 结算归还`);
            }
        }
        catch (e) { console.error(`[task_settle] 卡片侧更新失败（记忆侧已归还）：${e.message}`); }
    });
    if (settleAbort)
        return settleAbort;
    return `任务 #${memoryId} 已凭 ticket 结算并归还（status=pending，重新可领；dispatch gen=${dsp.generation} 已${conclusion ? " succeeded 结算（交接注记已留痕）" : failed ? " failed 结算" : "释放"}）` + stateReceipt({ op: "task_settle", id: memoryId, status: "pending", version: row.version + 1, dispatch_id: dsp.id, generation: dsp.generation, outcome: conclusion ? "succeeded" : (failed ? "failed" : "released") });
}

/** task_heartbeat：刷新在办任务租约（无关联卡时仅记事件） */
export function heartbeatTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const aliveErr = assertTaskAlive(row);
    if (aliveErr)
        return aliveErr;
    const st = readTaskState(row.content);
    if (!st || st.status !== "in_progress")
        return `#${args.memory_id} 当前非进行中，无需续租。`;
    const who = args.as && args.as !== "any" ? args.as : agentName();
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, who);
    const fence = fencedLine(ctx, row.id, args.dispatch_key, who);
    const tail = fence || dspNotice; // ★ A3：fenced 行优先，语义重叠只播报一次
    if (st.assignee !== "?" && st.assignee !== who)
        return `#${args.memory_id} 认领者为 ${st.assignee}，${who} 无权续租。`;
    const card = cardOfTask(db, row.id);
    if (!card) {
        appendEvent(db, { memory_id: row.id, op: "task_heartbeat", payload: JSON.stringify({ by: who, cards: [] }), operator: `agent:${agentName()}` });
        return `任务 #${row.id} 续租成功（无关联卡片，纯任务，仅记事件）。` + tail;
    }
    const hMin = leaseMinutesOf(args.lease_minutes); // ★ 第二批·第 3 步：与 claim / 过期判据同一套时长
    const hRunning = cardsOfTask(db, row.id).filter((cc) => cc.status === "running");
    if (hRunning.length) {
        // ★ 一致性①：续租 + 事件一笔事务（两步写不再可能半途分裂）
        runTaskTx(db, () => {
            touchCardLease(db, row.id, null, hMin);
            appendEvent(db, { memory_id: row.id, op: "task_heartbeat", payload: JSON.stringify({ by: who, cards: hRunning.map((cc) => cc.id), window_min: hMin }), operator: `agent:${agentName()}` });
        });
        return `任务 #${row.id} 续租成功（全集合 ${hRunning.length} 张 running 卡，租约窗口 → ${hMin} 分钟）。` + tail;
    }
    const hFirst = card;
    return `任务 #${row.id} 续租未生效：卡片 #${hFirst.id} 当前 status=${hFirst.status}${hFirst.claim_lock ? "（他方持有租约）" : ""}。` + tail;
}

/** ★ #700057：本次认领若是「租约过期回收 / takeover 换代」，事件流里记着前手（原主）——归还时据此自动退回。
 *  普通认领没有可归还的原主（当前负责人本来就是原主），返回 null；换手之后又正式改派过的，原主信息作废不猜。 */
function predecessorOwnerOf(db, memoryId) {
    try {
        // ★ 2026-11-14（第4项）：新旧事件合并读取（去重后按时间倒序），历史前手记录仍可见。
        const evs = readTaskEventRows(db, memoryId, ['task_lease_reclaim', 'task_takeover', 'task_assign', 'task_delegate'], 20);
        for (const e of evs) {
            if (e.op === "task_assign" || e.op === "task_delegate")
                return null;
            let p = {};
            try { p = JSON.parse(e.payload || "{}"); } catch { /* 坏 payload 视为无记录 */ }
            const prev = String(p.prev_assignee ?? "").trim();
            if (prev && !isPublicTaskAssignee(prev))
                return prev;
        }
        return null;
    }
    catch { return null; }
}

/** task_release：释放认领（in_progress→pending 清锁；仅当前认领者或持凭据者） */
export function releaseTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const aliveErr = assertTaskAlive(row);
    if (aliveErr)
        return aliveErr;
    const cred = checkWriteCredential(ctx, agentName(), args.credential);
    if (!cred.ok)
        return cred.msg;
    const st = readTaskState(row.content);
    if (!st || st.status !== "in_progress")
        return `#${args.memory_id} 当前 status=${st?.status}，仅进行中任务可释放。`;
    const who = agentName();
    const owner = String(st.assignee ?? "?").trim();
    // ★ #700057 验收③：越权拒绝——归还只能由当前认领者本人（或持 scope>=write 凭据者）发起。
    //   旧实现只有文案承诺、代码零校验：任何 agent 都能把别人的在办任务退回去（工作证被第三方注销）。
    if (!isPublicTaskAssignee(owner) && owner !== who && !cred.credId)
        return `#${args.memory_id} 当前负责人是 ${owner}，你不是认领者：归还仅限本人或持 scope>=write 凭据者。\n下一步：要收回该任务请 task_claim(takeover=true, credential=…)，或让 ${owner} 本人 task_release。`;
    // ★ #700057 验收①：归还原主——assignee_to 显式指定优先；未指定时若本次是租约回收/接管换手，
    //   自动退回事件流里记的前手；两者都没有才保持当前负责人（旧行为）。
    const prevOwner = predecessorOwnerOf(db, row.id);
    const askedTo = args.assignee_to !== undefined && args.assignee_to !== null ? String(args.assignee_to).trim() : "";
    const backTo = askedTo ? (isPublicTaskAssignee(askedTo) ? "?" : askedTo) : (prevOwner ?? owner);
    const backErr = assertAssignee(backTo);
    if (backErr)
        return `#${args.memory_id} ${backErr}`;
    const backPublic = isPublicTaskAssignee(backTo);
    // ★ 一致性①：头 CAS + 事件 + 卡释放包成一笔事务——此前卡侧失败会出现
    //   「记忆头已释放、卡仍 running 持锁」的半笔账；现崩溃/锁失败窗口整体回滚，头与卡不再各走各的。
    let newContent = null;
    // ★ 第 5 步：释放须留进度摘要（args.progress → 旧摘要 → reason 兜底；三者同一格式、同一长度上限）
    const relProgress = sanitizeHeadText(args.progress, PROGRESS_MAX) || st.progress
        || (args.reason ? sanitizeHeadText(`释放：${args.reason}`, PROGRESS_MAX) : null);
    const relAbort = runTaskTx(db, () => {
        newContent = taskBodyWithDep("pending", backTo, st.deps, taskBody(row.content), st.scope ?? [], { acceptance: st.acceptance, progress: relProgress });
        const released = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version });
        if (!released)
            throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
        appendEvent(db, { memory_id: row.id, op: "task_release", payload: JSON.stringify({ by: who, reason: (args.reason ?? "").trim() || null, progress: relProgress ?? null, session_id: args.session_id ?? null, cred_id: cred.credId, assignee_from: owner, assignee_to: backTo, restored_owner: !askedTo ? (prevOwner ?? null) : null, explicit_target: askedTo ? backTo : null }), operator: `agent:${who}` });
        try {
            for (const c2 of cardsOfTask(db, row.id)) { // ★ ③-A：全集合释放（多卡任务第 2..n 张一并回 ready 清锁）
                if (c2.status !== "running")
                    continue;
                // ★ #700057 验收②：卡片负责人与任务头同一取值（未指派 → NULL），看板不再出现「头写原主、卡写归还者」
                const cardAssignee = backPublic ? null : backTo;
                const rel = db.prepare(`UPDATE cards SET status='ready', assignee=?, claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(cardAssignee, c2.id);
                if (Number(rel.changes) === 0) console.error(`[task_release] ⚠ 卡片 #${c2.id} 未更新（changes=0），三方可能不一致`);
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c2.id, `agent:${who}`, "mcp_release", "running", "ready", `任务 #${row.id} 归还（负责人 → ${cardAssignee ?? "未指派"}，${(args.reason ?? "").trim() || "未注明"}）`);
            }
        }
        catch (e) { console.error(`[task_release] 卡片侧更新失败（记忆侧已释放）：${e.message}`); }
        // ★ 2026-11-13：归还任务 = 明确放弃本轮工作证。把该任务的 active/stale 派发一并置 released，
        //   否则「卡已 ready、工作证仍 active」的悬挂行会长期占着权威位置（active 会挡住 takeover）。
        //   分寸：只处理本次显式归还的任务，不做批量过期结算（#7463 已确认的禁区）。
        try {
            for (const dsp of db.prepare(`SELECT id FROM dispatches WHERE memory_id=? AND state IN ('active','stale')`).all(row.id))
                releaseDispatch(db, dsp.id, `task_release by ${who}：${(args.reason ?? "").trim() || "归还任务"}`);
        }
        catch (e) { console.error(`[task_release] 工作证释放失败（卡侧已归还）：${e.message}`); }
    });
    if (relAbort)
        return relAbort;
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, agentName());
    // ★ #700057：回执说清负责人去了哪，而不是一律「重新可领」（还给原主时别人其实领不了）
    const ownerNote = backPublic
        ? `负责人已置为未指派${owner && owner !== "?" ? `（原 ${owner}）` : ""}，重新可领`
        : backTo === owner
            ? `负责人仍为 ${backTo}，仅本人可再领`
            : askedTo
                ? `负责人已写回 ${backTo}（原 ${owner}），仅 ${backTo} 可再领`
                : `负责人已归还原主 ${backTo}（原 ${owner}），仅 ${backTo} 可再领`;
    return `任务 #${row.id} 已释放（status=pending，${ownerNote}）；${progressLineOf(relProgress) || "进度摘要：无（可用 progress 参数补一句）"}：${newContent.replace(/\s+/g, " ").slice(0, 100)}` + stateReceipt({ op: "task_release", id: row.id, status: "pending", version: row.version + 1, assignee: backTo, cred_id: cred.credId, progress: relProgress ?? undefined }) + dspNotice;
}

/** task_block：把任务标记受阻（blocked 不进可做集；原因必须留痕） */
export function blockTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const aliveErr = assertTaskAlive(row);
    if (aliveErr)
        return aliveErr;
    const cred = checkWriteCredential(ctx, agentName(), args.credential);
    if (!cred.ok)
        return cred.msg;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常，无法标记受阻。`;
    const tErr = assertTransition(st.status, "blocked");
    if (tErr)
        return `#${args.memory_id} ${tErr}`;
    // ★ 一致性①：头 CAS + 事件 + 卡投影一笔事务
    const blkAbort = runTaskTx(db, () => {
        const body = `${taskBody(row.content)}\n⛔ 受阻(${agentName()})：${sanitizeTaskText(args.reason).trim()}`;
        const blocked = updateMemory(db, row.id, { content: taskBodyWithDep("blocked", st.assignee, st.deps, body, st.scope ?? [], st), expectedVersion: row.version });
        if (!blocked)
            throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
        appendEvent(db, { memory_id: row.id, op: "task_block", payload: JSON.stringify({ by: agentName(), reason: args.reason.trim(), session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${agentName()}` });
        syncTaskToCard(db, row.id, "blocked", { actor: `agent:${agentName()}`, source: "agent", detail: `任务 #${row.id} MCP 标记受阻` });
    });
    if (blkAbort)
        return blkAbort;
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, agentName());
    return `任务 #${row.id} 已标记受阻（status=blocked）：${args.reason.trim().slice(0, 100)}` + stateReceipt({ op: "task_block", id: row.id, status: "blocked", version: row.version + 1, cred_id: cred.credId }) + dspNotice;
}

/** task_reopen：重开终态任务（done/cancelled→in_progress 重新指派） */
export function reopenTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    if (row.status === "merged")
        return `#${args.memory_id} 已被 #${row.superseded_by ?? "?"} 取代（merged），不可重开；如需该工作请操作取代它的主任务。`;
    const cred = checkWriteCredential(ctx, agentName(), args.credential);
    if (!cred.ok)
        return cred.msg;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常，无法重开。`;
    if (!["done", "cancelled"].includes(st.status)) // E-0：failed 已取消（存量归一 in_progress），merged 已在上方单独拒绝
        return `#${args.memory_id} 当前 status=${st.status}，仅终态（done/cancelled）可重开。`;
    // ★ 一致性①：列复活 + 头 CAS + 事件 + 卡重开一笔事务——CAS 中止即整体回滚，不再「列已复活、头没重开」错位
    const who = args.assignee || st.assignee || "?";
    const whoErr = assertAssignee(who);
    if (whoErr)
        return whoErr;
    const ropenAbort = runTaskTx(db, () => {
        if (row.status === "archived") // 重开即复活——否则重开后头/列错位、任务依旧不可见
            db.prepare(`UPDATE ${TASKS} SET status='active' WHERE id=?`).run(row.id);
        const body = `${taskBody(row.content)}\n↻ 重开(${agentName()})：${sanitizeTaskText(args.reason).trim()}`;
        const reopened = updateMemory(db, row.id, { content: taskBodyWithDep("in_progress", who, st.deps, body, st.scope ?? [], st), expectedVersion: row.version });
        if (!reopened)
            throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
        appendEvent(db, { memory_id: row.id, op: "task_reopen", payload: JSON.stringify({ by: agentName(), from: st.status, to: who, reason: args.reason.trim(), session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${agentName()}` });
        try {
            for (const c2 of cardsOfTask(db, row.id)) { // ★ ③-A：全集合重开（第 2..n 张一并回 ready，不留旧锁）
                if (!["done", "archived", "cancelled"].includes(c2.status))
                    continue;
                db.prepare(`UPDATE cards SET status='ready', claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL, assignee=?, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(who === "?" ? null : who, c2.id);
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c2.id, `agent:${agentName()}`, "mcp_reopen", c2.status, "ready", `任务 #${row.id} 重开（${args.reason.trim().slice(0, 80)}）`);
            }
        }
        catch (e) { console.error(`[task_reopen] 卡片侧更新失败（记忆侧已重开）：${e.message}`); }
    });
    if (ropenAbort)
        return ropenAbort;
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, agentName());
    return `任务 #${row.id} 已重开（${st.status} → in_progress，指派 ${who}）：${args.reason.trim().slice(0, 100)}` + stateReceipt({ op: "task_reopen", id: row.id, status: "in_progress", version: row.version + 1, assignee: who }) + dspNotice;
}

/** task_done：完成任务（→done 结论回写；有 [gate] 先验收，失败回 pending） */
export async function doneTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const aliveErr = assertTaskAlive(row);
    if (aliveErr)
        return aliveErr;
    const cred = checkWriteCredential(ctx, agentName(), args.credential);
    if (!cred.ok)
        return cred.msg;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常，无法完成。`;
    if (st.status === "done")
        return `#${args.memory_id} 已完成，无需重复标记。`;
    // v1.1 状态机：仅 in_progress / review → done 合法
    // ★ 弊端 H1：归属守卫——仅认领者本人（或未认领任务）可完成；
    //   第三方验收关闭走 task_verify（verified_by 留痕），接手工作走 task_reopen 重派。
    if (st.assignee !== "?" && st.assignee !== agentName())
        return `#${row.id} 由 ${st.assignee} 认领，你（${agentName()}）不是认领者，不能代为完成：第三方验收请走 task_admin(action=verify)（带依据），需接手请 task_admin(action=reopen) 重派后再完成。`;
    const tErr = assertTransition(st.status, "done");
    if (tErr)
        return `#${args.memory_id} ${tErr}`;
    // ★ P2-6（C-2）fencing：拒绝过期完成写（lease 被接管 / 版本漂移）
    // ★ ③-A：锁检查改全集合（单卡兼容旧逻辑：存在锁且任一张锁不符才拒）
    const doneLocks = cardsOfTask(db, row.id).filter((cc) => cc.claim_lock);
    const doneMismatch = doneLocks.find((cc) => cc.claim_lock !== args.lease_token);
    if (args.lease_token && doneLocks.length && doneMismatch)
        return `#${args.memory_id} 租约已被接管（卡片 #${doneMismatch.id} 现锁 ${String(doneMismatch.claim_lock).slice(0, 8)}…），本次完成拒绝（fencing）；请重新 task_next。`;
    if (args.expected_version != null && args.expected_version !== row.version)
        return `#${args.memory_id} 版本漂移（期望 v${args.expected_version}，当前 v${row.version}）：完成请求拒绝；请刷新后重试。`;
    // ★ ②-A：A1 硬模式下 fencing 版本必填——防僵尸会话陈旧完成写（默认硬；仅显式 =0 保持旧兼容）
    if (a1Hard() && args.expected_version == null)
        return `#${args.memory_id} A1 门禁（默认开启，fail-closed）：task_done 必须携带 expected_version（fencing：task_next / task_read 回执中的 version）；请刷新任务后重试。${A1_HINT}`;
    // ★ 2026-10-02 Dispatch 语义（对标 orca「Lifecycle authority comes from the active Dispatch」）：
    //   权威**只**来自 active dispatch——传了 key 就必须逐条过关；不传则软模式放行（与 A1 同款兼容策略）。
    const dspRow = args.dispatch_key ? readDispatchByKey(db, args.dispatch_key) : null;
    if (args.dispatch_key) {
        if (!dspRow)
            return `#${args.memory_id} dispatch 不存在（${String(args.dispatch_key).slice(0, 12)}…）：请 task_next / task_claim 重新获取后再完成。`;
        if (Number(dspRow.memory_id) !== Number(row.id))
            return `#${args.memory_id} dispatch 归属不符（该 dispatch 属于任务 #${dspRow.memory_id}）：拒绝跨任务写入。`;
        if (dspRow.state !== "active")
            return `#${args.memory_id} 该 dispatch 已 ${dspRow.state}（你已被取代或已结算）：权威只来自 active dispatch，请重新 task_next 后领取。`;
        if (dspRow.agent !== agentName())
            return `#${args.memory_id} 该 dispatch 由 ${dspRow.agent} 持有，你（${agentName()}）不是持有者：拒绝写入。`;
    }
    const body = taskBody(row.content);
    // ★ 第二批·第 5 步：验收标准逐条对照——只要任务头写了 [accept:…]，就必须逐条给结果；
    //   未逐条确认 / 有 fail 一律不能标 done（某条确实不适用：result=na + note 留理由）。
    const accItems = st.acceptance ?? [];
    let accNote = "";
    if (accItems.length) {
        const raw = Array.isArray(args.acceptance_results) ? args.acceptance_results : [];
        const seen = new Map();
        for (const r of raw) {
            const i = Number(r?.item);
            if (!Number.isInteger(i) || i < 1 || i > accItems.length)
                return `#${row.id} 验收标准共 ${accItems.length} 条，acceptance_results 的 item=${String(r?.item ?? "")} 越界（应按 1..${accItems.length} 逐条给）。`;
            if (seen.has(i))
                return `#${row.id} 验收第 ${i} 条给了多次结果——每条只填一次。`;
            const res = String(r?.result ?? "").trim();
            if (!["pass", "fail", "na"].includes(res))
                return `#${row.id} 验收第 ${i} 条结果须为 pass / fail / na（收到「${res || "空"}」）。`;
            const note = String(r?.note ?? "").trim();
            if (res === "na" && !note)
                return `#${row.id} 验收第 ${i} 条标 na（不适用）必须带 note 写理由，否则不算已对照。`;
            seen.set(i, { result: res, note });
        }
        const missing = [...Array(accItems.length).keys()].map((k) => k + 1).filter((k) => !seen.has(k));
        const failed = [...seen.entries()].filter(([, v]) => v.result === "fail").map(([k]) => k).sort((a, b) => a - b);
        if (missing.length || failed.length) {
            const parts = [];
            if (failed.length)
                parts.push(`没过：${failed.map((k) => `第 ${k} 条「${accItems[k - 1]}」`).join("、")}`);
            if (missing.length)
                parts.push(`未确认：${missing.map((k) => `第 ${k} 条「${accItems[k - 1]}」`).join("、")}`);
            return `#${row.id} 验收未逐条通过，不能标 done —— ${parts.join("；")}。逐条核验后带 acceptance_results 重试（不适用可 result=na + note）；要放弃请 task_block / task_release 说明原因。`;
        }
        accNote = ` 验收：${[...seen.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => v.result === "pass" ? `第 ${k} 条 过` : `第 ${k} 条 不适用（${v.note}）`).join("；")}`;
    }
    // ★ P3 确定性门控：任务头声明 [gate:预设] 时，先跑验收——不信任 Agent 自报结论。
    //   门控通过 → 标记 done；门控失败/未命中预设 → fail-closed，状态置 pending（可重新 task_claim 重试），
    //   并把门控判定落审计（exec_audit + task_gate 事件）；卡片不回退（保持原状态），修复后 done 再同步。
    const gateName = taskGateName(row.content);
    let gateRes = null;
    if (gateName) {
        gateRes = await runTaskGate(ctx, gateName, row.id);
        appendEvent(db, { memory_id: row.id, op: "task_gate", payload: JSON.stringify({ gate: gateName, ...gateRes, fallback: "pending" }), operator: `agent:${agentName()}` });
    }
    if (gateRes && !gateRes.ok) {
        // fail-closed：验收未通过 → 不标 done，回退 pending 留痕。
        // ★ 弊端复盘查漏：卡侧同步 ready + 清租约（assignee 保留=修复者）——
        //   原实现卡片停在 running 持锁，与记忆头 pending 打架，5 分钟后还会被 reconcile 强行对齐。
        // ★ 一致性①：回退 CAS + 卡同步 + 清锁一笔事务。
        const gAbort = runTaskTx(db, () => {
            const pendingContent = `${taskBodyWithDep("pending", st.assignee, st.deps, body, st.scope ?? [], st)}\n→ 结论(${agentName()})：${sanitizeTaskText(args.conclusion).trim()}\n⛔ 门控 gate='${gateName}' 未通过（${String(gateRes.detail).slice(0, 160)}）——状态回退 pending，修复后 task_claim + task_done 重试。`;
            const rolled = updateMemory(db, row.id, { content: pendingContent, expectedVersion: row.version });
            if (!rolled)
                throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：请刷新后重试。`);
            syncTaskToCard(db, row.id, "ready", { actor: `agent:${agentName()}`, action: "gate_fallback", source: "agent", detail: `任务 #${row.id} 门控未通过回退 pending` });
            for (const cc of cardsOfTask(db, row.id)) { // ★ ③-A：全集合清锁（含多卡第 2..n 张）
                // ★ B3（P2 · 开关 MEMORYOS_GATE_BREAKER=1，默认关）：门控失败计数 +1（与 failure_count 分立列）。
                //   清零只在成功收口/人工介入（syncTaskToCard done、transitionCard done|human、acceptCard）——
                //   agent 重领不清零，否则 claim→清零 使熔断器永不可达（见 gateBreakerOn 注释与报告 §3-B3）。
                if (gateBreakerOn())
                    db.prepare(`UPDATE cards SET gate_fail_count=gate_fail_count+1 WHERE id=?`).run(cc.id);
                db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(cc.id);
            }
        });
        if (gAbort)
            return gAbort;
        // ★ B3：回执带熔断计数（开关关时 undefined → stateReceipt 过滤，文案逐字节同改前）
        const gateFailCount = gateBreakerOn()
            ? Math.max(0, ...cardsOfTask(db, row.id).map((cc) => Number(db.prepare(`SELECT gate_fail_count g FROM cards WHERE id=?`).get(cc.id)?.g ?? 0)))
            : undefined;
        return `任务 #${row.id} 门控未通过（gate='${gateName}'：${String(gateRes.detail).slice(0, 120)}）——status=pending（fail-closed，未标 done）。请修复后 task_claim 再 task_done。` + stateReceipt({ op: "task_done_gate_fallback", id: row.id, status: "pending", version: row.version + 1, gate: gateName, gate_fail_count: gateFailCount });
    }
    const gateNote = gateRes && gateRes.ok ? ` 门控 gate='${gateName}' PASS` : "";
    // ★ 弊端 H3：M2 验收双轨对齐——卡带 meta.acceptance 且未跑 [gate:] 门控时不放过 done
    //   （web 侧 /status 已按修 #7 口径拦截；MCP 路径同口径，消除 task_done 绕行通道）。
    if (!gateRes) {
        // ★ ③-A：任一 dispatch 卡带验收标准即拦（原单卡 LIMIT 1：门控写在第 2 张卡上会绕过）
        let accHit = null;
        for (const cc of cardsOfTask(db, row.id)) {
            let m = null;
            try { m = cc.meta ? JSON.parse(String(cc.meta)) : null; }
            catch { m = null; }
            if (m && m.acceptance != null && !(Array.isArray(m.acceptance) && m.acceptance.length === 0)) {
                accHit = cc;
                break;
            }
        }
        if (accHit) {
            // ★ B2（P1 · 开关 MEMORYOS_DONE_AUTOREVIEW=1，默认关=下方原拒绝文案逐字节不动）：
            //   不再拒绝——卡转 review、**头保持 in_progress**（CARD_TO_TASK review→in_progress 自洽，无头/卡分裂）、
            //   回执「已提交，等待验收」；人工 /accept 收口。治 #4「验收规则让 agent 空转」。
            //   与 B1 的分工：B1 的 applyTransition 落地后，agent 收口不得覆盖人工 review 也走同一回执。
            if (doneAutoreviewOn()) {
                const moved = [];
                for (const cc of cardsOfTask(db, row.id)) {
                    let m = null;
                    try { m = cc.meta ? JSON.parse(String(cc.meta)) : null; }
                    catch { m = null; }
                    if (!(m && m.acceptance != null && !(Array.isArray(m.acceptance) && m.acceptance.length === 0)))
                        continue;
                    if (cc.status !== "review") {
                        db.prepare(`UPDATE cards SET status='review', version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(cc.id);
                        db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(cc.id, `agent:${agentName()}`, "autoreview", cc.status, "review", `任务 #${row.id} 自带验收标准：task_done 转待验收（MEMORYOS_DONE_AUTOREVIEW=1，人工 /accept 收口）`);
                    }
                    moved.push(cc.id);
                }
                return `任务 #${row.id} 已提交，等待验收（卡带 meta.acceptance 未跑 [gate:] 门控——按 B2 口径转 review，人工 /accept 后收口；任务头保持 in_progress）：${args.conclusion.trim().slice(0, 100)}` + stateReceipt({ op: "task_done_autoreview", id: row.id, status: "review", awaiting_acceptance: true, cards: moved, version: row.version });
            }
            return `任务 #${row.id} 的卡（卡片 #${accHit.id}）带验收标准（meta.acceptance），但未执行 [gate:<预设>] 门控——task_done 不允许未经确定性验收即关闭（与 web 侧同口径）。请先在任务头声明 gate，或由人工移除卡的验收标准后重试。`;
        }
    }
    // ★ B1（P2 · 开关 MEMORYOS_REVIEW_GUARD=1，默认关）：任务的任一 dispatch 卡处于 review（人工验收/
    //   待验收）时，agent 收口不得覆盖——与 B2 同一回执语义（头保持 in_progress、卡留 review、
    //   「已提交，等待验收」），人工 /accept 后经 syncCardToTask 收口。治 #3 单向覆盖；默认关时
    //   下方原成功路径逐字节不动（缺陷复现见探针 P16c）。
    if (reviewGuardOn()) {
        const reviewCards = cardsOfTask(db, row.id).filter((cc) => cc.status === "review");
        if (reviewCards.length) {
            const cardIds = reviewCards.map((c) => Number(c.id));
            const guardAbort = runTaskTx(db, () => {
                const guardContent = `${taskBodyWithDep("in_progress", st.assignee, st.deps, body, st.scope ?? [], st)}\n→ 结论(${agentName()})：${sanitizeTaskText(args.conclusion).trim()}${gateNote}\n⏳ 提交待验收（卡 #${cardIds.join("/")} 处于 review——按 B1 口径 agent 收口不覆盖人工验收，人工 /accept 后收口）`;
                const guardWrite = updateMemory(db, row.id, { content: guardContent, expectedVersion: row.version });
                if (!guardWrite)
                    throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：请刷新后重试。`);
                // 本次尝试终结（工作已交付，等人工验收）——与 B2 同口径不留给租约机制；
                if (dspRow)
                    settleDispatch(db, dspRow.id, "succeeded", `task_done by ${agentName()} awaiting human accept (review guard)${gateRes ? ` gate=${gateName} PASS` : ""}`);
            });
            if (guardAbort)
                return guardAbort;
            return `任务 #${row.id} 已提交，等待验收（卡 #${cardIds.join("/")} 处于 review——按 B1 口径 agent 收口不覆盖人工验收，人工 /accept 后收口；任务头保持 in_progress）：${args.conclusion.trim().slice(0, 100)}` + stateReceipt({ op: "task_done_review_guard", id: row.id, status: "in_progress", awaiting_acceptance: true, cards: cardIds, version: row.version + 1 });
        }
    }
    // ★ 一致性①：done CAS + 置信强化 + 事件 + 卡同步 + 清租约包成一笔事务——
    //   中途崩溃不再出现「头已 done、卡还 running 持锁」的半笔账；慢的门控子进程验收已在锁外跑完。
    const doneAbort = runTaskTx(db, () => {
        // ★ P2⑳：证据约束——结论正文附来源记忆 id；未附 = unverified（后续按低强度对待）
        const evidenceRaw = String(args.evidence_memory_ids ?? "").replace(/[^0-9,]/g, "");
        const evidenceIds = evidenceRaw ? [...new Set(evidenceRaw.split(",").map((s) => s.trim()).filter(Boolean))] : [];
        const evidenceNote = evidenceIds.length
            ? ` 证据来源：#${evidenceIds.join(" #")}`
            : " 证据来源：（未附，unverified）";
        const newContent = `${taskBodyWithDep("done", st.assignee, st.deps, body, st.scope ?? [], { acceptance: accItems, progress: sanitizeHeadText(args.conclusion, PROGRESS_MAX) })}\n→ 结论(${agentName()})：${sanitizeTaskText(args.conclusion).trim()}${gateNote}${accNote}${evidenceNote}`;
        const doneWrite = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version }); // ★ CAS：并发 done 只有一个生效
        if (!doneWrite)
            throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请 task_next 刷新后重试。`);
        // ★ ④-A：无确定性门控/验收标准的关闭=「自述完成」——事件打 self_verified 标记（验收可据此降权），
        //   置信强化只给低档 0.02；经 [gate:] 门控通过的关闭保持 0.05 全强度。
        const selfVerified = !gateRes;
        bumpConfidence(db, row.id, selfVerified ? 0.02 : 0.05);
        appendEvent(db, { memory_id: row.id, op: "task_done", payload: JSON.stringify({ by: agentName(), session_id: args.session_id ?? null, cred_id: cred.credId, self_verified: selfVerified || undefined, acceptance_results: accItems.length ? args.acceptance_results : undefined, dispatch_id: dspRow?.id, generation: dspRow?.generation, evidence_ids: evidenceIds.length ? evidenceIds : undefined, unverified: evidenceIds.length === 0 || undefined }), operator: `agent:${agentName()}` });
        // ★ 2026-10-02 Dispatch 结算：outcome 必填（orca 口径——禁止只在散文里编码失败）
        if (dspRow)
            settleDispatch(db, dspRow.id, "succeeded", `task_done by ${agentName()}${gateRes ? ` gate=${gateName} PASS` : " self_verified"}${evidenceIds.length ? ` evidence=[${evidenceIds.join(",")}]` : " unverified"}`);
        syncTaskToCard(db, row.id, "done", { actor: `agent:${agentName()}`, source: "agent", detail: `任务 #${row.id} MCP 完成` });
        // ★ P0-B：任务结果关联——把本次 session 注入的记忆与任务成败挂钩，供 daemon 降权低效记忆
        if (args.session_id || evidenceIds.length) {
            const outcome = gateRes ? (gateRes.ok ? "success" : "failed") : evidenceIds.length ? "success" : "unverified";
            const injected = args.session_id
                ? db.prepare(
                    `SELECT DISTINCT memory_id FROM memory_usage
                         WHERE session_id = ? AND event = 'injected' AND project = ?`
                ).all(args.session_id, row.project).map((r) => Number(r.memory_id))
                : [];
            const allEvidence = [...new Set([...injected, ...evidenceIds])];
            for (const mid of allEvidence) {
                db.prepare(
                    `INSERT INTO memory_task_outcomes(memory_id, task_card_id, outcome, session_id)
                         VALUES(?, ?, ?, ?)`
                ).run(mid, row.id, outcome, args.session_id ?? null);
            }
        }
        for (const cc of cardsOfTask(db, row.id)) // ★ ③-A：全集合清锁；P2-6：完成即释放租约锁；⑦：顺带撕贴条
            db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(cc.id);
    });
    if (doneAbort)
        return doneAbort;
    return `任务 #${row.id} 已完成（status=done）[${row.type}|${row.agent}] 结论：${args.conclusion.trim().slice(0, 100)}${accNote}` + stateReceipt({ op: "task_done", id: row.id, status: "done", version: row.version + 1, cred_id: cred.credId, session_id: args.session_id ?? null, acceptance_passed: accItems.length ? [...(args.acceptance_results ?? [])].filter((r) => r.result === "pass").map((r) => Number(r.item)).sort((a, b) => a - b) : undefined, acceptance_na: accItems.length ? [...(args.acceptance_results ?? [])].filter((r) => r.result === "na").map((r) => Number(r.item)).sort((a, b) => a - b) : undefined, dispatch_key: dspRow ? args.dispatch_key : undefined, dispatch_id: dspRow?.id, generation: dspRow?.generation, outcome: dspRow ? "succeeded" : undefined });
}

/** task_verify：第三方验收关闭（只置 done+verified_by 留痕；不改归属、不发租约） */
export function verifyTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const aliveErr = assertTaskAlive(row);
    if (aliveErr)
        return aliveErr;
    const verifier = args.as && args.as !== "any" ? args.as : agentName();
    const cred = checkWriteCredential(ctx, verifier, args.credential);
    if (!cred.ok)
        return cred.msg;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常，无法验收。`;
    if (st.status === "done")
        return `#${args.memory_id} 已是 done，无需验收。`;
    if (!["pending", "in_progress"].includes(st.status))
        return `#${args.memory_id} 当前 status=${st.status}，仅 pending/in_progress 可验收关闭（review 走 task_done，终态走 task_admin(action=reopen)）。`;
    if (args.expected_version != null && args.expected_version !== row.version)
        return `#${args.memory_id} 版本漂移（期望 v${args.expected_version}，当前 v${row.version}）：验收写拒绝；请刷新后重试。`;
    // ★ ②-A：A1 硬模式下 fencing 版本必填——第三方验收写最开放，无版本防护时僵尸会话可陈旧收口（默认硬；仅显式 =0 兼容）
    if (a1Hard() && args.expected_version == null)
        return `#${args.memory_id} A1 门禁（默认开启，fail-closed）：task_admin(action=verify) 必须携带 expected_version（fencing：task_next / task_read 回执中的 version）；请刷新任务后重试。${A1_HINT}`;
    // ★ 一致性①：头 CAS + 事件 + 卡同步 + 清租约一笔事务
    const vfAbort = runTaskTx(db, () => {
        // 不改 assignee（归属保留原文）、不发租约、不动 claim_lock 语义——只闭环状态头 + 留痕
        const rewriteNote = args.user_rewritten
            ? `\n→ 用户改写(${verifier})：${sanitizeTaskText(args.user_rewritten).trim()}`
            : "";
        const newContent = `${taskBodyWithDep("done", st.assignee, st.deps, taskBody(row.content), st.scope ?? [], st)}\n→ 验收(${verifier})：${args.reason.trim()}${rewriteNote}`;
        const verified = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version });
        if (!verified)
            throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
        appendEvent(db, { memory_id: row.id, op: "task_verify", payload: JSON.stringify({ verified_by: verifier, from: st.status, reason: args.reason.trim(), session_id: args.session_id ?? null, cred_id: cred.credId, user_rewritten: args.user_rewritten ? "yes" : undefined }), operator: `agent:${agentName()}` });
        syncTaskToCard(db, row.id, "done", { actor: `agent:${verifier}`, action: "verify", source: "agent", detail: `任务 #${row.id} 第三方验收关闭（${verifier}）${args.user_rewritten ? "，含用户改写" : ""}` });
        for (const cc of cardsOfTask(db, row.id))
            db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, lease_stale_at=NULL WHERE id=?`).run(cc.id);
    });
    if (vfAbort)
        return vfAbort;
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, verifier);
    return `任务 #${row.id} 已验收关闭（status=done，verified_by=${verifier}，未改归属/未发租约）：${args.reason.trim().slice(0, 100)}` + stateReceipt({ op: "task_verify", id: row.id, status: "done", version: row.version + 1, verified_by: verifier, cred_id: cred.credId, session_id: args.session_id ?? null }) + dspNotice;
}

/** task_supersede：重复任务归档（merged+superseded_by 指向主任务，移出可做集） */
export function supersedeTaskDomain(ctx, args = {}) {
    const db = ctx.db;
    const agentName = ctx.agentName;
    const row = readMemory(db, args.memory_id);
    if (!row || row.type !== "task")
        return `#${args.memory_id} 不存在或非任务。`;
    const win = readMemory(db, args.superseded_by);
    if (!win || win.type !== "task")
        return `#${args.superseded_by} 不存在或非任务（winner 须为任务）。`;
    if (args.memory_id === args.superseded_by)
        return `memory_id 与 superseded_by 不能相同。`;
    const st = readTaskState(row.content);
    if (!st)
        return `#${args.memory_id} 任务头格式异常，无法归档。`;
    if (st.status === "done")
        return `#${args.memory_id} 已 done，无需归档。`;
    // ★ 一致性①：merged 归档 + 事件 + 用量记账一笔事务
    const spAbort = runTaskTx(db, () => {
        markMerged(db, args.memory_id, args.superseded_by); // merged + superseded_by；移出检索候选
        appendEvent(db, {
            memory_id: args.memory_id,
            op: "task_supersede",
            payload: JSON.stringify({ superseded_by: args.superseded_by, by: agentName() }),
            operator: `agent:${agentName()}`,
        });
        logUsage(db, {
            memory_id: args.memory_id, event: "supersede", reader_agent: agentName(), writer_agent: agentName(),
            project: row.project, session_id: args.session_id, task_hint: args.task_hint, is_task: true,
        });
    });
    if (spAbort)
        return spAbort;
    const dspNotice = softDispatchNotice(ctx, row.id, args.dispatch_key, agentName());
    return `任务 #${args.memory_id} 已标记被 #${args.superseded_by} 取代（merged ⇒ 移出可做集，可经 superseded_by 追溯）` + dspNotice;
}
