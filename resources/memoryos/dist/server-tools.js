import { z } from 'zod';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { normalizeTaskArguments, publicTaskResult } from './task-identity.js';
import { friendlyParamError, friendlyExecutionError, missingTaskIdError } from './error-messages.js';
/** 缺 task_id 属参数引导（非执行异常）：结果里只回专属中文下一步，不套执行失败模板。 */
class MissingTaskIdError extends Error {}
/**
 * MemoryOS — 工具面注册编排（★ 2026-10-14 架构重构 1a）
 *
 * 从 server.js 模块顶层抽出「工具注册编排」，让核心（dashboard）与 MCP server 共用**同一份**工具面：
 *   - addTool 覆写层：记录注册清单 + 注入 riskPrefix 风险前缀 + try/catch 结构化错误兜底；
 *   - 共享层 ctx 组装（stateReceipt / TxAbort / runTaskTx / isCredentialValid / nowIso / plusHoursIso）；
 *   - 三域注册（memory → obsidian → task）+ tool_guide + 执行面（MEMORYOS_EXEC_ON=1 时 file_read/file_write/exec_run）。
 *
 * 返回值：{ tools: Map<name, def>, execEnabled }。
 *   fastmcp 的工具集合存在私有字段 `#tools`，实例外部按名取不到 ⇒ 必须自持一份 Map
 *   （1b 的 HTTP 转发 shim 与 dashboard 的 /ops/:tool 派发都以此为准）。
 *
 * 纪律（1a）：不改任何现有行为 —— 注册顺序 / 工具名 / 描述 / schema / 响应文案逐字不变，
 *   由 `node dist/server.js --list-tools` 前后逐字节比对兜底。
 *   opts.executeOverride：(name, def, info) => Promise<result> | undefined，可选钩子；非 undefined 时
 *   该次执行改走它（1b 的 shim 用它换成 HTTP 转发器），1a 不传 ⇒ 与重构前完全一致。
 *   info = { args, extra }：args = fastmcp 已按 schema 解析后的入参；extra = fastmcp 的 Context
 *   （requestId / sessionId / log / reportProgress…，见 fastmcp d.ts）。shim 用 requestId 关联取消控制器。
 * env 口径与重构前一致：MEMORYOS_EXEC_OFF=1 熔断（优先级最高），MEMORYOS_EXEC_ON=1 才启用执行面。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import {installFeedback,recordFeedback} from './feedback-events.js';
import { logExecAudit } from "./db.js";
import { isCredentialRowValid } from "./a1-mode.js"; // ★ 2026-11-16（R02-04）：凭据有效性判据单一真相源
import { createExecTools, riskPrefix } from "./exec-tools.js";
import { createApprovalGate } from "./exec-approval.js";
import { registerMemoryTools } from "./server-reg-memory.js";
import { registerObsidianTools } from "./server-reg-obsidian.js";
import { registerTaskTools } from "./server-reg-task.js";
import { registerKnowledgeTools } from "./server-reg-knowledge.js";
import { registerGuideTool } from "./tool-guides.js";

/* ★ 2026-10-14（架构重构 1b）：请求级身份载体 —— 调用方身份透传。
 *  核心（dashboard）经 /ops/:tool 在同一进程内代多个 Agent 执行**同一份**工具面；若工具仍读注册期
 *  冻结的进程常量（AGENT/AGENT_FPATH/ENV_CRED），所有写入都会记在核心自身名下（归属/审计/A1 凭据门禁失真）。
 *  故：注册期把 ctx 里的进程身份存为**回落默认值**（direct 模式 = 无请求上下文时逐字保持旧行为），
 *  工具实现改调 agentName()/agentFpath()/envCredential()（函数，非常量）；请求边界由 withToolIdentity 注入调用方身份。 */
const _identityAls = new AsyncLocalStorage();
let _identityDefaults = { agent: "unknown", agentFpath: null, envCred: null };
/** 当前请求上下文的 agent，取不到则回落进程默认身份（direct 模式与改前逐字一致）。 */
export function agentName() { return _identityAls.getStore()?.agent ?? _identityDefaults.agent; }
export function agentFpath() { return _identityAls.getStore()?.agentFpath ?? _identityDefaults.agentFpath; }
/** 对应原 ENV_CRED：当前请求所属 Agent 的 A1 凭据（调用方省略 credential 入参时由工具内部回退使用）。 */
export function envCredential() { return _identityAls.getStore()?.envCred ?? _identityDefaults.envCred; }
/** ★ 1b：当前请求的取消信号（核心侧请求中断时由此下发；direct 模式取不到 → null = 无取消语义，与改前逐字一致）。
 *  消费方：exec_run（杀子进程树）、task_done 的 [gate] 验收子进程（runTaskGate）。 */
export function requestAbortSignal() { return _identityAls.getStore()?.signal ?? null; }
/** ★ 1b 收口（缺口 B）：当前请求的调用方工作目录（核心侧由 `x-memory-cwd` 头透传；direct 模式取不到 → null）。
 *  消费方：执行面（exec_run/file_read/file_write）在调用方**未显式给 cwd/路径基准**时，用它替代
 *  进程工作区解析相对路径 —— 使 shim 与 direct 语义等价（见 exec-tools.js::pickBase 注释）。 */
export function requestClientCwd() { return _identityAls.getStore()?.clientCwd ?? null; }
/** 以请求身份包住 fn：ident 的可缺省字段（agent/agentFpath/envCred/signal/clientCwd）回落进程默认身份/无信号/无 cwd（缺省=direct 行为）。 */
export function withToolIdentity(ident, fn) {
    const i = ident ?? {};
    return _identityAls.run({
        agent: i.agent ?? _identityDefaults.agent,
        agentFpath: i.agentFpath ?? _identityDefaults.agentFpath,
        envCred: i.envCred ?? _identityDefaults.envCred,
        signal: i.signal ?? null,
        clientCwd: i.clientCwd ?? null,   // ★ 缺口 B：调用方 cwd（x-memory-cwd 透传；缺省 null）
    }, fn);
}

/**
 * ★ A1 身份与认证层：短生命周期凭据（动态凭据 + 最小权限 scope + 可撤销信任）。
 * 签发/吊销/校验三态。credential 为随机 hex（randomBytes），绝不存口令、绝不参与命令拼接。
 */
function nowIso() { return new Date().toISOString(); }
function plusHoursIso(h) { return new Date(Date.now() + h * 3600_000).toISOString(); }
function isCredentialValid(row) {
    return isCredentialRowValid(row, nowIso()); // ★ 2026-11-16（R02-04）：判据收敛到 a1-mode.js 单一真相源
}
/** ★ Step 0（2026-10-18）：stateReceipt / TxAbort / runTaskTx 已抽至叶子模块 tx.js（领域层 task-domain.js
 *  也要用它们，domain → server-tools 会形成循环依赖）；此处原样 re-export，_ctx 组装与既有 import 方零改动。 */
export { stateReceipt, TxAbort, runTaskTx } from "./tx.js";
import { stateReceipt, TxAbort, runTaskTx } from "./tx.js";

/**
 * @param {object} server FastMCP 实例（注册容器；核心侧只当容器用，不 listen）
 * @param {object} ctx 基础上下文 { db, AGENT, AGENT_FPATH, ENV_CRED, dbPath }
 * @param {{ executeOverride?: (name: string, def: object) => Promise<any> | undefined }} [opts]
 * @returns {{ tools: Map<string, object>, execEnabled: boolean }}
 */
export function registerAllTools(server, ctx, opts = {}) {
    const { db, AGENT, AGENT_FPATH, ENV_CRED, dbPath } = ctx;
    if(db)installFeedback(db);
    // ★ 1b：把进程身份（env 派生）存为请求级身份的回落默认值（direct 模式零回归）。
    _identityDefaults = { agent: AGENT ?? "unknown", agentFpath: AGENT_FPATH ?? null, envCred: ENV_CRED ?? null };
    const tools = new Map();
    /**
     * 工具级错误兜底（P0-2.1）。
     * 现状：本覆写层覆盖 server-reg-*.js 注册的全部工具（常驻清单以 `--list-tools` 为准），注册点仅 9 处 try/catch —— 未捕获异常会以原始堆栈
     * 形式抛给 MCP 客户端，用户看到的是内部实现细节；涉及嵌入计算 / LLM 调用 / 文件 IO
     * 的工具异常面尤其大。
     * 本包装保证：任何工具异常都被转为结构化文本结果 + stderr 留痕，绝不抛裸异常。
     *
     * 实现方式：覆盖「实例上的 addTool 方法」（实例属性遮蔽原型方法），而非改写各处注册点 ——
     * 这样注册点的参数类型推断与可读性完全不变，只在运行时多包一层 try/catch。
     */
    // ★ 2026-09-19 单一事实源：所有经覆写层注册的工具名都记入 tools（Map 保序 = 注册顺序）。
    //   `node dist/server.js --list-tools` 打印该清单后退出，冒烟（smoke-agent）用它派生期望工具面，
    //   根治「手抄清单第 5 次过期」（task_verify 落地后 smoke 的 REQUIRED 仍停在 25 → 必 FAIL）。
    const _origAddTool = server.addTool.bind(server);
    /* ★ 2026-11-07（#700055）：把标准校验（fastmcp 用 parameters['~standard'].validate）包一层，
     * 让「协议层参数错误」与「/ops 派发层参数错误」共用 error-messages.js 的中文文案。
     * 只改写 ~standard.validate；schema 本体（shape / safeParse / toJsonSchema）保持不变。 */
    const withFriendlyValidation = (schema, toolName) => {
        if (!schema || typeof schema['~standard']?.validate !== 'function')
            return schema;
        const original = schema['~standard'].validate.bind(schema);
        /* ★ 2026-11-16（R02-06，zod 4 迁移）：zod 4 的 invalid_value / invalid_type issue **不再携带输入值**
         *  （无 received/input 字段），导致错误文案退化成「取值不合法：未传」——明明传了错值却说没传。
         *  这里在包装层按 issue.path 从**原始入参**回填 received，保持既有中文文案与断言口径。 */
        const valueAtPath = (obj, p) => {
            let cur = obj;
            for (const k of p) {
                if (cur == null) return undefined;
                cur = cur[k];
            }
            return cur;
        };
        const withReceived = (issues, raw) => (Array.isArray(issues) ? issues : []).map((it) => {
            if (!it || it.received !== undefined || it.input !== undefined) return it;
            const v = valueAtPath(raw, Array.isArray(it.path) ? it.path : []);
            return v === undefined ? it : { ...it, received: v };
        });
        const chineseInvalidParams = (issues) => {
            const err = new McpError(ErrorCode.InvalidParams, friendlyParamError(toolName, issues));
            err.message = friendlyParamError(toolName, issues);
            return err;
        };
        Object.defineProperty(schema, '~standard', {
            configurable: true, enumerable: true, writable: true,
            value: {
                ...schema['~standard'],
                async validate(value) {
                    let result;
                    try {
                        result = await original(value); // 兼容同步 issue 与异步 Promise 两种 standard schema
                    }
                    catch {
                        throw chineseInvalidParams([]); // 校验器自身异常也只回中文，不带内部细节
                    }
                    if (result?.issues?.length)
                        throw chineseInvalidParams(withReceived(result.issues, value));
                    return result;
                },
            },
        });
        return schema;
    };
    server.addTool = (def) => {
        const shape=def.parameters?.shape;
        const taskAlias=def.name.startsWith('task_') && shape?.memory_id;
        const checkpointAlias=['memory_context','memory_work'].includes(def.name) && shape?.task_card_id;
        // ★ 2026-11-07（#700055）：task_id 与旧 memory_id 是「二选一必填」——JSON Schema 无法表达 union-required，
        //   故两者仍声明 optional，在执行期统一校验并给专属中文引导（不破坏旧客户端逐字兼容）。
        //   task_claim 例外：不带编号 = 列可领任务 / pick=next 自动选取，是既有能力，必须保留。
        const TASK_ID_REQUIRED_TOOLS=new Set(['task_done','task_claim','task_release','task_admin']);
        const claimCanList=def.name==='task_claim';
        const taskIdRequired=taskAlias && (!shape.memory_id.isOptional() || TASK_ID_REQUIRED_TOOLS.has(def.name));
        if(taskAlias||checkpointAlias) {
            const requiredNote=TASK_ID_REQUIRED_TOOLS.has(def.name) && !claimCanList
                ? '与旧 memory_id 二选一必填；新调用统一使用此字段' : '统一任务编号，与地图、领取及提交回执相同；新调用统一使用此字段';
            const extra={task_id:z.number().int().positive().optional().describe(requiredNote)};
            if(taskAlias) extra.memory_id=shape.memory_id.optional().describe('旧客户端兼容参数，新调用请使用 task_id；两者同时传入时必须一致。编号可写 T-700001 / #700001 / 700001');
            if(checkpointAlias) extra.task_card_id=shape.task_card_id.describe('旧客户端内部节点号；新调用请使用 task_id，不要填地图显示的任务号');
            def.parameters=def.parameters.extend(extra);
            // ★ 2026-11-07（#700054）：不再把「task_id 兼容说明」顶到 description 首句——
            //   参数级 describe 已逐字段说明，首句留给「这工具干什么」。
        }
        // ★ 2026-11-07（#700055）：校验错误中文单一事实源（覆盖 stdio 协议层；/ops 层共用同一模块）。
        def.parameters=withFriendlyValidation(def.parameters,def.name);
        tools.set(def.name, def);
        // ★ P0 执行面（修 F1）：把风险级/审批策略前缀注入工具描述 —— 单一真相源在 exec-tools.js 的 TOOL_RISK。
        //   ★ 2026-09-22 fail-closed 兜底：riskPrefix 对不在 TOOL_RISK 的未知工具返回 L4/required（不再返回空串），
        //     故本端注册的每个工具 100% 带前缀；agent-core 解析前缀决定是否过 writeGate，漏登记只会多审批、不会静默放行。
        const _pfx = riskPrefix(def.name);
        if (_pfx && !String(def.description || "").includes("⟨risk:")) {
            // ★ 2026-11-07（#700054）：风险级标记从「首句前缀」挪到「描述末尾」——
            //   AI 读到的前 40 字是用途而不是 L0/L4；门禁解析改为全串匹配，行为不变。
            def.description = (def.description || "") + "\n" + _pfx.trim();
        }
        const orig = def.execute;
        def.execute = async (...a) => {
            const started=Date.now();
            try {
                if(taskIdRequired && !claimCanList && a[0]?.task_id==null && a[0]?.memory_id==null)
                    throw new MissingTaskIdError(missingTaskIdError(def.name));
                a[0]=normalizeTaskArguments(def.name,a[0],opts.executeOverride?null:db);
                // 无号 task_claim = 列可领任务 / pick=next 自动选取（既有能力，原样保留）；
                // 其余依赖编号的工具在工作前就拦住，避免白跑一轮业务逻辑。
                const needTaskId=taskIdRequired && !claimCanList;
                if(needTaskId && a[0]?.memory_id==null) throw new MissingTaskIdError(missingTaskIdError(def.name));
                if (opts.executeOverride) {
                    const r = await opts.executeOverride(def.name, def, { args: a[0], extra: a[1] });
                    if (r !== undefined)
                        return r;
                }
                const result=await orig.apply(def, a);
                recordFeedback(db,{agent:agentName(),tool:def.name,result,args:a[0],durationMs:Date.now()-started});
                return (a[0]?.task_id!=null || ['task_assign','task_delegate','task_next'].includes(def.name)) ? publicTaskResult(db,result) : result;
            }
            catch (e) {
                recordFeedback(db,{agent:agentName(),tool:def.name,status:'failed',code:/MEMORY_BODY_FORMAT/.test(String(e))?'body_format':/SQLITE_BUSY|database is locked/.test(String(e))?'database_busy':'execution_failed',durationMs:Date.now()-started});
                const msg = e instanceof Error ? e.message : String(e);
                console.error(`[tool:${def.name}] 执行失败: ${msg}`);
                // ★ 2026-09-25 P1-d：协议级可判定错误 —— 原返回纯文本，MCP 结果层 isError=false，
                //   调用方只能靠字符串嗅探 "⚠" 才知道这是失败（agent-core.js:226 对 isError 的消费从未被触发）。
                //   改为 ContentResult{content, isError:true}：文本原样保留（人类/纯文本解析器零变化），
                //   符合 MCP 规范的客户端从此能正确判定失败（fastmcp 类型支持见 FastMCP.d.ts:168/606）。
                // ★ 2026-11-07（#700055）：文案统一走 error-messages.js —— 中文化、按错误类型给下一步、
                //   只有真锁竞争才建议重试；不含堆栈与本机路径。
                const text = e instanceof MissingTaskIdError
                    ? msg
                    : friendlyExecutionError(def.name, e);
                return {
                    content: [{ type: "text", text }],
                    isError: true,
                };
            }
        };
        _origAddTool(def);
    };

    const _ctx = { db, AGENT, AGENT_FPATH, ENV_CRED, stateReceipt, TxAbort, runTaskTx, isCredentialValid, nowIso, plusHoursIso };

    /* ── 工具注册：调用顺序 = Map 键顺序，等价于原文件声明顺序；勿调整 ──
     *   memory → obsidian → task；执行面（file_read/file_write/exec_run）在其后按需追加。 */
    registerMemoryTools(server, _ctx);
    registerObsidianTools(server, _ctx);
    registerTaskTools(server, _ctx);
    registerKnowledgeTools(server, { ..._ctx, tools, getAgent: agentName });
    registerGuideTool(server, tools); // ★ 批次F1（P2-2）：工具详规按需查询；★ #700054：清单从实际注册表生成，不写死

    /* ── P0 执行工具面注册（方案 A：单 MCP 平面 + 模块分离）────────────
       只有 3 个工具 P0 上线；均自动被上面的 addTool 覆写包裹（try/catch + 风险前缀）。
       默认值（★ P0-2，用户拍板「决策1 (a)」）：**默认关闭执行面**，显式 MEMORYOS_EXEC_ON=1 才启用。
       与方案「P0 上线默认关闭、逐工具 opt-in」一致，也同向 B1「写操作先获同意」。
       既有 MEMORYOS_EXEC_OFF=1 作为显式熔断兜底，优先级最高（只要它=1 一律不启用）。 */
    const _KERNEL_DIR = path.dirname(fileURLToPath(import.meta.url));            // .../resources/memoryos/dist
    const _WORKSPACE_ROOT = path.resolve(process.env.MEMORYOS_WORKSPACE || path.join(_KERNEL_DIR, "..", "..", ".."));
    const _DATA_DIR = path.dirname(dbPath ?? "");
    const _EXEC_OFF = process.env.MEMORYOS_EXEC_OFF === "1";
    const _EXEC_ON = process.env.MEMORYOS_EXEC_ON === "1";
    let execEnabled = false;
    if (_EXEC_OFF) {
        console.error("[exec] MEMORYOS_EXEC_OFF=1 —— 执行面已显式熔断，本次仅暴露记忆/任务工具");
    } else if (!_EXEC_ON) {
        console.error("[exec] 执行面默认关闭（未设 MEMORYOS_EXEC_ON=1）—— 本次仅暴露记忆/任务工具；显式置 MEMORYOS_EXEC_ON=1 以启用 file_read/file_write/exec_run");
    } else {
        execEnabled = true;
        // ★ 2026-10-14（方案 B）：审批闸注入 —— 高风险命令（exec-tools.execRiskReason）先落 exec_approvals 的
        //   pending 并挂起等待，人在看板「待批命令」点同意才继续执行；无人处理到期按**拒绝**处理（不放行）。
        const _approvalGate = createApprovalGate(db, { audit: (row) => logExecAudit(db, row) });
        for (const t of createExecTools({
            workspaceRoot: _WORKSPACE_ROOT,
            dataDir: _DATA_DIR,
            agent: AGENT,
            logAudit: (row) => logExecAudit(db, row),
            approvalGate: _approvalGate,
            getAbortSignal: () => requestAbortSignal(),   // ★ 1b：请求中断 → exec_run 杀子进程树
            getClientCwd: () => requestClientCwd(),       // ★ 缺口 B：调用方 cwd（x-memory-cwd 透传）作相对路径缺省基准
        })) {
            server.addTool(t);
        }
        console.error(`[exec] 执行面已启用：file_read / file_write / exec_run（工作区 ${_WORKSPACE_ROOT}；artifact 落 ${path.join(_DATA_DIR, "artifacts")}）`);
    }

    return { tools, execEnabled, withIdentity: withToolIdentity };
}
