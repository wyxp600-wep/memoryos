/**
 * P2-④（2026-09-22，A 分区接管 B 分区）：server.js MCP 工具面按域拆分 —— 任务域（数量以 `--list-tools` 为准）+ 任务 helper 簇。
 *
 * 搬移口径：自 server.js 原 L892–L1951 逐字搬移（其中 stateReceipt / TxAbort+runTaskTx 已上移 server.js 共享层）；
 *   含状态机白名单、任务头解析、确定性验收门（GATE_PRESETS/runTaskGate）、BEGIN IMMEDIATE 事务包装、卡片投影。
 * 缩进说明：代码行统一加 4 空格；多行模板字面量内部行逐字保留（不改动字符串内容）。
 * 共享顶层名经 ctx 注入：db / AGENT / AGENT_FPATH / ENV_CRED / stateReceipt / runTaskTx / isCredentialValid / nowIso。
 * 门禁：npm test（smoke-task / smoke-p26-lifecycle / smoke-macp）+ npm run lint 全绿。
 */
import { z } from "zod";
import { readMemory, writeMemory, updateMemory, appendEvent, logUsage, bumpConfidence, markMerged, logExecAudit } from "./db.js";
import { TASK_NORMALIZE } from "./task-status-map.js"; // ★ 一致性③（2026-09-19）：归一表上移权威对照表
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";

// ★ 2026-09-25 P0①：门控走异步 execFile（promisify）—— 原实现是同步等待子进程，
//   验收最长 180s 会把 Fastify/MCP 事件循环整个冻死（期间所有请求假死）。
const execFileAsync = promisify(execFile);

export function registerTaskTools(server, ctx) {
    const { db, AGENT, AGENT_FPATH, ENV_CRED, stateReceipt, runTaskTx, isCredentialValid, nowIso } = ctx;
    /** ★ E-0 裁决落码（2026-09-19，附录 G）：持久状态集合 = {pending, in_progress, blocked, done, cancelled, merged}。
     *  相对旧 7 态取消 review/failed（存量头经 TASK_NORMALIZE 归一为 in_progress），新增 merged（task_supersede 产生，终态）；
     *  archived 为记忆轴终态（列归档时由 db.js syncTaskHeaderOnTerminal 同步进头，占一席但无 out-edge）。
     *  dependency_blocked / reopened 为展示层派生态，不落库、不可迁移进入（task_next 阻塞段 / task_reopen 留痕）。 */
    const TASK_STATUSES = ["pending", "in_progress", "blocked", "done", "cancelled", "merged", "archived"];
    /** 合法迁移白名单：源状态 → 允许的目标状态；终态（done/cancelled/merged/archived）不可直接转回，重开走 task_reopen（reopened 语义留痕） */
    const TASK_TRANSITIONS = {
        pending: ["in_progress", "cancelled"],
        in_progress: ["blocked", "done", "cancelled"],
        blocked: ["in_progress", "cancelled"],
        done: [],
        cancelled: [],
        merged: [],
        archived: [],
    };
    /** 校验迁移合法性，非法返回错误提示；空/可写由调用方决定 */
    function assertTransition(from, to) {
        const allowed = TASK_TRANSITIONS[from] || [];
        if (!allowed.includes(to)) {
            return `非法状态迁移 ${from} → ${to}（白名单: ${allowed.join(", ") || "终态不可迁移"}）`;
        }
        return null;
    }
    /** ★ 2026-09-19（实操问题 #6）：assignee 白名单 —— 小写 kebab（[a-z][a-z0-9_-]{0,31}）；"?" 为未指派哨兵放行。
     *  实测脏值 54%（"/" 占位、"前端开发者" 人类角色名、测试残留）污染 task_next 的身份聚合与「我在做」判定。 */
    const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
    function assertAssignee(name) {
        if (name === undefined || name === null || name === "" || name === "?")
            return null;
        if (typeof name !== "string" || !AGENT_NAME_RE.test(name))
            return `assignee「${name}」不合规：须为小写字母开头的 kebab 标识（[a-z][a-z0-9_-]{0,31}，如 codex/trae/zcode/workbuddy）；"?" 表示未指派。`;
        return null;
    }
    /** ★ 2026-09-19（实操问题 #8）：A1 凭据校验 —— 全部会改任务头/卡片归属的写工具统一入口。
     *  带凭据 → 严格校验（凭据归属 who + 未撤销未过期 + scope>=write，杜绝拿他人凭据改写归属）；
     *  不带凭据 → 软模式放行（事件留痕 cred_id=null），MEMORYOS_A1_ENFORCE=1 时硬拒绝（fail-closed）。 */
    function checkWriteCredential(who, credential) {
        const HARD = process.env.MEMORYOS_A1_ENFORCE === "1";
        const cred = credential || ENV_CRED; // ★ 一致性⑧：入参缺失时回退 env 注入凭据
        if (!cred) {
            if (HARD)
                return { ok: false, credId: null, msg: `A1 硬模式（MEMORYOS_A1_ENFORCE=1）：${who} 必须携带 scope>=write 的凭据——先 memory_credential(action=issue, scope=write) 签发后随 credential 入参携带，或在 MCP 配置注入 MEMORYOS_A1_CREDENTIAL 环境变量（node dist/a1-bootstrap.js 一键签发）。` };
            return { ok: true, credId: null, msg: "" };
        }
        const row = db.prepare(`SELECT id, agent, scope, expires_at, revoked_at FROM agent_credentials WHERE credential=?`).get(String(cred));
        if (!row || row.agent !== who)
            return { ok: false, credId: null, msg: `A1 拒绝：凭据不属于 ${who} 或不存在（不接受他人凭据改写任务归属）。` };
        if (!isCredentialValid(row))
            return { ok: false, credId: row.id, msg: `A1 拒绝：凭据已${row.revoked_at ? "撤销" : "过期"}（id=${row.id}）；请 memory_credential(action=issue) 重新签发。` };
        if (row.scope === "read")
            return { ok: false, credId: row.id, msg: `A1 拒绝：凭据 scope=read 不足，改写任务需 scope>=write（id=${row.id}）。` };
        return { ok: true, credId: row.id, msg: "" };
    }
    /** ★ 2026-09-18（实操问题 #1，P0）：按 id 分支的列守卫。readMemory 是裸 `WHERE id=?`（无 status 过滤），
     *  实测 29 条任务「头 pending 但列已 archived/merged」——列表分支有列过滤挡住，按 id 分支只看头文本会放行。
     *  返回错误文案（不可操作）或 null（放行）。 */
    function assertTaskAlive(row) {
        if (!["active", "trial"].includes(String(row.status ?? ""))) {
            return `#${row.id} 列状态为 ${row.status}（${row.status === "merged" ? "已被其他任务取代" : "已归档"}），不可按 id 操作；请用 task_next 取当前可做集。`;
        }
        return null;
    }
    /** content 头正则：兼容七态 + 存量三态（open/claimed/done） */
    const TASK_HEAD_RE = /^\[task\]\[assignee:[^\]]*\]\[status:([a-z_]+)\]/;
    function taskHead(status, assignee) {
        return `[task][assignee:${assignee}][status:${status}]`;
    }
    /** 依赖段：`[depends:12,15]`（紧跟状态头之后，可缺省） */
    const TASK_DEP_RE = /\[depends:([0-9,\s]+)\]/;
    /** ★ 2026-09-19（弊端 H4/H5）：头字段（status/assignee/depends/gate）只解析头行——
     *  正文里引用的 [depends:]/[gate:]/[status:] 标记视为普通正文，不再影响依赖判定/门控/对账。 */
    function headLineOf(content) {
        const s = String(content ?? "");
        const i = s.indexOf("\n");
        return i < 0 ? s : s.slice(0, i);
    }
    function readTaskState(content) {
        const m = String(content ?? "").match(TASK_HEAD_RE);
        if (!m)
            return null;
        const hl = headLineOf(content);
        const am = hl.match(/\[assignee:([^\]]*)\]/);
        const dm = hl.match(TASK_DEP_RE);
        const deps = dm ? dm[1].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : [];
        return { assignee: am ? am[1] : "?", status: TASK_NORMALIZE[m[1]] || m[1], deps };
    }
    /** 拆掉状态头和头行依赖段的纯正文（正文中引用的 [depends:] 属正文，不剥） */
    function taskBody(content) {
        return String(content ?? "").replace(TASK_HEAD_RE, "").replace(/^\s*\[depends:[^\]]*\]/, "").trim();
    }
    /** 构造正文时保留依赖段 */
    function taskBodyWithDep(status, assignee, deps, body) {
        const depStr = deps.length ? ` [depends:${deps.join(",")}]` : "";
        return `${taskHead(status, assignee)}${depStr} ${body}`;
    }
    /** ★ 2026-09-19（弊端 H4，纵深一层）：写入任务正文的自由文本（结论/原因）中性化其可能引用的
     *  状态标记——正文无法再"种"依赖/门控/归属（〔status: 之类对解析器无效）。 */
    function sanitizeTaskText(t) {
        return String(t ?? "").replace(/\[(status|depends|gate|assignee):/g, "〔$1:");
    }
    /** 依赖是否全部 done */
    /**（depsSatisfied 已于 2026-09-19 移除：done 判据并入 task_next 内的 depDoneOf —— 按头文本判定 + merged 传递解析，见该处注释） */
    /**
     * P3 确定性门控（融合架构「不信任 Agent 报告，由确定性代码验证目标是否真正达成」）：
     * 任务头可声明 [gate:预设名]。task_done 前先跑该验收——通过才标 done；
     * 失败或未命中预设则 fail-closed 回退 pending（E-0 前曾标注回退 review，该态已取消）。
     * 安全口径（Mimosa 命令注入防御）：预设名 → {label, argv}，argv 全部为字面量常量，
     * 固定 node 解释器 + 参数数组、shell:false，请求值仅做枚举匹配，绝不参与命令构造。
     */
    const GATE_PRESETS = {
        "lint-sql": { label: "lint-sql", argv: ["dist/lint-sql-arity.js"] },
        "lint-catch": { label: "lint-catch", argv: ["dist/lint-silent-catch.js"] },
        "smoke-mcp": { label: "smoke-mcp", argv: ["dist/smoke-mcp.js"] },
        "smoke-task": { label: "smoke-task", argv: ["dist/smoke-task.js"] },
        "smoke-p26": { label: "smoke-p26", argv: ["dist/smoke-p26-lifecycle.js"] },
        "snapshot": { label: "snapshot --check", argv: ["dist/snapshot-routes.js", "--check"] },
    };
    function taskGateName(content) {
        // ★ 2026-09-19（弊端 H4）：gate 标记只认头行——正文里引用的 [gate:预设] 不再触发验收（与 headLineOf 同源）
        const m = headLineOf(content).match(/\[gate:([a-z0-9-]+)\]/);
        return m ? m[1] : null;
    }
    /** 验收命令的确定性 cwd：resources/memoryos 目录（lint/snapshot 类脚本按 import.meta.url 自定位，
     *  但 smoke 类脚本用 process.cwd() 拼 data/ 与 dist/ 相对路径 → cwd 必须是 resources/memoryos，
     *  而非仓库根；env MEMORYOS_WORKSPACE 仅在显式注入时覆盖（保持 exec-tools 口径一致）。 */
    function _gateRoot() {
        const envRoot = (process.env.MEMORYOS_WORKSPACE || "").trim();
        if (envRoot)
            return envRoot;
        return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    }
    /** ★ 2026-09-25 P0①：async（异步 execFile）—— 调用点必须 await，否则拿到的是 Promise 而非验收结果 */
    async function runTaskGate(db, gate, memoryId) {
        const preset = GATE_PRESETS[gate];
        if (!preset) {
            const detail = `预设 '${gate}' 未定义（可选：${Object.keys(GATE_PRESETS).join(" / ")}）——fail-closed 不执行`;
            try { logExecAudit(db, { tool: "task_gate", risk: "L0", approval: "gate-reject", agent: AGENT, memory_id: memoryId, argsDigest: gate, detail, ok: false }); } catch { }
            return { ok: false, executed: false, detail };
        }
        const root = _gateRoot();
        let r;
        try {
            // 固定字面量 node 解释器 + 预设内字面量 argv（上方 GATE_PRESETS），shell:false，无用户输入参与
            // promisify(execFile) 成功时只 resolve {stdout, stderr}（无 status）→ 显式补 status:0（退出码 0 才 resolve）
            r = { status: 0, ...(await execFileAsync("node", preset.argv, { shell: false, cwd: root, encoding: "utf8", timeout: 180000, windowsHide: true })) };
        }
        catch (e) {
            // execFile 非零退出/超时被杀/起不来都以 reject 表达：退出码与两路输出都挂在 error 上
            // （正常非零退出 code 为数字；ENOENT 等系统错误为字符串 → status 记 null，detail 回落 error.message）
            r = {
                status: typeof e?.code === "number" ? e.code : null,
                stdout: e?.stdout ?? "",
                stderr: e?.stderr ?? (e?.message ?? String(e)),
            };
        }
        const ok = r.status === 0;
        const detail = `${preset.label} exit=${r.status} ${String(r.stdout || r.stderr || "").trim().slice(0, 200)}`;
        try { logExecAudit(db, { tool: "task_gate", risk: "L0", approval: "gate-auto", agent: AGENT, memory_id: memoryId, argsDigest: gate, detail, ok }); } catch { }
        return { ok, executed: true, detail };
    }
    server.addTool({
        name: "task_gate",
        description: "多 Agent 协同·确定性验收门：查看任务的 [gate:预设] 声明与最近一次验收结果。预设白名单（lint-sql/lint-catch/smoke-mcp/smoke-task/smoke-p26/snapshot）——task_done 会先跑该验收，通过才 done，失败 fail-closed 回退 pending（E-0 后无 review 态）。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("要查看验收门的任务记忆 id"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            const row = readMemory(db, args.memory_id);
            if (!row || row.type !== "task")
                return `#${args.memory_id} 不存在或非任务。`;
            const st = readTaskState(row.content);
            if (!st)
                return `#${args.memory_id} 任务头格式异常。`;
            const gate = taskGateName(row.content);
            if (!gate)
                return `#${args.memory_id} 未声明验收门（任务头无 [gate:预设]）。task_done 不做确定性验收。白名单预设：${Object.keys(GATE_PRESETS).join(" / ")}`;
            const last = db.prepare(`SELECT payload FROM memory_events WHERE memory_id=? AND op='task_gate' ORDER BY id DESC LIMIT 1`).get(row.id);
            let lastRes = null;
            try { lastRes = last ? JSON.parse(last.payload) : null; } catch { }
            return `#${args.memory_id} 验收门 = [gate:${gate}]（预设：${Object.keys(GATE_PRESETS).join(" / ")}）\n当前状态=${st.status}${lastRes ? `\n最近验收：${lastRes.ok ? "PASS" : "FAIL"}（${String(lastRes.detail ?? "").slice(0, 120)}）` : "\n尚无验收记录（task_done 时自动执行）。"}`;
        },
    });
    server.addTool({
        name: "task_assign",
        description: "多 Agent 协同：把任务交给指定 Agent（写 type='task' 记忆，状态 open）。depends_on 声明依赖（逗号分隔），依赖全 done 后本任务才可做；对方用 task_claim 领取、task_done 完成、task_next 查可做集。默认同步建任务地图卡（create_card=true），卡片流转回写 memories 状态头。",
        parameters: z.object({
            content: z.string().describe("任务描述（不含状态头，工具自动加）"),
            assignee: z.string().describe("接收方 agent 名（如 codex/trae/zcode/claude）"),
            depends_on: z.string().optional().describe("依赖的任务 id，逗号分隔（如 '12,15'）；依赖全 done 后本任务才可做"),
            project: z.string().default("global").describe("任务 scope"),
            create_card: z.boolean().default(true).describe("是否在任务地图同步建卡（默认开）"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            const asgErr = assertAssignee(args.assignee); // ★ #6：assignee 白名单（小写 kebab；"?"=未指派）
            if (asgErr)
                return asgErr;
            const body = args.content.trim();
            const deps = (args.depends_on ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter((s) => /^\d+$/.test(s))
                .join(",");
            const full = deps
                ? `${taskHead("pending", args.assignee)} [depends:${deps}] ${body}`
                : `${taskHead("pending", args.assignee)} ${body}`;
            // ★ 一致性①（2026-09-19）：记忆 + 事件 + 建卡 + 用量记账包成一笔事务 —— 中途失败整体回滚，
            //   不再出现「任务记忆已写入、事件/卡片缺失」的半笔账（建卡仍 best-effort：失败留文案，对账补卡兜底）。
            let row = null;
            let cardInfo = "";
            const asgAbort = runTaskTx(db, () => {
                row = writeMemory(db, {
                    content: full,
                    type: "task",
                    agent: AGENT,
                    agent_fpath: AGENT_FPATH,
                    project: args.project,
                });
                appendEvent(db, {
                    memory_id: row.id,
                    op: "task_assign",
                    payload: JSON.stringify({ from: AGENT, to: args.assignee, project: args.project, depends: deps || null }),
                    operator: `agent:${AGENT}`,
                });
                // ★ 2026-09-15：task_assign 同步建卡（默认 open=create_card），避免任务地图无卡可领。
                // 复用 from-memory 的 ref 关联：ref_kind='memory', ref_id=task 记忆 id → 卡片状态流转可经此回写 memories。
                if (args.create_card !== false) {
                    try {
                        const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(row.id);
                        const title = body.split("\n")[0].replace(/\[[^\]]*\]/g, "").trim().slice(0, 120) || `任务 #${row.id}`;
                        const cardId = dup
                            ? dup.id
                            : Number(db
                                .prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,priority,assignee) VALUES ('default','task',?,?,'ready','memory',?,?,?)`)
                                .run(title, body.slice(0, 2000), row.id, 3, args.assignee).lastInsertRowid);
                        db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'dispatch')`).run(cardId, row.id);
                        cardInfo = ` + 地图卡 #${cardId}`;
                    }
                    catch (e) {
                        console.error(`[task_assign] 建卡失败（任务 #${row.id}）: ${e instanceof Error ? e.message : String(e)}`);
                        cardInfo = `（建卡失败：${e instanceof Error ? e.message : String(e)}）`;
                    }
                }
                logUsage(db, {
                    memory_id: row.id, event: "write", reader_agent: AGENT, writer_agent: AGENT,
                    project: row.project, session_id: args.session_id, task_hint: args.task_hint,
                });
            });
            if (asgAbort)
                return asgAbort;
            return `已分派任务 #${row.id} → ${args.assignee}（status=pending）${cardInfo}[${row.type}|${row.agent}] ${row.content.replace(/\s+/g, " ").slice(0, 120)}`;
        },
    });
    /**
     * ★ 协议层·A2A 委派（融合架构「A2A 智能体对等协作」的落地映射）：
     * task_delegate = 跨 agent 委派一次任务，内部走既有 task_assign 的租约式任务流，
     * 但任务头打 [a2a:caller→target] 标记 + 校验目标 agent 是否持有有效凭据（A1 认证层联动）。
     * 不引入新协议栈：复用 task_* 状态机（pending/in_progress/done）+ 确定性门控（P3）+ 凭据校验（A1）。
     */
    server.addTool({
        name: "task_delegate",
        description: "A2A 委派层：把任务对等委派给另一个 agent（A2A agent-to-agent）。内部建 task_assign 任务并打 [a2a] 协议标记；若目标 agent 无有效凭据（A1 认证层）则拒绝委派（fail-closed）。可选声明验收门 gate（P3，task_done 时确定性验收）。",
        parameters: z.object({
            content: z.string().describe("委派的任务描述"),
            to: z.string().describe("目标 agent（如 codex/claude/trae/workbuddy/zcode）"),
            from: z.string().optional().describe("发起方 agent（缺省=当前 AGENT）"),
            gate: z.string().optional().describe("确定性验收门预设（lint-sql/lint-catch/smoke-mcp/smoke-task/smoke-p26/snapshot），写入任务头 [gate:预设]"),
            require_credential: z.boolean().default(true).describe("是否要求目标 agent 持有有效凭据（A1 认证层，默认开；fail-closed）"),
            project: z.string().default("global"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            const caller = (args.from || AGENT).trim();
            // A1 认证层联动：目标 agent 必须持有有效（未撤销且未过期）凭据，否则 fail-closed 拒绝
            if (args.require_credential !== false) {
                const rows = db.prepare(`SELECT id FROM agent_credentials WHERE agent=? AND revoked_at IS NULL AND expires_at > ?`).all(args.to, nowIso());
                if (!rows.length)
                    return `A2A 委派拒绝（fail-closed）：目标 agent=${args.to} 无有效凭据。请先 memory_credential(action=issue, agent=${args.to}) 签发短生命周期凭据，再委派。`;
            }
            const gate = args.gate && GATE_PRESETS[args.gate] ? args.gate : null;
            const body = `[a2a:${caller}→${args.to}]${gate ? ` [gate:${gate}]` : ""} ${args.content.trim()}`;
            // 复用 task_assign 的任务头/建卡/审计（直接写记忆 + 事件 + 卡片）
            const full = `${taskHead("pending", args.to)} ${body}`;
            // ★ 一致性①（2026-09-19）：与 task_assign 同口径 —— 记忆 + 事件 + 建卡一笔事务
            let row = null;
            let cardInfo = "";
            const dlgAbort = runTaskTx(db, () => {
                row = writeMemory(db, {
                    content: full,
                    type: "task",
                    agent: caller,
                    agent_fpath: AGENT_FPATH,
                    project: args.project,
                });
                appendEvent(db, {
                    memory_id: row.id,
                    op: "task_delegate",
                    payload: JSON.stringify({ from: caller, to: args.to, gate, protocol: "a2a", project: args.project }),
                    operator: `agent:${caller}`,
                });
                try {
                    const dup = db.prepare(`SELECT id FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(row.id);
                    const title = `A2A ${caller}→${args.to}: ${args.content.split("\n")[0].replace(/\[[^\]]*\]/g, "").trim().slice(0, 90)}`;
                    const cardId = dup
                        ? dup.id
                        : Number(db
                            .prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,priority,assignee) VALUES ('default','task',?,'A2A 委派','ready','memory',?,?,?)`)
                            .run(title, row.id, 3, args.to).lastInsertRowid);
                    db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,'dispatch')`).run(cardId, row.id);
                    cardInfo = ` + 地图卡 #${cardId}`;
                }
                catch (e) {
                    console.error(`[task_delegate] 建卡失败（任务 #${row.id}）: ${e instanceof Error ? e.message : String(e)}`);
                    cardInfo = `（建卡失败：${e instanceof Error ? e.message : String(e)}）`;
                }
                logUsage(db, {
                    memory_id: row.id, event: "write", reader_agent: caller, writer_agent: caller,
                    project: args.project, session_id: args.session_id, task_hint: args.task_hint,
                });
            });
            if (dlgAbort)
                return dlgAbort;
            return `A2A 已委派任务 #${row.id}：${caller} → ${args.to}${gate ? `（验收门 [gate:${gate}]，task_done 时确定性验收）` : ""}（status=pending）${cardInfo}`;
        },
    });
    server.addTool({
        name: "task_claim",
        description: "多 Agent 协同：领取『分配给我/未认领』的 pending 任务，状态头 pending→in_progress；不传 memory_id 则列出可领列表。as：缺省=本人（仅领指派给自己或 assignee=? 的）；as=<他人名> 仅限恰指派该名；as='any'=托管认领，跳过接收方校验可领任何 pending，改写归属须携 scope>=write 凭据。租约默认 10 分钟，lease_minutes 可延长。",
        parameters: z.object({
            as: z.string().optional().describe("以谁的身份领取（缺省=当前 agent）；传 'any' 托管认领（跳过接收方校验）——语义见工具描述"),
            project: z.string().default("global").describe("任务 scope"),
            memory_id: z.number().int().optional().describe("指定领取某条任务 id；不填则列出当前可领的 pending 任务"),
            expected_version: z.number().int().optional().describe("P2-6 fencing：任务记忆乐观版本（你上次读到的 version）；不一致 → 拒绝陈旧领取"),
            lease_token: z.string().optional().describe("P2-6 fencing：你持有的租约锁（若卡片已被他人接管 → 拒绝僵尸领取）"),
            lease_minutes: z.number().int().min(10).max(120).optional().describe("租约分钟数（10..120，默认 10）；长任务自声明更长租约，超时由 dispatcher 回收"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属认领者）；软模式下可省略，MEMORYOS_A1_ENFORCE=1 时必填"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            if (args.memory_id) {
                const row = readMemory(db, args.memory_id);
                if (!row || row.type !== "task")
                    return `#${args.memory_id} 不存在或非任务。`;
                const aliveErr = assertTaskAlive(row); // ★ 列守卫：archived/merged 不可领（2026-09-18 P0 修复）
                if (aliveErr)
                    return aliveErr;
                const st = readTaskState(row.content);
                if (!st)
                    return `#${args.memory_id} 任务头格式异常，无法认领。`;
                if (st.status !== "pending")
                    return `#${args.memory_id} 当前 status=${st.status}，仅 pending 可认领。`;
                // ★ P2-6（C-2）fencing：乐观版本 + 租约锁 —— 拒绝陈旧领取 / 僵尸领取
                // ★ ③-A：锁检查改全集合（单卡兼容旧逻辑：存在锁且任一张锁不符才拒）
                const claimLocks = cardsOfTask(row.id).filter((cc) => cc.claim_lock);
                const claimMismatch = claimLocks.find((cc) => cc.claim_lock !== args.lease_token);
                if (args.lease_token && claimLocks.length && claimMismatch)
                    return `#${args.memory_id} 租约已被他人接管（卡片 #${claimMismatch.id} 现锁 ${String(claimMismatch.claim_lock).slice(0, 8)}…），本次领取拒绝（fencing）；请重新 task_next 后再领。`;
                if (args.expected_version != null && args.expected_version !== row.version)
                    return `#${args.memory_id} 版本漂移（期望 v${args.expected_version}，当前 v${row.version}）：任务已被其他操作改写，本次领取拒绝；请刷新后再领。`;
                const who = args.as && args.as !== "any" && args.as !== AGENT ? args.as : AGENT;
                const asgErr = assertAssignee(who); // ★ #6：认领者身份入头前过白名单
                if (asgErr)
                    return asgErr;
                const cred = checkWriteCredential(who, args.credential); // ★ A1/#8：归属校验 + scope>=write
                if (!cred.ok)
                    return cred.msg;
                // ★ 2026-09-19（弊端 H2）：as="any" 托管认领会改写归属——默认软模式无凭据放行是治理漏洞；
                //   as="any" 必须携带 scope>=write 凭据（硬模式口径天然满足；本人认领保持软模式兼容）。
                if (args.as === "any" && !args.credential)
                    return `as="any" 托管认领会改写任务归属：请先 memory_credential(action=issue, scope=write) 签发凭据并随 credential 入参携带；若以本人身份认领则不传 as。`;
                if (args.as !== "any" && st.assignee !== "?" && st.assignee !== who) {
                    return `#${args.memory_id} 指派给 ${st.assignee}，你不是接收方（可传 as=any 强制托管认领）。`;
                }
                const newContent = taskBodyWithDep("in_progress", who, st.deps, taskBody(row.content));
                // ★ 2026-09-19（实操复盘并发竞态）：CAS 认领 —— content 写 + version 递增原子化（WHERE version=?），
                //   两会话并发认领同一任务必有一个拿 null 拒绝，不再后写覆盖前写的 assignee/租约。
                // ★ 一致性①（2026-09-19）：CAS + 事件 + 卡投影 + 租约四笔写入包成一笔事务 —— 中途失败整体回滚，
                //   不再出现「头已 in_progress、卡还 ready、事件缺失」的三方分裂；锁竞争由 withTx 整段重试，
                //   事务回滚后 version 未变，「请刷新后重试」提示从此真实有效。
                let lock = null;
                const claimAbort = runTaskTx(db, () => {
                    const claimed = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version });
                    if (!claimed)
                        throw new TxAbort(`#${row.id} 并发认领冲突（版本已漂移 v${row.version}）：任务刚被其他会话领取或改写；请 task_next 刷新后重试。`);
                    lock = randomBytes(12).toString("hex"); // ★ P2-6：租约锁（与 web CAS 锁同形态）
                    appendEvent(db, { memory_id: row.id, op: "task_claim", payload: JSON.stringify({ by: who, as_any: args.as === "any" || undefined, lease_token: lock, version: row.version + 1, session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${AGENT}` }); // ★ #7/#8：session/凭据落审计；★ ⑧：as=any 托管认领强制留痕（改写归属的可审计性）
                    syncTaskToCard(row.id, "running", { assignee: who, actor: `agent:${who}`, action: "claim", detail: `MCP 认领（agent ${who}）` }); // ★ 2026-09-15：认领 → 关联卡片 running + assignee=认领者，看板即时显示「已领取·谁」
                    touchCardLease(row.id, lock, args.lease_minutes); // ★ P2-6：卡片租约锁定（默认 10min，#13 可分级 10..120）
                });
                if (claimAbort)
                    return claimAbort;
                return `已认领任务 #${row.id}（status=in_progress by ${who}）lease_token=${lock}（task_done 时携带）：${newContent.replace(/\s+/g, " ").slice(0, 120)}` + stateReceipt({ op: "task_claim", id: row.id, status: "in_progress", version: row.version + 1, assignee: who, lease_token: lock, cred_id: cred.credId, session_id: args.session_id ?? null });
            }
            // 列可领任务：type='task' 且状态头 pending（★ H4：secret 任务不进工具通道）
            const rows = db.prepare(`SELECT id, content, agent, created_at FROM memories
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'
       ORDER BY created_at DESC LIMIT ?`).all(args.project, 50);
            const open = rows.filter((r) => readTaskState(r.content)?.status === "pending");
            if (!open.length) {
                // ★ 2026-09-15：跨 project 回退提示（与 task_next 同口径）
                let hint = "";
                if (args.project !== "global") {
                    try {
                        const other = db.prepare(`SELECT project, COUNT(*) c FROM memories WHERE type='task' AND status IN ('active','trial') AND project != 'global' AND project != ? AND sensitivity != 'secret' GROUP BY project`).all(args.project);
                        if (other.length)
                            hint = `；其他 project 有开放任务 ${other.map((o) => `${o.project}(${o.c})`).join("、")}，可切换 project 查询`;
                    }
                    catch { /* 统计失败忽略 */ }
                }
                return `当前无可领的 pending 任务${hint}。`;
            }
            return open.map((r) => `#${r.id} [${readTaskState(r.content)?.assignee}] ${r.content.slice(30, 160)}`).join("\n");
        },
    });
    /** ★ 2026-09-15 根治「智能体领取/上传与看板不一致」：任务状态变更 → 关联卡片同步。
     *  反向于 dashboard.syncCardToTask()：MCP 的 task_claim/task_done 改 memories 状态头后，
     *  立即把对应卡片 status 同步（in_progress→running / done→done），消除「MCP 领取但看板仍 ready」的不一致。
     *  ⚠ 投影语义（2026-09-19 与 E-0 对齐时确认）：卡片状态是任务头的**投影**（reconcile.js C-5 同口径——
     *  卡向头对齐），故此处 UPDATE 不走 cards 的 CARD_TRANSITIONS 白名单，属设计内差异而非绕过。 */
    function syncTaskToCard(memoryId, cardStatus, opts = {}) {
        try {
            // ★ 2026-09-19（弊端 U2）：同步本任务的全部 dispatch 卡（多卡时逐一，原 LIMIT 1 会让多余的卡永久失同步）
            const rels = db.prepare(`SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch'`).all(memoryId);
            if (!rels.length)
                return false;
            let synced = 0;
            for (const rel of rels) {
                const cid = Number(rel.card_id);
                const card = db.prepare(`SELECT status, meta FROM cards WHERE id=?`).get(cid);
                if (!card)
                    continue;
                // ★ 2026-09-25 方案A守卫：只收敛开放态卡（triage/todo/ready/running/blocked）；cardStatus='done'
                //   额外允许 review（验收后收口）。failed/cancelled/archived 等终态不覆盖，
                //   原实现无状态守卫（WHERE id=? 盲写）会把验收/租约流转撕坏。
                // ★ 2026-09-25 跨区补全（并发会话在制品）：源卡 running 是「已认领」而非终态 —— 漏列会把
                //   block/流转 的收敛整段跳过（实测 p26-lifecycle E3 卡停在 running）。
                const allowed = cardStatus === "done" ? new Set(["triage", "todo", "ready", "blocked", "running", "review"]) : new Set(["triage", "todo", "ready", "running", "blocked"]);
                if (!allowed.has(card.status))
                    continue;
            // ★ 2026-09-18：opts.assignee 三态 —— undefined=保持原值 / null=清空 / 字符串=设为该值。
            //   task_claim 传认领者 → 卡片即时显示「已领取·谁」；task_release 侧清空走专用 UPDATE（见下）。
            const setAssignee = opts.assignee === undefined ? "" : ", assignee=?";
            const upd = db.prepare(`UPDATE cards SET status=?${setAssignee}, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`);
            if (opts.assignee === undefined)
                upd.run(cardStatus, cid);
            else
                upd.run(cardStatus, opts.assignee, cid);
            if (cardStatus === "done")
                db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL WHERE id=?`).run(cid); // ★ 2026-09-25：done 收口清租约残留（与 web /status 同口径）
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(cid, opts.actor ?? "dispatcher", opts.action ?? "mcp_sync", card.status, cardStatus, opts.detail ?? `任务 #${memoryId} MCP 流转同步`);
                synced++;
            }
            return synced > 0;
        }
        catch (e) {
            // ★ 2026-09-16（A 分区验收）：原为静默 `catch { return false }` —— 状态同步失败会完全隐身，
            //   外观与"卡本来就对"相同（本轮 task_release 同类缺陷曾因此潜伏）。仅加一行日志，语义不变。
            console.error(`[syncTaskToCard] 卡侧同步失败（记忆 #${memoryId} → ${cardStatus}）：${e.message}`);
            return false;
        }
    }
    /** P2-6（C-2/#4198）：任务记忆 → 派发卡片（card_memory dispatch 关系）。无卡返回 null。 */
    function cardOfTask(memoryId) {
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
    /** ★ ③-A（2026-09-24）：任务记忆 → 全部 dispatch 卡（多卡全集合；单卡时与 cardOfTask 同构）。
     *  U2（2026-09-19）已把 syncTaskToCard 修成全集合逐卡，但租约/fencing/门控/清锁链仍走单卡 cardOfTask（LIMIT 1）：
     *  多卡任务的第 2..n 张卡会「running 无租约 / done 留旧锁」——任务 reopen 重派回 ready 后旧 claim_lock
     *  永久卡死 web CAS 领取（WHERE claim_lock IS NULL 恒不满足）。本轮把租约链全部对齐全集合。 */
    function cardsOfTask(memoryId) {
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
    /** P2-6（C-2）：卡片租约触达（认领时发 lease token；heartbeat 续窗）——默认租约统一 10 分钟（C-3/#4199）。
     *  ★ 2026-09-19（实操问题 #13）：支持 minutes 分级（10..120，task_claim/task_heartbeat 可选传参）——
     *  长任务（构建/深度实现）自声明更长租约，避免 10 分钟必超时；默认不变，C-3 口径对存量零影响。 */
    function touchCardLease(memoryId, lock, minutes = 10) {
        let n = 0;
        try {
            const min = Math.max(10, Math.min(120, Math.floor(Number(minutes) || 10)));
            for (const c of cardsOfTask(memoryId)) { // ★ ③-A：全集合 running 卡逐张触达（原单卡 LIMIT 1）
                if (c.status !== "running")
                    continue;
                db.prepare(`UPDATE cards SET claim_lock=?, lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now', ?), heartbeat_at=datetime('now'), lease_notice_at=NULL, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(lock, `+${min} minutes`, c.id); // ★ ⑦：续期即撕贴条；lease 改 T 格式（原 datetime 空格格式与 JS ISO 裸比较「同日恒真」）
                db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c.id, "dispatcher", lock ? "lease_set" : "heartbeat", "running", "running", lock ? `MCP 租约锁定（${min}min，lock=${String(lock).slice(0, 8)}…）` : `MCP 心跳续窗（${min}min）`);
                n++;
            }
        }
        catch (e) {
            console.error(`[lease] 卡片租约触达失败（任务 #${memoryId}）: ${e instanceof Error ? e.message : String(e)}`);
        }
        return n > 0;
    }
    /**
     * ★ P2-6（C-2 / #4198）：补齐 task 生命周期工具（MACP v3.0）。
     *  过期写/僵尸写自此可被技术拦截（fencing）：lease token（卡片 claim_lock）+ 乐观版本（memories.version）。
     *  全部 best-effort 记 card_events / appendEvent，不阻断主流程。
     */
    server.addTool({
        name: "task_heartbeat",
        description: "多 Agent 协同·租约（C-2）：对进行中任务的关联卡片刷新租约窗口（默认 10 分钟，C-3；lease_minutes 可分级 10..120），防止长跑任务被守护回收。调用方应为当前认领者（身份可传 as，仅限本人任务）。无关联卡片（纯任务）时仅记事件。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("任务记忆 id"),
            as: z.string().optional().describe("以谁的身份续租（缺省=当前 agent）；须与任务认领者一致"),
            lease_minutes: z.number().int().min(10).max(120).optional().describe("续租分钟数（10..120，默认 10）；与 task_claim 的租约分级同口径"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            const row = readMemory(db, args.memory_id);
            if (!row || row.type !== "task")
                return `#${args.memory_id} 不存在或非任务。`;
            const aliveErr = assertTaskAlive(row); // ★ 列守卫（2026-09-19：按 id 分支统一 fail-closed）
            if (aliveErr)
                return aliveErr;
            const st = readTaskState(row.content);
            if (!st || st.status !== "in_progress")
                return `#${args.memory_id} 当前非进行中，无需续租。`;
            const who = args.as && args.as !== "any" ? args.as : AGENT;
            if (st.assignee !== "?" && st.assignee !== who)
                return `#${args.memory_id} 认领者为 ${st.assignee}，${who} 无权续租。`;
            const card = cardOfTask(row.id);
            if (!card) {
                appendEvent(db, { memory_id: row.id, op: "task_heartbeat", payload: JSON.stringify({ by: who, cards: [] }), operator: `agent:${AGENT}` });
                return `任务 #${row.id} 续租成功（无关联卡片，纯任务，仅记事件）。`;
            }
            const hMin = Math.max(10, Math.min(120, Math.floor(Number(args.lease_minutes) || 10)));
            const hRunning = cardsOfTask(row.id).filter((cc) => cc.status === "running"); // ★ ③-A：全集合 running 卡
            if (hRunning.length) {
                // ★ 一致性①：续租 + 事件一笔事务（两步写不再可能半途分裂）
                runTaskTx(db, () => {
                    touchCardLease(row.id, null, args.lease_minutes); // ★ #13：分级续窗（全集合 running 卡逐张）
                    appendEvent(db, { memory_id: row.id, op: "task_heartbeat", payload: JSON.stringify({ by: who, cards: hRunning.map((cc) => cc.id), window_min: hMin }), operator: `agent:${AGENT}` });
                });
                return `任务 #${row.id} 续租成功（全集合 ${hRunning.length} 张 running 卡，租约窗口 → ${hMin} 分钟）。`;
            }
            const hFirst = card;
            return `任务 #${row.id} 续租未生效：卡片 #${hFirst.id} 当前 status=${hFirst.status}${hFirst.claim_lock ? "（他方持有租约）" : ""}。`;
        },
    });
    server.addTool({
        name: "task_release",
        description: "多 Agent 协同·租约（C-2）：释放认领 —— 任务状态头 in_progress → pending（重新可被认领），关联卡片 running → ready 并清租约锁。仅当前认领者（或 human 兜底）可释放。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("任务记忆 id"),
            reason: z.string().optional().describe("释放原因（留痕 card_events/事件流）"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属当前 agent）；软模式下可省略，MEMORYOS_A1_ENFORCE=1 时必填"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            const row = readMemory(db, args.memory_id);
            if (!row || row.type !== "task")
                return `#${args.memory_id} 不存在或非任务。`;
            const aliveErr = assertTaskAlive(row); // ★ 列守卫（2026-09-19：按 id 分支统一 fail-closed）
            if (aliveErr)
                return aliveErr;
            const cred = checkWriteCredential(AGENT, args.credential); // ★ A1/#8
            if (!cred.ok)
                return cred.msg;
            const st = readTaskState(row.content);
            if (!st || st.status !== "in_progress")
                return `#${args.memory_id} 当前 status=${st?.status}，仅进行中任务可释放。`;
            // ★ 一致性①（2026-09-19）：头 CAS + 事件 + 卡释放包成一笔事务 —— 此前卡侧失败会出现
            // 「记忆头已释放、卡仍 running 持锁」的半笔账（1349-1356 注释实录的占位符事故即此类）；
            //  现卡侧仍 best-effort catch，但崩溃/锁失败窗口整体回滚，头与卡不再各走各的。
            let newContent = null;
            const relAbort = runTaskTx(db, () => {
                newContent = taskBodyWithDep("pending", st.assignee, st.deps, taskBody(row.content));
                const released = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version }); // ★ CAS
                if (!released)
                    throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
                appendEvent(db, { memory_id: row.id, op: "task_release", payload: JSON.stringify({ by: AGENT, reason: (args.reason ?? "").trim() || null, session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${AGENT}` }); // ★ #7/#8
                try {
                    for (const c2 of cardsOfTask(row.id)) { // ★ ③-A：全集合释放（多卡任务的第 2..n 张一并回 ready 清锁，不留旧锁残留）
                        if (c2.status !== "running")
                            continue;
                        // ★ 2026-09-16 修正：此处原为 `.run(st.assignee, c2.id)` 而 SQL 只有 1 个占位符（WHERE id=?）。
                        //   实测 node:sqlite 在「实参多于占位符」时抛 `column index out of range`；该异常被下方
                        //   `catch {}` **静默吞掉** ⇒ 本条 UPDATE 与紧随其后的 card_events INSERT **都没执行**——
                        //   现象＝"记忆头已释放，但卡片仍 running + 持锁、且无任何事件留痕"，只能等 C-5 对账兜底。
                        //   教训：① SQL 占位符数与 .run 实参数必须逐一核对；② 静默 catch 会把这类错误藏起来（改为仅记日志）。
                        const rel = db.prepare(`UPDATE cards SET status='ready', assignee=NULL, claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(c2.id);
                        if (Number(rel.changes) === 0) console.error(`[task_release] ⚠ 卡片 #${c2.id} 未更新（changes=0），三方可能不一致`);
                        db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c2.id, `agent:${AGENT}`, "mcp_release", "running", "ready", `任务 #${row.id} 释放（${(args.reason ?? "").trim() || "未注明"}）`);
                    }
                }
                catch (e) { console.error(`[task_release] 卡片侧更新失败（记忆侧已释放）：${e.message}`); }
            });
            if (relAbort)
                return relAbort;
            return `任务 #${row.id} 已释放（status=pending，重新可领）：${newContent.replace(/\s+/g, " ").slice(0, 100)}` + stateReceipt({ op: "task_release", id: row.id, status: "pending", version: row.version + 1, cred_id: cred.credId });
        },
    });server.addTool({
        name: "task_block",
        description: "多 Agent 协同·租约（C-2）：把任务标记为受阻（状态头 → blocked，原因留痕）；关联卡片同步 blocked。受阻任务不进可做集；恢复走 task_reopen 或重新认领。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("任务记忆 id"),
            reason: z.string().describe("受阻原因（必填，留痕）"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属当前 agent）；软模式下可省略，MEMORYOS_A1_ENFORCE=1 时必填"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            const row = readMemory(db, args.memory_id);
            if (!row || row.type !== "task")
                return `#${args.memory_id} 不存在或非任务。`;
            const aliveErr = assertTaskAlive(row); // ★ 列守卫（2026-09-19：按 id 分支统一 fail-closed）
            if (aliveErr)
                return aliveErr;
            const cred = checkWriteCredential(AGENT, args.credential); // ★ A1/#8
            if (!cred.ok)
                return cred.msg;
            const st = readTaskState(row.content);
            if (!st)
                return `#${args.memory_id} 任务头格式异常，无法标记受阻。`;
            const tErr = assertTransition(st.status, "blocked");
            if (tErr)
                return `#${args.memory_id} ${tErr}`;
            // ★ 一致性①（2026-09-19）：头 CAS + 事件 + 卡投影一笔事务
            const blkAbort = runTaskTx(db, () => {
                const body = `${taskBody(row.content)}\n⛔ 受阻(${AGENT})：${sanitizeTaskText(args.reason).trim()}`;
                const blocked = updateMemory(db, row.id, { content: taskBodyWithDep("blocked", st.assignee, st.deps, body), expectedVersion: row.version }); // ★ CAS
                if (!blocked)
                    throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
                appendEvent(db, { memory_id: row.id, op: "task_block", payload: JSON.stringify({ by: AGENT, reason: args.reason.trim(), session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${AGENT}` }); // ★ #7/#8
                syncTaskToCard(row.id, "blocked", { actor: `agent:${AGENT}`, detail: `任务 #${row.id} MCP 标记受阻` });
            });
            if (blkAbort)
                return blkAbort;
            return `任务 #${row.id} 已标记受阻（status=blocked）：${args.reason.trim().slice(0, 100)}` + stateReceipt({ op: "task_block", id: row.id, status: "blocked", version: row.version + 1, cred_id: cred.credId });
        },
    });server.addTool({
        name: "task_reopen",
        description: "多 Agent 协同·租约（C-2）：重开已终态任务（done/failed/cancelled → in_progress，重新指派）；关联卡片 done → ready。E-0 裁决口径：reopened 为派生态（展示层），持久态落回白名单。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("任务记忆 id"),
            assignee: z.string().optional().describe("重开后指派给谁（缺省=原认领者）"),
            reason: z.string().describe("重开原因（必填，留痕）"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属当前 agent）；软模式下可省略，MEMORYOS_A1_ENFORCE=1 时必填"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            const row = readMemory(db, args.memory_id);
            if (!row || row.type !== "task")
                return `#${args.memory_id} 不存在或非任务。`;
            if (row.status === "merged")
                return `#${args.memory_id} 已被 #${row.superseded_by ?? "?"} 取代（merged），不可重开；如需该工作请操作取代它的主任务。`;
            const cred = checkWriteCredential(AGENT, args.credential); // ★ A1/#8
            if (!cred.ok)
                return cred.msg;
            const st = readTaskState(row.content);
            if (!st)
                return `#${args.memory_id} 任务头格式异常，无法重开。`;
            if (!["done", "cancelled"].includes(st.status)) // E-0：failed 已取消（存量归一 in_progress），merged 已在上方单独拒绝
                return `#${args.memory_id} 当前 status=${st.status}，仅终态（done/cancelled）可重开。`;
            // ★ 一致性①（2026-09-19）：列复活 + 头 CAS + 事件 + 卡重开一笔事务 —— 附带修复一个潜伏缺陷：
            //   原先「列 archived→active」写在 CAS 之前，CAS 冲突时会留下「列已复活、头没重开」的错位；
            //   现列复活与头写入同事务，CAS 中止即整体回滚，不再错位。
            const who = args.assignee || st.assignee || "?";
            const whoErr = assertAssignee(who); // ★ #6：重开指派身份过白名单
            if (whoErr)
                return whoErr;
            const ropenAbort = runTaskTx(db, () => {
                if (row.status === "archived") // ★ 2026-09-19：重开即复活 —— 列 archived → active，否则重开后头/列错位、任务依旧不可见
                    db.prepare(`UPDATE memories SET status='active' WHERE id=?`).run(row.id);
                const body = `${taskBody(row.content)}\n↻ 重开(${AGENT})：${sanitizeTaskText(args.reason).trim()}`;
                const reopened = updateMemory(db, row.id, { content: taskBodyWithDep("in_progress", who, st.deps, body), expectedVersion: row.version }); // ★ CAS
                if (!reopened)
                    throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
                appendEvent(db, { memory_id: row.id, op: "task_reopen", payload: JSON.stringify({ by: AGENT, from: st.status, to: who, reason: args.reason.trim(), session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${AGENT}` }); // ★ #7/#8
                try {
                    for (const c2 of cardsOfTask(row.id)) { // ★ ③-A：全集合重开（多卡任务的第 2..n 张一并回 ready，不留旧锁）
                        if (!["done", "archived", "cancelled"].includes(c2.status))
                            continue;
                        db.prepare(`UPDATE cards SET status='ready', claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL, assignee=?, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(who === "?" ? null : who, c2.id);
                        db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(c2.id, `agent:${AGENT}`, "mcp_reopen", c2.status, "ready", `任务 #${row.id} 重开（${args.reason.trim().slice(0, 80)}）`);
                    }
                }
                catch (e) { console.error(`[task_reopen] 卡片侧更新失败（记忆侧已重开）：${e.message}`); }
            });
            if (ropenAbort)
                return ropenAbort;
            return `任务 #${row.id} 已重开（${st.status} → in_progress，指派 ${who}）：${args.reason.trim().slice(0, 100)}` + stateReceipt({ op: "task_reopen", id: row.id, status: "in_progress", version: row.version + 1, assignee: who });
        },
    });
    server.addTool({
        name: "task_done",
        description: "多 Agent 协同：把已认领/待办任务标记为完成（状态头 → done），并把结论追加进任务正文。调用方应为当前认领者或任务接收方。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("要完成的记忆 id"),
            conclusion: z.string().describe("完成结论/结果摘要（追加进任务正文）"),
            // ★ P2-6（C-2）fencing 入参：校验代码（见下方 execute 内 1065-1068 区段）先前已存在，但参数表里
            //   **未声明**这两个字段 ⇒ 值恒为 undefined、校验恒被跳过（死代码）；且曾被误插到 memory_read
            //   造成整个 MCP 服务端起不来（SyntaxError: Unexpected identifier 'expected_version'）。
            //   2026-09-16 修正：在此声明一次，使拒绝逻辑真正生效。**勿再重复插入（曾出现同字段重复声明）。**
            lease_token: z.string().optional().describe("P2-6 fencing：task_claim 返回的租约锁；与卡片当前锁不符 → 拒绝过期完成写"),
            expected_version: z.number().int().optional().describe("P2-6 fencing：任务记忆乐观版本；不一致 → 拒绝陈旧完成写"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属当前 agent）；软模式下可省略，MEMORYOS_A1_ENFORCE=1 时必填"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            const row = readMemory(db, args.memory_id);
            if (!row || row.type !== "task")
                return `#${args.memory_id} 不存在或非任务。`;
            const aliveErr = assertTaskAlive(row); // ★ 列守卫：archived/merged 不可完成（2026-09-18 P0 修复）
            if (aliveErr)
                return aliveErr;
            const cred = checkWriteCredential(AGENT, args.credential); // ★ A1/#8：归属校验 + scope>=write
            if (!cred.ok)
                return cred.msg;
            const st = readTaskState(row.content);
            if (!st)
                return `#${args.memory_id} 任务头格式异常，无法完成。`;
            if (st.status === "done")
                return `#${args.memory_id} 已完成，无需重复标记。`;
            // v1.1 状态机：仅 in_progress / review → done 合法
            // ★ 2026-09-19（弊端 H1）：归属守卫——仅认领者本人（或未认领任务）可完成；
            //   第三方验收关闭走 task_verify（verified_by 留痕），接手工作走 task_reopen 重派。
            if (st.assignee !== "?" && st.assignee !== AGENT)
                return `#${row.id} 由 ${st.assignee} 认领，你（${AGENT}）不是认领者，不能代为完成：第三方验收请走 task_verify（带依据），需接手请 task_reopen 重派后再完成。`;
            const tErr = assertTransition(st.status, "done");
            if (tErr)
                return `#${args.memory_id} ${tErr}`;
            // ★ P2-6（C-2）fencing：拒绝过期完成写（lease 被接管 / 版本漂移）
            // ★ ③-A：锁检查改全集合（单卡兼容旧逻辑：存在锁且任一张锁不符才拒）
            const doneLocks = cardsOfTask(row.id).filter((cc) => cc.claim_lock);
            const doneMismatch = doneLocks.find((cc) => cc.claim_lock !== args.lease_token);
            if (args.lease_token && doneLocks.length && doneMismatch)
                return `#${args.memory_id} 租约已被接管（卡片 #${doneMismatch.id} 现锁 ${String(doneMismatch.claim_lock).slice(0, 8)}…），本次完成拒绝（fencing）；请重新 task_next。`;
            if (args.expected_version != null && args.expected_version !== row.version)
                return `#${args.memory_id} 版本漂移（期望 v${args.expected_version}，当前 v${row.version}）：完成请求拒绝；请刷新后重试。`;
            // ★ ②-A：A1 硬模式下 fencing 版本必填 —— 防僵尸会话陈旧完成写（软模式保持兼容）
            if (process.env.MEMORYOS_A1_ENFORCE === "1" && args.expected_version == null)
                return `#${args.memory_id} A1 硬模式（MEMORYOS_A1_ENFORCE=1）：task_done 必须携带 expected_version（fencing：task_next / task_read 回执中的 version）；请刷新任务后重试。`;
            const body = taskBody(row.content);
            // ★ P3 确定性门控：任务头声明 [gate:预设] 时，先跑验收——不信任 Agent 自报结论。
            //   门控通过 → 标记 done；门控失败/未命中预设 → fail-closed，状态置 pending（可重新 task_claim 重试），
            //   并把门控判定落审计（exec_audit + task_gate 事件）；卡片不回退（保持原状态），修复后 done 再同步。
            const gateName = taskGateName(row.content);
            let gateRes = null;
            if (gateName) {
                gateRes = await runTaskGate(db, gateName, row.id); // ★ 2026-09-25 P0①：runTaskGate 已改异步，必须 await
                appendEvent(db, { memory_id: row.id, op: "task_gate", payload: JSON.stringify({ gate: gateName, ...gateRes, fallback: "pending" }), operator: `agent:${AGENT}` });
            }
            if (gateRes && !gateRes.ok) {
                // fail-closed：验收未通过 → 不标 done，回退 pending 留痕。
                // ★ 2026-09-19（实操复盘查漏）：卡侧同步 ready + 清租约（assignee 保留=修复者）——
                //   原实现卡片停在 running 持锁，与记忆头 pending 打架，5 分钟后还会被 reconcile 强行对齐。
                // ★ 一致性①（2026-09-19）：回退 CAS + 卡同步 + 清锁一笔事务。
                const gAbort = runTaskTx(db, () => {
                    const pendingContent = `${taskBodyWithDep("pending", st.assignee, st.deps, body)}\n→ 结论(${AGENT})：${sanitizeTaskText(args.conclusion).trim()}\n⛔ 门控 gate='${gateName}' 未通过（${String(gateRes.detail).slice(0, 160)}）——状态回退 pending，修复后 task_claim + task_done 重试。`;
                    const rolled = updateMemory(db, row.id, { content: pendingContent, expectedVersion: row.version });
                    if (!rolled)
                        throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：请刷新后重试。`);
                    syncTaskToCard(row.id, "ready", { actor: `agent:${AGENT}`, action: "gate_fallback", detail: `任务 #${row.id} 门控未通过回退 pending` });
                    for (const cc of cardsOfTask(row.id)) // ★ ③-A：全集合清锁（含多卡第 2..n 张）
                        db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL WHERE id=?`).run(cc.id);
                });
                if (gAbort)
                    return gAbort;
                return `任务 #${row.id} 门控未通过（gate='${gateName}'：${String(gateRes.detail).slice(0, 120)}）——status=pending（fail-closed，未标 done）。请修复后 task_claim 再 task_done。` + stateReceipt({ op: "task_done_gate_fallback", id: row.id, status: "pending", version: row.version + 1, gate: gateName });
            }
            const gateNote = gateRes && gateRes.ok ? ` 门控 gate='${gateName}' PASS` : "";
            // ★ 2026-09-19（弊端 H3）：M2 验收双轨对齐——卡带 meta.acceptance 且未跑 [gate:] 门控时不放过 done
            //   （web 侧 /status 已按 #7 修复口径拦截；MCP 路径同口径，消除 task_done 绕行通道）。
            if (!gateRes) {
                // ★ ③-A：任一 dispatch 卡带验收标准即拦（原单卡 LIMIT 1：门控写在第 2 张卡上会绕过）
                let accHit = null;
                for (const cc of cardsOfTask(row.id)) {
                    let m = null;
                    try { m = cc.meta ? JSON.parse(String(cc.meta)) : null; }
                    catch { m = null; }
                    if (m && m.acceptance != null && !(Array.isArray(m.acceptance) && m.acceptance.length === 0)) {
                        accHit = cc;
                        break;
                    }
                }
                if (accHit)
                    return `任务 #${row.id} 的卡（卡片 #${accHit.id}）带验收标准（meta.acceptance），但未执行 [gate:<预设>] 门控——task_done 不允许未经确定性验收即关闭（与 web 侧同口径）。请先在任务头声明 gate，或由人工移除卡的验收标准后重试。`;
            }
            // ★ 一致性①（2026-09-19）：done CAS + 置信强化 + 事件 + 卡同步 + 清租约包成一笔事务 ——
            //   中途崩溃不再出现「头已 done、卡还 running 持锁」的半笔账；慢的门控子进程验收已在锁外跑完。
            const doneAbort = runTaskTx(db, () => {
                const newContent = `${taskBodyWithDep("done", st.assignee, st.deps, body)}\n→ 结论(${AGENT})：${sanitizeTaskText(args.conclusion).trim()}${gateNote}`;
                const doneWrite = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version }); // ★ CAS：并发 done 只有一个生效
                if (!doneWrite)
                    throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请 task_next 刷新后重试。`);
                // ★ ④-A：无确定性门控/验收标准的关闭=「自述完成」——事件打 self_verified 标记（验收可据此降权），
                //   置信强化只给低档 0.02；经 [gate:] 门控通过的关闭保持 0.05 全强度。
                const selfVerified = !gateRes;
                bumpConfidence(db, row.id, selfVerified ? 0.02 : 0.05); // 完成任务强化（确定性验收全强度 / 自述低强度）
                appendEvent(db, { memory_id: row.id, op: "task_done", payload: JSON.stringify({ by: AGENT, session_id: args.session_id ?? null, cred_id: cred.credId, self_verified: selfVerified || undefined }), operator: `agent:${AGENT}` }); // ★ #7/#8：session/凭据落审计；④：自述标记
                syncTaskToCard(row.id, "done", { actor: `agent:${AGENT}`, detail: `任务 #${row.id} MCP 完成` }); // ★ 2026-09-15：完成 → 关联卡片 done（assignee 保留=完成者），看板即时同步
                for (const cc of cardsOfTask(row.id)) // ★ ③-A：全集合清锁（原单卡 cardNowDone，多卡第 2..n 张会留旧锁）；P2-6：完成即释放租约锁；⑦：顺带撕贴条
                    db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL WHERE id=?`).run(cc.id);
            });
            if (doneAbort)
                return doneAbort;
            return `任务 #${row.id} 已完成（status=done）[${row.type}|${row.agent}] 结论：${args.conclusion.trim().slice(0, 100)}` + stateReceipt({ op: "task_done", id: row.id, status: "done", version: row.version + 1, cred_id: cred.credId, session_id: args.session_id ?? null });
        },
    });
    server.addTool({
        name: "task_verify",
        description: "多 Agent 协同·第三方验收关闭：任务实际已完成但任务头未闭环时，验收方直接把状态头置 done——不改 assignee（归属保留）、不发租约、不写 claim 事件，只写 task_verify 事件（verified_by 留痕），消除「为收口伪造 task_claim」的审计污染。不走 [gate] 门控，验收依据在 reason 留痕。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("要验收关闭的任务记忆 id"),
            reason: z.string().describe("验收依据（必填，留痕）：对应提交/冒烟结果/证据位置"),
            as: z.string().optional().describe("验收方身份（缺省=当前 agent）"),
            expected_version: z.number().int().optional().describe("P2-6 fencing：乐观版本；不一致 → 拒绝陈旧验收写"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属验收方）；软模式下可省略，MEMORYOS_A1_ENFORCE=1 时必填"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            const row = readMemory(db, args.memory_id);
            if (!row || row.type !== "task")
                return `#${args.memory_id} 不存在或非任务。`;
            const aliveErr = assertTaskAlive(row); // ★ 列守卫：archived/merged 不可验收（2026-09-19）
            if (aliveErr)
                return aliveErr;
            const verifier = args.as && args.as !== "any" ? args.as : AGENT;
            const cred = checkWriteCredential(verifier, args.credential); // ★ A1/#8：归属校验 + scope>=write
            if (!cred.ok)
                return cred.msg;
            const st = readTaskState(row.content);
            if (!st)
                return `#${args.memory_id} 任务头格式异常，无法验收。`;
            if (st.status === "done")
                return `#${args.memory_id} 已是 done，无需验收。`;
            if (!["pending", "in_progress"].includes(st.status))
                return `#${args.memory_id} 当前 status=${st.status}，仅 pending/in_progress 可验收关闭（review 走 task_done，终态走 task_reopen）。`;
            if (args.expected_version != null && args.expected_version !== row.version)
                return `#${args.memory_id} 版本漂移（期望 v${args.expected_version}，当前 v${row.version}）：验收写拒绝；请刷新后重试。`;
            // ★ ②-A：A1 硬模式下 fencing 版本必填 —— 第三方验收写最开放，无版本防护时僵尸会话可陈旧收口
            if (process.env.MEMORYOS_A1_ENFORCE === "1" && args.expected_version == null)
                return `#${args.memory_id} A1 硬模式（MEMORYOS_A1_ENFORCE=1）：task_verify 必须携带 expected_version（fencing：task_next / task_read 回执中的 version）；请刷新任务后重试。`;
            // ★ 一致性①（2026-09-19）：头 CAS + 事件 + 卡同步 + 清租约一笔事务
            const vfAbort = runTaskTx(db, () => {
                // 不改 assignee（归属保留原文）、不发租约、不动 claim_lock 语义 —— 只闭环状态头 + 留痕
                const newContent = `${taskBodyWithDep("done", st.assignee, st.deps, taskBody(row.content))}\n→ 验收(${verifier})：${args.reason.trim()}`;
                const verified = updateMemory(db, row.id, { content: newContent, expectedVersion: row.version }); // ★ CAS
                if (!verified)
                    throw new TxAbort(`#${row.id} 并发写冲突（版本已漂移 v${row.version}）：任务已被其他会话改写；请刷新后重试。`);
                appendEvent(db, { memory_id: row.id, op: "task_verify", payload: JSON.stringify({ verified_by: verifier, from: st.status, reason: args.reason.trim(), session_id: args.session_id ?? null, cred_id: cred.credId }), operator: `agent:${AGENT}` }); // ★ #7/#8：session/凭据落审计
                syncTaskToCard(row.id, "done", { actor: `agent:${verifier}`, action: "verify", detail: `任务 #${row.id} 第三方验收关闭（${verifier}）` });
                for (const cc of cardsOfTask(row.id)) // ★ ③-A：全集合清锁（若曾认领），与 task_done 收口口径一致；⑦：顺带撕贴条
                    db.prepare(`UPDATE cards SET claim_lock=NULL, lease_expires_at=NULL, lease_notice_at=NULL WHERE id=?`).run(cc.id);
            });
            if (vfAbort)
                return vfAbort;
            return `任务 #${row.id} 已验收关闭（status=done，verified_by=${verifier}，未改归属/未发租约）：${args.reason.trim().slice(0, 100)}` + stateReceipt({ op: "task_verify", id: row.id, status: "done", version: row.version + 1, verified_by: verifier, cred_id: cred.credId, session_id: args.session_id ?? null });
        },
    });
    server.addTool({
        name: "task_supersede",
        description: "多 Agent 协同·去重归档：把一条重复任务标记为「被另一条取代」——状态置 merged + superseded_by=主任务 id。用于跨链路重复（如 dispatcher 卡片派生 与 task_assign 直写 双套）；被并的任务移出可做集、不污染正文、可经 superseded_by 追溯主任务。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("要归档的重复任务记忆 id（loser）"),
            superseded_by: z.number().int().min(1).describe("保留的主任务记忆 id（winner）"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
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
            // ★ 一致性①（2026-09-19）：merged 归档 + 事件 + 用量记账一笔事务
            const spAbort = runTaskTx(db, () => {
                markMerged(db, args.memory_id, args.superseded_by); // merged + superseded_by；移出检索候选
                appendEvent(db, {
                    memory_id: args.memory_id,
                    op: "task_supersede",
                    payload: JSON.stringify({ superseded_by: args.superseded_by, by: AGENT }),
                    operator: `agent:${AGENT}`,
                });
                logUsage(db, {
                    memory_id: args.memory_id, event: "supersede", reader_agent: AGENT, writer_agent: AGENT,
                    project: row.project, session_id: args.session_id, task_hint: args.task_hint,
                });
            });
            if (spAbort)
                return spAbort;
            return `任务 #${args.memory_id} 已标记被 #${args.superseded_by} 取代（merged ⇒ 移出可做集，可经 superseded_by 追溯）`;
        },
    });
    server.addTool({
        name: "task_next",
        description: "多 Agent 协同·依赖拓扑：给当前 agent 算出『现在可做的开放任务』（依赖拓扑的入度=0 集）。open 且所有 depends_on 依赖均已 done 的任务才可做；被依赖未完成的任务标记 blocked 并说明卡在哪个依赖。同时列出本人名下已认领/在做的任务。",
        parameters: z.object({
            project: z.string().default("global").describe("任务 scope"),
            as: z.string().optional().describe("以谁的身份查（缺省=当前 agent）；传 '' 或 'any' 查全部可做集"),
            domain: z.boolean().default(false).describe("只返回依赖链中当前可做链路的路径提示（A→B→C）"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            const rows = db.prepare(`SELECT id, content, agent, source_ref, created_at FROM memories
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'
       ORDER BY julianday(created_at) DESC, id DESC LIMIT 500`).all(args.project);
            // ★ 2026-09-19（弊端 M5）：按创建时间降序（新任务优先）+ 超上限显式提示——原升序在积压超 500 条时把新任务埋没
            const totalOpen = db.prepare(`SELECT COUNT(*) n FROM memories
       WHERE type='task' AND status IN ('active','trial') AND project IN (?, 'global') AND sensitivity != 'secret'`).get(args.project).n;
            // 全体任务状态/依赖解码 + done 集合
            const states = new Map();
            for (const r of rows) {
                const st = readTaskState(r.content);
                if (!st)
                    continue;
                states.set(r.id, { st });
            }
            // ★ 2026-09-19（实操复盘查漏）：依赖判定不能只看 active/trial 行 —— 实测 31 条「头 done 但列已归档」
            //   的任务不在上面查询结果里，依赖它们的 pending 任务被永久误判阻塞（生产库实证 6 条假阻塞）。
            //   done 判据改为「头文本 done，不看列」；列 merged 的行不播种（由 winner 状态裁决），
            //   依赖指向 merged 的沿 superseded_by 传递解析到 winner（带环保护）。
            const allTasks = db.prepare(`SELECT id, content, status, superseded_by FROM memories WHERE type='task' AND sensitivity != 'secret'`).all();
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
            const who = !args.as || args.as === "any" ? AGENT : args.as;
            // ★ 2026-09-19（实操问题 #7）：同 agent 多会话隔离 —— 取最近 task_claim 事件的 session_id，
            //   与调用方 session_id 比对：非本会话 → 单列「同名其他会话」，消除「我在做」串台。
            const claimSessionOf = (mid) => {
                try {
                    const ev = db.prepare(`SELECT payload FROM memory_events WHERE memory_id=? AND op='task_claim' ORDER BY id DESC LIMIT 1`).get(mid);
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
                    const r = db.prepare(`SELECT julianday('now') - MAX(julianday(created_at)) AS d FROM memory_events WHERE memory_id=?`).get(mid);
                    if (!r || r.d == null)
                        return "";
                    return r.d >= 1 ? ` · 最后活动 ${Math.floor(r.d)} 天前` : ` · 最后活动 ${Math.max(1, Math.round(r.d * 24))} 小时前`;
                }
                catch { return ""; }
            };
            const avail = [];
            const blocked = [];
            const mine = [];
            // ★ A 2026-09-14：区分卡任务 vs 手动任务；B：优先取卡片 priority 排序
            const isCardTask = (r) => String(r.source_ref ?? "").startsWith("card:");
            const cardOf = (r) => {
                const m = String(r.source_ref ?? "").match(/^card:(\d+)$/);
                return m ? Number(m[1]) : null;
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
                    if (!args.as || args.as === "any" || s.assignee === who || s.assignee === "?") {
                        if (depDone)
                            avail.push({ prio: prioOf(r), key: tsOf(r), label: `#${r.id} ${srcTag(r)} → ${s.assignee}: ${taskBody(r.content).slice(0, 80)} ${isCardTask(r) ? "(卡)" : ""}` });
                        else
                            blocked.push({ prio: prioOf(r), key: tsOf(r), label: `#${r.id} ${srcTag(r)} 阻塞（等 ${depLabel}）→ ${taskBody(r.content).slice(0, 60)}${lastEvtOf(r.id)}${blockedBy.some(depDeadOf) ? "（†=依赖已终态/不存在：需重挂依赖才能解锁）" : ""}` });
                    }
                }
                else if (s.status === "in_progress" && s.assignee === who) {
                    const label = `#${r.id} ${srcTag(r)} 进行中(已认领 by ${s.assignee}): ${taskBody(r.content).slice(0, 80)}`;
                    const sid = claimSessionOf(r.id);
                    const isThisSession = !args.session_id || !sid || sid === args.session_id;
                    const leaseTag = leaseTagOf(r.id); // ★ #12：租约剩余一目了然
                    (isThisSession ? mine : mineOther).push(isThisSession ? label + leaseTag : `${label}${leaseTag}（会话 ${sid}）`);
                }
            }
            // ★ B 排序：卡片 priority 高优先，同优先级按创建时间旧的在前
            const sortLane = (a, b) => b.prio - a.prio || a.key - b.key;
            avail.sort(sortLane);
            blocked.sort(sortLane);
            let out = `【task_next · as=${who}】\n`;
            out += `可做（pending 且依赖done，按优先级）:\n${avail.length ? avail.map((x) => x.label).join("\n") : "（暂无，检查阻塞项）"}\n\n`;
            out += `阻塞（依赖未完成）:\n${blocked.length ? blocked.map((x) => x.label).join("\n") : "（无）"}\n\n`;
            out += `我在做:\n${mine.length ? mine.join("\n") : "（无进行中任务）"}`;
            if (mineOther.length)
                out += `\n\n同名其他会话进行中（非本会话，勿动）:\n${mineOther.join("\n")}`;
            // ★ 2026-09-15：跨 project 回退提示 —— 指定 project 无开放任务且确实存在其他 project 的任务时，
            // 明确提示而非静默空结果（避免『任务存在但领不到』）。
            if (avail.length === 0 && args.project !== "global") {
                try {
                    const other = db.prepare(`SELECT project, COUNT(*) c FROM memories WHERE type='task' AND status IN ('active','trial') AND project != 'global' AND project != ? AND sensitivity != 'secret' GROUP BY project`).all(args.project);
                    if (other.length) {
                        out += `\n\n跨 project 提示：当前 project='${args.project}' 无可用任务。其他 project 有开放任务 ${other.map((o) => `${o.project}(${o.c})`).join("、")}，可用 project 参数切换查询。`;
                    }
                }
                catch {
                    /* 统计失败不回退原返回 */
                }
            }
            // ★ 2026-09-19（弊端 M5）：超上限显式提示——任务数超过 500 条窗口时旧部分不显示
            if (totalOpen > rows.length)
                out += "\n（上限提示：共 " + totalOpen + " 条任务，仅显示最近 " + rows.length + " 条）";
            return out;
        },
    });
}

