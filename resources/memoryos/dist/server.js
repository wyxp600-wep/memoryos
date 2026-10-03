/**
 * MemoryOS v0.2 — MCP Server（fastmcp v3 / FastMCP）
 * Tools: memory_write（embed + 去重/冲突预检） / memory_search（混合检索 RRF）
 * ★ P2-④（2026-09-22）：常驻工具按域拆分到 server-reg-memory.js / -obsidian.js / -task.js（数量以 `--list-tools` 为准，勿手抄）；
 *   本文件保留内核（FastMCP 实例 + addTool 覆写 + 共享层）、执行面注册与 CLI 入口。
 *   注册顺序不变：memory → obsidian → task；`node dist/server.js --list-tools` 逐字节可证（数量勿手抄）。
 * 启动：stdio（默认 transport），node dist/server.js
 */
import { FastMCP } from "fastmcp";
import { openDb, withTx, appendEvent, logExecAudit } from "./db.js";
import { createExecTools, riskPrefix } from "./exec-tools.js";
import { embedMode } from "./embed.js";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { registerMemoryTools } from "./server-reg-memory.js";
import { registerObsidianTools } from "./server-reg-obsidian.js";
import { registerTaskTools } from "./server-reg-task.js";
import { registerGuideTool } from "./tool-guides.js";
// —— 运行时身份读取（R3 分工：读写自动带 agent/agent_fpath）——
const DB_PATH = process.env.MEMORY_DB ?? (process.env.APPDATA
  ? path.join(process.env.APPDATA, "MemoryOS", "data", "memory.db") // ★ 口径收口（2026-10-02 用户拍板）：缺省只用 %APPDATA% 生产库，不再落仓内 dev 库（防止无 MEMORY_DB 的接入面悄悄写错库）
  : fileURLToPath(new URL("../data/memory.db", import.meta.url))); // APPDATA 缺失（非 Windows）兜底原路径
const AGENT = process.env.MEMORY_AGENT ?? "unknown";
const AGENT_FPATH = process.env.MEMORY_AGENT_FPATH ?? null;
const ENV_CRED = process.env.MEMORYOS_A1_CREDENTIAL ?? null; // ★ 一致性⑧：MCP 配置注入的本 agent 凭据（调用方省略 credential 入参时回退；归属仍按 who 严格校验，拿他人凭据照样拒绝）
function auditAgentIdentity() {
    if (!AGENT_FPATH) {
        console.error(`[warn] MEMORY_AGENT_FPATH 未设置，身份无法佐证（agent=${AGENT}）`);
        return;
    }
    if (!fs.existsSync(path.resolve(AGENT_FPATH))) {
        console.error(`[warn] 配置路径指纹不存在: ${path.resolve(AGENT_FPATH)}（agent=${AGENT}）`);
    }
}
const db = openDb(DB_PATH);
auditAgentIdentity();
// ★ 2026-09-25 P0③：IDE 里以 stdio 起的 MCP 常不注入 EMBED_MODE —— 若沿用模块默认 fake，
//   语义检索会静默退化成纯词法召回（库内向量是 bge-m3 真向量，query 造假向量必然对不上）。
//   故此处补缺省 local（口径对齐 agent-core.js 的 `process.env.EMBED_MODE || "local"`）；
//   embed.js 已改惰性解析，此刻设置即生效。显式设 api/fake 仍可覆盖。
const _embedDefaulted = !process.env.EMBED_MODE;
if (_embedDefaulted)
    process.env.EMBED_MODE = "local";
// P0① 启动自检：embed 模式兜底告警（存储向量已是 bge-m3 真实嵌入；检索若跑 fake 模式则 query 向量与库不匹配，召回必失效）
const _embedMode = embedMode();
console.error(`[embed] EMBED_MODE=${_embedMode}${_embedMode === "fake" ? "  ⚠ 无语义检索：生产使用需在客户端 MCP 配置注入 EMBED_MODE=local（见 deploy-mcp.mjs 或 dashboard 工具连接页配置示例）" : _embedDefaulted ? "（未注入 EMBED_MODE，已按缺省 local 启动；若本机无模型缓存，首次调用会加载/下载模型（约数百 MB）——可显式设 EMBED_MODE=api 或 fake 覆盖）" : ""}`);
const server = new FastMCP({
    name: "memory-hub",
    version: "0.2.0",
    instructions: "共享记忆中心（语义检索）。会话开始/执行关键任务前先调用一次 memory_context 一键注入当前项目高价值记忆；提交修复结论/技术决策/隐藏约定/第三方坑时调用 memory_write；需要精确检索时 memory_search（scope 不确定先 memory_projects）。禁写：绝不写入敏感凭据。",
});

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
// ★ 2026-09-19 单一事实源：所有经覆写层注册的工具名都记入 REGISTERED_TOOLS。
//   `node dist/server.js --list-tools` 打印该清单后退出，冒烟（smoke-agent）用它派生期望工具面，
//   根治「手抄清单第 5 次过期」（task_verify 落地后 smoke 的 REQUIRED 仍停在 25 → 必 FAIL）。
const REGISTERED_TOOLS = [];
const _origAddTool = server.addTool.bind(server);
server.addTool = (def) => {
    REGISTERED_TOOLS.push(def.name);
    // ★ P0 执行面（修 F1）：把风险级/审批策略前缀注入工具描述 —— 单一真相源在 exec-tools.js 的 TOOL_RISK。
    //   ★ 2026-09-22 fail-closed 兜底：riskPrefix 对不在 TOOL_RISK 的未知工具返回 L4/required（不再返回空串），
    //     故本端注册的每个工具 100% 带前缀；agent-core 解析前缀决定是否过 writeGate，漏登记只会多审批、不会静默放行。
    const _pfx = riskPrefix(def.name);
    if (_pfx && !String(def.description || "").startsWith("⟨risk:")) {
        def.description = _pfx + (def.description || "");
    }
    const orig = def.execute;
    def.execute = async (...a) => {
        try {
            return await orig.apply(def, a);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[tool:${def.name}] 执行失败: ${msg}`);
            // ★ 2026-09-25 P1-d：协议级可判定错误 —— 原返回纯文本，MCP 结果层 isError=false，
            //   调用方只能靠字符串嗅探 "⚠" 才知道这是失败（agent-core.js:226 对 isError 的消费从未被触发）。
            //   改为 ContentResult{content, isError:true}：文本原样保留（人类/纯文本解析器零变化），
            //   符合 MCP 规范的客户端从此能正确判定失败（fastmcp 类型支持见 FastMCP.d.ts:168/606）。
            return {
                content: [{ type: "text", text: `⚠ ${def.name} 执行失败：${msg}\n（异常已捕获，会话未中断。若为 SQLite 锁竞争，可稍后重试一次。）` }],
                isError: true,
            };
        }
    };
    _origAddTool(def);
};

/* ── 共享层（P2-④）：被 ≥2 个域模块使用的原语，经 ctx 注入 —— 避免 reg → server 的循环 import ──
 *   nowIso / plusHoursIso / isCredentialValid：memory_credential ↔ checkWriteCredential（任务域）
 *   stateReceipt：memory_write ↔ 任务域全部写工具（机器可读 ⟨state⟩ 终态行）
 *   TxAbort / runTaskTx：memory_write ↔ 任务域全链路（BEGIN IMMEDIATE 整段事务；业务中止转人话文案） */
/**
 * ★ A1 身份与认证层：短生命周期凭据（动态凭据 + 最小权限 scope + 可撤销信任）。
 * 签发/吊销/校验三态。credential 为随机 hex（randomBytes），绝不存口令、绝不参与命令拼接。
 */
function nowIso() { return new Date().toISOString(); }
function plusHoursIso(h) { return new Date(Date.now() + h * 3600_000).toISOString(); }
function isCredentialValid(row) {
    if (!row) return false;
    if (row.revoked_at) return false; // 已撤销（可撤销信任）
    if (row.expires_at && row.expires_at <= nowIso()) return false; // 过期
    return true;
}
/** ★ 2026-09-19（实操问题 #10）：写工具回执追加机器可读终态行（⟨state⟩ 单行 JSON）。
 *  人话回执曾掩盖「成功回执 + 零副作用」缺陷（supersedes 静默丢弃、release 卡侧静默失效）；
 *  统一终态行让调用方/自动化可逐字校验副作用是否落地。undefined/null 字段不输出。 */
function stateReceipt(o) {
    const slim = {};
    for (const [k, v] of Object.entries(o))
        if (v !== undefined && v !== null)
            slim[k] = v;
    return `\n⟨state⟩ ${JSON.stringify(slim)}`;
}
/** ★ 一致性①（2026-09-19）「记账一笔成」：任务链路的多步写（CAS 状态头 + 事件 + 卡片投影 + 租约）此前为
 *  逐条自动提交 —— 中途崩溃/锁失败即头-卡-事件三方分裂，只能等 5min 对账；且「稍后重试」会因 version 已 +1
 *  被 CAS 拒绝（重试进不去）。现统一用 withTx（BEGIN IMMEDIATE）包整段：要么全成、要么全不算；
 *  锁竞争由 withTx 整段重试（fn 只做 DB 写，重跑安全）。事务纪律：
 *  - 事务内业务中止（并发冲突需把人话文案返回给 agent 而非抛 MCP 错误）→ 抛 TxAbort，runTaskTx 捕获转文案；
 *  - 慢活绝不进事务：runTaskGate 子进程验收保持在锁外（先跑门控、后开事务写结果）；
 *  - 卡片投影保持 best-effort catch（投影失败留日志，源头以任务头为准，对账兜底）——不因投影失败回滚事实。 */
class TxAbort extends Error {
    constructor(msg) { super(msg); this.name = "TxAbort"; }
}
function runTaskTx(db, fn) {
    try {
        withTx(db, fn);
        return null;
    }
    catch (e) {
        if (e instanceof TxAbort)
            return e.message; // 业务中止：整体已回滚，把冲突文案交还调用方
        throw e; // 非业务错误：向上抛（MCP 层兜底）
    }
}

/* ── 工具注册：调用顺序 = REGISTERED_TOOLS 顺序，等价于原文件声明顺序；勿调整 ──
 *   memory → obsidian → task；执行面（file_read/file_write/exec_run）在其后按需追加。 */
const ctx = { db, AGENT, AGENT_FPATH, ENV_CRED, stateReceipt, runTaskTx, isCredentialValid, nowIso, plusHoursIso };
registerMemoryTools(server, ctx);
registerObsidianTools(server, ctx);
registerTaskTools(server, ctx);
registerGuideTool(server); // ★ 批次F1（P2-2）：工具详规按需查询（description 已一行化，对标 Orca 分片加载）

/* ── P0 执行工具面注册（方案 A：单 MCP 平面 + 模块分离）────────────
   只有 3 个工具 P0 上线；均自动被上面的 addTool 覆写包裹（try/catch + 风险前缀）。
   默认值（★ P0-2，用户拍板「决策1 (a)」）：**默认关闭执行面**，显式 MEMORYOS_EXEC_ON=1 才启用。
   与方案「P0 上线默认关闭、逐工具 opt-in」一致，也同向 B1「写操作先获同意」。
   既有 MEMORYOS_EXEC_OFF=1 作为显式熔断兜底，优先级最高（只要它=1 一律不启用）。 */
const _KERNEL_DIR = path.dirname(fileURLToPath(import.meta.url));            // .../resources/memoryos/dist
const _WORKSPACE_ROOT = path.resolve(process.env.MEMORYOS_WORKSPACE || path.join(_KERNEL_DIR, "..", "..", ".."));
const _DATA_DIR = path.dirname(DB_PATH);
const _EXEC_OFF = process.env.MEMORYOS_EXEC_OFF === "1";
const _EXEC_ON = process.env.MEMORYOS_EXEC_ON === "1";
if (_EXEC_OFF) {
    console.error("[exec] MEMORYOS_EXEC_OFF=1 —— 执行面已显式熔断，本次仅暴露记忆/任务工具");
} else if (!_EXEC_ON) {
    console.error("[exec] 执行面默认关闭（未设 MEMORYOS_EXEC_ON=1）—— 本次仅暴露记忆/任务工具；显式置 MEMORYOS_EXEC_ON=1 以启用 file_read/file_write/exec_run");
} else {
    for (const t of createExecTools({
        workspaceRoot: _WORKSPACE_ROOT,
        dataDir: _DATA_DIR,
        agent: AGENT,
        logAudit: (row) => logExecAudit(db, row),
    })) {
        server.addTool(t);
    }
    console.error(`[exec] 执行面已启用：file_read / file_write / exec_run（工作区 ${_WORKSPACE_ROOT}；artifact 落 ${path.join(_DATA_DIR, "artifacts")}）`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
// ★ 2026-09-19 --list-tools：单一事实源查询口——打印实际注册清单后退出。
//   不启动 stdio transport、不写 connect 心跳（这不是一次客户端连接）；模块加载期的
//   DB 打开/迁移与正常启动一致（幂等，无额外写）。stdout 走管道时 process.exit 可能截断缓冲，
//   故用写回调解 exit；输出加 ##TOOLS## 前缀防未来 stdout 污染（本文件现无 console.log）。
if (process.argv.includes("--list-tools")) {
    process.stdout.write("##TOOLS##" + JSON.stringify(REGISTERED_TOOLS) + "\n", () => process.exit(0));
} else if (isMain) {
    // 连接心跳：每次 server 被某个客户端 stdio 拉起时留痕（op=connect）。MEMORY_AGENT 由 MCP 配置 env 注入 → 可精确到"哪个 agent 连上了"
    try {
        appendEvent(db, {
            memory_id: null,
            op: "connect",
            payload: JSON.stringify({ agent: AGENT, agent_fpath: AGENT_FPATH, ts: new Date().toISOString() }),
            operator: `agent:${AGENT}`,
        });
    }
    catch {
        /* 心跳失败不阻断启动 */
    }
    await server.start({ transportType: "stdio" });
}
