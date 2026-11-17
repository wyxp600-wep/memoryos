/**
 * P2-④（2026-09-22，A 分区接管 B 分区）：server.js MCP 工具面按域拆分 —— 任务域（数量以 `--list-tools` 为准）。
 *
 * ★ Step 0（2026-10-18，架构收敛）：本文件已收敛为**纯传输层** ——
 *   领域逻辑（任务头解析 / 状态机 / CAS 认领 / 门控 / dispatch 语义 / 卡片投影 / 回执文案）
 *   全部逐字搬至 task-domain.js（导出 `*TaskDomain` 执行体与共享 helper），本文件只保留：
 *     ① zod 入参声明（工具面契约，冒烟 smoke-mcp 逐字节断言）；
 *     ② D1 幂等包装（request_id 重放，addTool 单点覆写）；
 *     ③ 薄适配：execute → 领域函数（ctx 注入调用时身份/取消信号/杀树）。
 *   收益：探针/其他传输可直接 import 领域函数调用真实代码（此前窝在闭包里只能复述行号）。
 *   硬口径：`node dist/server.js --list-tools` 逐字节不变 + smoke-mcp / smoke-p26 / smoke-macp 全绿。
 * 共享顶层名经 ctx 注入：db / isCredentialValid / nowIso；身份访问器（agentName 等）从 server-tools.js import。
 * 门禁：npm test（smoke-task / smoke-p26-lifecycle / smoke-macp）+ npm run lint 全绿。
 */
import { z } from "zod";
import { readRequestReceipt, saveRequestReceipt, parseRecordRef } from "./db.js"; // ★ D1：写类 task_* 请求幂等（request_id 回执）+ 编号引用解析
import { agentName, agentFpath, envCredential, requestAbortSignal } from "./server-tools.js"; // ★ 1b：调用方身份访问器 + 请求取消信号
import { killTree } from "./exec-tools.js"; // ★ 1b：验收子进程被取消时复用同一套「杀进程树」实现（不留孤儿）
import { invokeOp } from "./ops-registry.js"; // ★ 批次 B：task_next 领域计算经注册表派发
import {
    gateToolDomain, assignTaskDomain, delegateTaskDomain, claimTaskDomain, heartbeatTaskDomain,
    releaseTaskDomain, blockTaskDomain, reopenTaskDomain, doneTaskDomain, verifyTaskDomain, supersedeTaskDomain,
    settleTaskDomain, taskSettleOn,
    readTaskState, taskBody,
} from "./task-domain.js"; // ★ Step 0：领域核心（执行体 + 供 task.next ctx 注入的解析 helper）
import { renderTaskNextText } from "./task-domain.js";

export function registerTaskTools(server, ctx) {
    const { db, isCredentialValid, nowIso } = ctx;
    /** ★ Step 0：领域 ctx（调用时解析，严禁注册期冻成常量——1b 刚修掉的坑）。 */
    const dctx = { db, agentName, agentFpath, envCredential, isCredentialValid, nowIso, requestAbortSignal, killTree };
    /* ── ★ 批次 D1（2026-10-03，对标 orca `--retry-request <id>`）：写类 task_* 请求幂等 ──
     * 场景：agent 网络超时后无法判定「是否已生效」，只能重试 → 重复 done / 重复 release。
     * 做法：写类工具可选入参 `request_id`（客户端生成、全局唯一）。
     *   · 首达：正常执行 → 落 request_receipts 回执（原始返回串）；
     *   · 重放（同 id 再达）：**不执行**，原样返回首次回执 + 前缀标注 → 副作用只发生一次；
     *   · 错配（同 id 用在别的工具）：拒绝复用，防串号。
     * 语义边界：本表只证「该 id 已处理过」；**无记录 ≠ 未发生**——不带 request_id 的调用一律不查不落。
     * 实现：**单点包裹 addTool**（按工具名白名单）+ zod `.extend()` 注入参数声明。 */
    const IDEMPOTENT_TASK_TOOLS = new Set(["task_assign", "task_delegate", "task_claim", "task_heartbeat", "task_release", "task_admin", "task_done", "task_supersede", "task_settle"]);
    const REQUEST_ID_DESC = "★ D1 幂等键：网络超时重试时带同一 id → 已处理过则复用首次回执、不重复执行副作用。不传 = 行为与改动前一致。";
    /* ── ★ 第二批·编号彻底分离：任务侧编号引用兼容 ──
     * 历史任务号是裸号（如 4309），新任务号 ≥700000 并展示为 T-700001。所有任务域工具统一在这一个包裹点
     * 把 `T-700001` / `#700001` / `700001` 规整为数字，避免逐个工具改 execute（漏一处就断一条链路）。
     * schema 只放宽类型、不改变必填/可选性质：数字入参照旧走同一路径（对既有调用零影响）。 */
    const REF_FIELDS = ["memory_id", "superseded_by"];
    const refDesc = "编号：可写 T-700001 / #700001 / 700001（历史任务号是裸号，新任务号 ≥700000）";
    const recordRef = () => z.union([z.number().int().min(1), z.string().min(1).max(40)]);
    const widenRefs = (schema) => {
        if (!schema?.extend || !schema.shape)
            return schema;
        const patch = {};
        for (const k of REF_FIELDS) {
            const field = schema.shape[k];
            if (!field)
                continue;
            const optional = typeof field.isOptional === "function" && field.isOptional();
            patch[k] = (optional ? recordRef().optional() : recordRef()).describe(`${k} 编号引用。${refDesc}`);
        }
        return Object.keys(patch).length ? schema.extend(patch) : schema;
    };
    /** 逗号分隔的编号列表（depends_on / evidence_memory_ids）：合法项解析为数字，非法项原样保留交给下游报错 */
    const normRefList = (v) => typeof v === "string"
        ? v.split(",").map((s) => { const id = parseRecordRef(s); return id === null ? s.trim() : String(id); }).join(",")
        : v;
    const normalizeRefs = (args) => {
        if (!args)
            return null;
        for (const k of REF_FIELDS) {
            if (args[k] === undefined)
                continue;
            const id = parseRecordRef(args[k]);
            if (id === null)
                return `⚠ 编号非法（${k}=${String(args[k])}）：${refDesc}`;
            args[k] = id;
        }
        if (args.depends_on !== undefined)
            args.depends_on = normRefList(args.depends_on);
        if (args.evidence_memory_ids !== undefined)
            args.evidence_memory_ids = normRefList(args.evidence_memory_ids);
        return null;
    };
    const rawAddTool = server.addTool.bind(server);
    server = {
        addTool: (tool) => {
            if (!tool || typeof tool.execute !== "function")
                return rawAddTool(tool);
            const inner = tool.execute.bind(tool);
            const wrapped = {
                ...tool,
                parameters: widenRefs(tool.parameters),
                async execute(args) {
                    const badRef = normalizeRefs(args);
                    if (badRef)
                        return badRef;
                    return inner(args);
                },
            };
            if (!IDEMPOTENT_TASK_TOOLS.has(tool.name))
                return rawAddTool(wrapped);
            const idemInner = wrapped.execute.bind(wrapped);
            return rawAddTool({
                ...wrapped,
                parameters: wrapped.parameters?.extend ? wrapped.parameters.extend({ request_id: z.string().min(1).max(200).optional().describe(REQUEST_ID_DESC) }) : wrapped.parameters,
                async execute(args) {
                    const rid = args?.request_id ? String(args.request_id) : "";
                    if (!rid)
                        return idemInner(args); // 未带幂等键 → 原路径（已含编号规整），零开销
                    const hit = readRequestReceipt(db, rid);
                    if (hit) {
                        if (hit.tool !== tool.name)
                            return `request_id「${rid}」此前已用于 ${hit.tool}，与本次 ${tool.name} 不符：拒绝复用（防串号）。如需重试本工具，请换新的 request_id。`;
                        return `♻️ 幂等重放（request_id「${rid}」已于 ${hit.created_at} 由 ${hit.tool} 处理，本次未重复执行）：\n${hit.result}`;
                    }
                    const out = await idemInner(args);
                    // 只缓存字符串回执（本域工具均返回字符串）；非字符串不回缓存，避免类型往返失真。
                    if (typeof out === "string")
                        saveRequestReceipt(db, { requestId: rid, tool: tool.name, agent: agentName(), memoryId: Number.isInteger(args?.memory_id) ? args.memory_id : null, result: out });
                    return out;
                },
            });
        },
    };
    server.addTool({
        name: "task_gate",
        description: "查看任务 [gate:预设] 验收声明与结果（task_done 先跑验收，失败 fail-closed 回 pending）。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("要查看验收门的任务记忆 id"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return gateToolDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_assign",
        description: "给自己或公开池派活（本机任务队列）：assignee 可省略=公开任务，谁领谁记名。scope 声明要动的路径（撞车排队）；acceptance 写做完算成的条件（task_done 逐条对照，缺项/失败不能 done）；发布前自动查重（撞范围/撞验收提示重复编号，force=true 才强制）。标题只写工作内容，不另加人工代号。详规：tool_guide(name=task_assign)。",
        parameters: z.object({
            content: z.string().describe("首行写直白的工作标题，不含状态头、人工代号或手写任务编号；系统自动分配唯一任务号。正文写交付、修改边界、依赖和验收。"),
            assignee: z.string().optional().default("?")
                .describe("接收方 agent 名（如 codex/trae/zcode/claude）；**可省略**（省略/传 '?'/'any' 均为公开任务，保存为未指派，任意智能体按本人身份领取，认领时自动记名）"),
            scope: z.string().optional()
                .describe("★ 占用范围（可选）：逗号分隔的工作区相对路径或目录前缀（如 'src/api,resources/memoryos/dist'）。认领时与在办任务比对，撞同一片 → 排队（保持 pending）并说明撞哪件/哪路径；不声明 = 不参与冲突判定"),
            acceptance: z.union([z.string(), z.array(z.string().min(1).max(80)).max(8)]).optional()
                .describe("★ 验收标准（可选）：做完算成的条件，逐条可核对短句（如 'A 能点击'、'B 返回 200 且响应含特征串'、'C 测试全绿'）。数组或 | / 换行分隔，最多 8 条、每条 ≤80 字；task_done 必须逐条给 pass/fail/na(带理由)，卡/task_next/看板都会显示这几条"),
            progress: z.string().max(200).optional()
                .describe("★ 交接进度（可选）：接手方可直接看到的进度摘要（≤120 字，如 '已完成 X，卡在 Y，下一步 Z'）；写入任务头 [progress:…]，不在事件表里翻"),
            force: z.boolean().optional()
                .describe("★ 强制发布（可选，默认 false）：查重命中有实质重复（同范围/同验收条件）时默认拒绝；确认确需另建一条时传 true 才发布"),
            depends_on: z.string().optional().describe("依赖的任务 id，逗号分隔（如 '12,15'；可写 T-12/#12）；依赖全 done 后本任务才可做"),
            project: z.string().default("global").describe("任务 scope"),
            create_card: z.boolean().default(true).describe("是否在任务地图同步建卡（默认开）"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return assignTaskDomain(dctx, args);
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
        description: "委派给另一个 Agent（A2A 对等；目标须有有效 A1 凭据，缺失 fail-closed 拒绝）。给自己的活或公开池请用 task_assign。acceptance 写做完算成的条件（task_done 逐条对照）；发布前自动查重（同范围/同验收提示重复编号，force=true 才强制）。",
        parameters: z.object({
            content: z.string().describe("首行写直白的工作标题，不含状态头、人工代号或手写任务编号；系统自动分配唯一任务号。正文写交付、修改边界、依赖和验收。"),
            to: z.string().describe("目标 agent（如 codex/claude/trae/workbuddy/zcode）"),
            from: z.string().optional().describe("发起方 agent（缺省=当前 AGENT）"),
            gate: z.string().optional().describe("确定性验收门预设（lint-sql/lint-catch/smoke-mcp/smoke-task/smoke-p26/snapshot），写入任务头 [gate:预设]"),
            acceptance: z.union([z.string(), z.array(z.string().min(1).max(80)).max(8)]).optional()
                .describe("★ 验收标准（可选）：做完算成的条件，逐条可核对短句，最多 8 条、每条 ≤80 字；卡/task_next/看板都显示，task_done 必须逐条给 pass/fail/na(带理由)"),
            progress: z.string().max(200).optional().describe("★ 交接进度（可选）：接手方直接看到的进度摘要（≤120 字）"),
            force: z.boolean().optional().describe("★ 强制发布（可选）：查重命中实质重复时默认拒绝，确认另建传 true"),
            require_credential: z.boolean().default(true).describe("是否要求目标 agent 持有有效凭据（A1 认证层，默认开；fail-closed）"),
            project: z.string().default("global"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return delegateTaskDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_claim",
        description: "领取 pending 任务（租约可延长；in_progress 且租约已过期 → 认领时自动回收换手并回显前手进度；as=any 托管；takeover 接管须凭据；占用范围撞车 → 排队）。详规:tool_guide。",
        parameters: z.object({
            as: z.string().optional().describe("以谁的身份领取（缺省=当前 agent）；传 'any' 托管认领（跳过接收方校验）——语义见工具描述"),
            project: z.string().default("global").describe("任务 scope"),
            memory_id: z.number().int().optional().describe("指定领取某条任务 id；不填则列出当前可领的 pending 任务"),
            expected_version: z.number().int().optional().describe("P2-6 fencing：任务记忆乐观版本（你上次读到的 version）；不一致 → 拒绝陈旧领取"),
            lease_token: z.string().optional().describe("P2-6 fencing：你持有的租约锁（若卡片已被他人接管 → 拒绝僵尸领取）"),
            lease_minutes: z.number().int().min(10).max(120).optional().describe("租约分钟数（10..120；缺省取 MEMORYOS_LEASE_MINUTES，未设置则 10）；过期判据与心跳续租用同一套时长，超时可被他人认领回收"),
            progress: z.string().max(200).optional().describe("★ 交接进度（可选）：认领/接手时留一句进度摘要（≤120 字），下一手在卡与 task_next 直接看到；不传则沿用任务头已有摘要（租约回收时保留前手摘要）"),
            pick: z.enum(["next"]).optional().describe("★ A3（P1）：原子认领——一次调用完成「按可做集判据选取最优 + 认领」，消除 task_next→task_claim 两步窗口（多 agent 下输家白跑）。选取判据同 task_next（pending + 归属匹配 + 依赖满足；卡片 priority 降序、创建时间升序）。需 MEMORYOS_ATOMIC_CLAIM=1；未开时传 pick 返回提示、行为不变。"),
            takeover: z.boolean().optional().describe("★ 2026-10-03 批次 B1（G2 裁决心跳）：显式接管「待裁决」任务 —— 仅当任务头 in_progress 且其 active dispatch 已 stale（原持有者失联、被 reaper 标记）时生效；会生成新一代 dispatch（旧 stale 置 superseded）。须携带 scope>=write 凭据（改写归属）。不传 = 普通认领，行为不变。"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属认领者）；默认必填（A1 fail-closed）；仅显式 MEMORYOS_A1_ENFORCE=0 的灰度软模式可省略"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return claimTaskDomain(dctx, args);
        },
    });
    // ★ A1（P1）：task_settle 凭 ticket 结算/归还——开关 MEMORYOS_TASK_SETTLE=1 才注册（默认关 = 工具面逐字节不变）。
    //   治 #2：上下文压缩丢令牌后交不了差。归属纪律：只收 dispatch_key 或 memory_id+session_id（命中 active 代）；
    //   裸 memory_id / 已 superseded 的代一律拒。
    if (taskSettleOn()) {
        server.addTool({
            name: "task_settle",
            description: "凭 dispatch ticket 结算/归还未完任务（治上下文压缩丢令牌后交不了差；服务端反查票据，agent 无需记住令牌）。",
            parameters: z.object({
                dispatch_key: z.string().optional().describe("task_claim 回执的票据（lease_token 同值）；与 memory_id+session_id 二选一"),
                memory_id: z.number().int().optional().describe("配合 session_id 定位该任务当前 active 代（不接受裸 memory_id——谁都能传=围栏失效）"),
                session_id: z.string().optional().describe("调用方会话 id——必须与 active dispatch 的 session_id 相符（同名 agent 多会话防串号）"),
                conclusion: z.string().optional().describe("交接注记（留痕任务正文）：活已干成但无法走 task_done 时，把结论交给下一位（防重试放弃/乱试）"),
                outcome: z.enum(["succeeded", "failed"]).optional().describe("attempt 结局标注；不传=归还（release 语义）"),
                task_hint: z.string().optional(),
            }),
            async execute(args) {
                return settleTaskDomain(dctx, args);
            },
        });
    }
    server.addTool({
        name: "task_heartbeat",
        description: "刷新在办任务租约（默认 10 分钟，防守护回收；无关联卡时仅记事件）。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("任务记忆 id"),
            as: z.string().optional().describe("以谁的身份续租（缺省=当前 agent）；须与任务认领者一致"),
            lease_minutes: z.number().int().min(10).max(120).optional().describe("续租分钟数（10..120；缺省取 MEMORYOS_LEASE_MINUTES，未设置则 10）；与 task_claim 的租约分级、过期回收判据同口径"),
            dispatch_key: z.string().optional().describe("★ 2026-10-03 A1（软模式）：task_claim 返回的 dispatch_key（与 lease_token 同值）；携带且为 active 即证明权威，不传/传错仅回执提示不拒绝。"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return heartbeatTaskDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_release",
        description: "归还/释放认领（in_progress→pending 清锁；仅当前认领者或持 scope>=write 凭据者）。误领了别人的过期任务后用 assignee_to 还给原主，不传时自动退回事件流记录的前手。progress 留一条交接进度摘要（≤120 字），接手方在卡与 task_next 直接看到；不传则沿用任务头已有摘要。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("任务记忆 id"),
            reason: z.string().optional().describe("释放原因（留痕 card_events/事件流）"),
            assignee_to: z.string().optional().describe("★ 归还原主（可选）：把负责人写回指定 agent（如误领后还给原主）；传 ? / any / unassigned = 显式置为未指派。不传时：本次若是租约回收/接管换手，自动退回事件流记录的前手；否则保持当前负责人"),
            progress: z.string().max(200).optional().describe("★ 交接进度（可选）：做到哪、留了什么（≤120 字）；不传时优先沿用旧摘要，再退化为 reason 摘要"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属当前 agent）；默认必填（A1 fail-closed）；仅显式 MEMORYOS_A1_ENFORCE=0 的灰度软模式可省略"),
            dispatch_key: z.string().optional().describe("★ 2026-10-03 A1（软模式）：task_claim 返回的 dispatch_key；携带且为 active 即证明权威，不传/传错仅回执提示不拒绝。"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return releaseTaskDomain(dctx, args);
        },
    });
    // ★ 2026-10-19 工具面整合：task_block / task_reopen / task_verify 并门（三者均 L1/required、均不在无头预授权，
    //   风险与审批语义逐字不变；审计事件名 task_block/task_reopen/task_verify 在 task-domain.js 保留不变）。
    server.addTool({
        name: "task_admin",
        description: "任务状态管理门（action=block 标记受阻 / reopen 重开终态 / verify 第三方验收关闭）。详规:tool_guide。",
        parameters: z.object({
            action: z.enum(["block", "reopen", "verify"]).describe("子操作：block=受阻（不进可做集）；reopen=终态重开重派；verify=验收关闭（不改归属/不发租约）"),
            memory_id: z.number().int().min(1).describe("任务记忆 id"),
            reason: z.string().describe("原因/依据（必填，留痕）：受阻原因 / 重开原因 / 验收依据（对应提交/冒烟结果/证据位置）"),
            assignee: z.string().optional().describe("action=reopen：重开后指派给谁（缺省=原认领者）"),
            as: z.string().optional().describe("action=verify：验收方身份（缺省=当前 agent）"),
            user_rewritten: z.string().optional().describe("action=verify（P2⑦ 反馈回流）：用户改写过验收结论时，把改写后的版本填这里；不改写则不传"),
            expected_version: z.number().int().optional().describe("action=verify（P2-6 fencing）：任务记忆乐观版本；不一致 → 拒绝陈旧验收写；A1 硬模式必填"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属当前 agent/验收方）；默认必填（A1 fail-closed）；仅显式 MEMORYOS_A1_ENFORCE=0 的灰度软模式可省略"),
            dispatch_key: z.string().optional().describe("★ 2026-10-03 A1（软模式）：task_claim 返回的 dispatch_key（verify 为验收方持有的，若有）；携带且为 active 即证明权威，不传/传错仅回执提示不拒绝。"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            if (args.action === "block")
                return blockTaskDomain(dctx, args);
            if (args.action === "reopen")
                return reopenTaskDomain(dctx, args);
            return verifyTaskDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_done",
        description: "完成任务（gate 先验收）；头有 [accept:…] 须逐条给结果。详规:tool_guide。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("要完成的记忆 id"),
            conclusion: z.string().describe("完成结论/结果摘要（追加进任务正文）"),
            acceptance_results: z.array(z.object({
                item: z.number().int().min(1).describe("第几条验收标准（1 起，对应任务头 [accept:…] 的顺序）"),
                result: z.enum(["pass", "fail", "na"]).describe("pass=通过；fail=未通过（不能标 done）；na=不适用（必须带 note 写理由）"),
                note: z.string().max(200).optional().describe("result=na 时的理由（必填）；pass/fail 可留证据/现象"),
            })).max(8).optional().describe("★ 验收逐条结果：任务头有 [accept:…] 时必填且须覆盖全部条目（每条一次）；允许 na 但必须给 note 理由"),
            lease_token: z.string().optional().describe("P2-6 fencing：task_claim 返回的租约锁；与卡片当前锁不符 → 拒绝过期完成写"),
            dispatch_key: z.string().optional().describe("★ 2026-10-02 Dispatch 语义：task_claim 返回的 dispatch_key（与 lease_token 同值）。传了即强制「权威只来自 active dispatch」——已 settled/released/superseded、或任务/归属不符一律拒绝。软模式可省略。"),
            expected_version: z.number().int().optional().describe("P2-6 fencing：任务记忆乐观版本；不一致 → 拒绝陈旧完成写"),
            credential: z.string().optional().describe("A1 凭据（scope>=write，须归属当前 agent）；默认必填（A1 fail-closed）；仅显式 MEMORYOS_A1_ENFORCE=0 的灰度软模式可省略"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
            evidence_memory_ids: z.string().optional().describe("P2⑳（证据约束）：支撑本结论的记忆 id（逗号分隔，如 '12,45'）；无来源的结论应留空并自知风险。不传 = 标记 unverified"),
        }),
        async execute(args) {
            return doneTaskDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_supersede",
        description: "重复任务归档（merged+superseded_by 指向主任务，移出可做集）。",
        parameters: z.object({
            memory_id: z.number().int().min(1).describe("要归档的重复任务记忆 id（loser）"),
            superseded_by: z.number().int().min(1).describe("保留的主任务记忆 id（winner）"),
            dispatch_key: z.string().optional().describe("★ 2026-10-03 A1（软模式）：调用方持有的 dispatch_key（loser 任务上的）；携带且为 active 即证明权威，不传/传错仅回执提示不拒绝。"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            return supersedeTaskDomain(dctx, args);
        },
    });
    server.addTool({
        name: "task_next",
        description: "查当前可做任务（依赖拓扑与优先级）+ 我在做 + 待决策；默认每段 5 条，传 task_id 看单卡状态/验收。",
        parameters: z.object({
            project: z.string().default("global").describe("任务 scope"),
            as: z.string().optional().describe("以谁的身份查（缺省=当前 agent）；传 '' 或 'any' 查全部可做集"),
            domain: z.boolean().default(false).describe("只返回依赖链中当前可做链路的路径提示（A→B→C）"),
            limit: z.number().int().min(1).max(50).default(5).describe("每段最多列几条（默认 5，上限 50）"),
            task_id: z.union([z.number().int(), z.string()]).optional().describe("传任务号则只返回该任务的状态/负责人/进度/验收（纯数字，如 700053）"),
            session_id: z.string().optional(),
            task_hint: z.string().optional(),
        }),
        async execute(args) {
            // ★ 批次 B：领域计算在 task-domain.js::nextTasks（经 ops-registry 派发），本处只做薄适配；
            //   身份在**调用时**经 agentName accessor 解析；readTaskState / taskBody 经 ctx 注入（现自 task-domain.js import）。
            const structured = await invokeOp("task.next", args, { db, agentName, readTaskState, taskBody });
            return renderTaskNextText(structured);
        },
    });
}
