/**
 * ★ 批次F1（P2-2 工具描述分页，对标 Orca kernel 常驻 + references 按动作门加载）：
 * 握手常驻的 description 已压成一行（动作门 + 硬约束词），完整详规按需经 tool_guide(name) 取。
 * TOOL_GUIDES 值 = 压缩前的完整原文（2026-10-03 保真搬移快照）。
 */
import { z } from "zod";
export const TOOL_GUIDES = {
    "memory_write": "写入一条共享记忆（自动做向量嵌入与去重/冲突预检）。适用时机：>30min 修复 / 技术决策 / 隐藏约定 / 第三方坑。",
    "memory_search": "语义+关键词混合检索共享记忆（RRF 融合，scope 隔离）。适合新任务前 / 改核心模块前 / 遇报错时。跨表述召回：写'时间戳容差5min'，查'签名校验失败'也能命中。",
    "memory_ask": "记忆库问答（RGA：Retrieve→Generate）。检索命中记忆后，让 LLM 仅基于这些记忆生成答案，每条结论标注引用来源 [#记忆ID]，禁止编造记忆之外的内容。适合『直接要答案』而非『要原始记忆列表』的场景：如问本库沉淀过什么结论/踩坑/约定。需要原始命中列表仍用 memory_search；本工具为只读，不写库。",
    "memory_projects": "列出记忆库所有可用 project 及各自记忆条数。memory_search 的 project 参数取值以此为准；scope 不确定时先看一眼再决定搜哪个。避免因不知道存在某 project 而漏检。",
    "memory_context": "会话开始/执行关键任务前调用一次：一键拉取当前项目的高价值记忆摘要注入上下文，省去多次 memory_search。返回：①当前 scope 的 Top-N 高价值记忆（按引用/曝光/命中排序）②可用 project 清单 ③当前 agent 身份。适合『开工前先注入相关记忆』的场景——避免只写不搜（R1 闭环）。",
    "memory_read": "按 id 读取单条记忆的**完整正文**（不受 memory_search 的 220 字截断限制）。适合：search 命中的片段想展开看全文、需要精确引用记忆细节时。返回全文 + 类型/来源/置信/创建时间。",
    "memory_feedback": "对一条记忆标记『已过时/有误』——纠错闭环。Agent 发现记忆内容已过期或不正确时调用，把该记忆 soft-reject（status=rejected，不再进入检索；不物理删除、可追溯审计）。区别于 memory_cite（正向采用）与 memory_write（新增沉淀），本工具是负向修正通道。",
    "memory_cite": "声明实际采用了某条记忆（价值漏斗最后一环，R4）。Agent 在落地方案/修改代码引用到记忆内容时调用；同一任务结束后通常触发一次 write 可被记为 inferred-cited，此工具提供显式的 raw-cited。",
    "memory_credential": "A1 身份认证层：签发/吊销/校验 agent 的短生命周期凭据（最小权限 scope=read/write/admin，默认 1h 到期，可撤销）。action=issue 签发新凭据；action=revoke 撤销指定凭据（凭据值或 agent）；action=verify 校验某 agent 当前是否持有有效凭据。凭据为随机 hex，审计留痕（memory_events）。",
    "memory_report": "周报五查询（价值度量）。funnel=漏斗(w/r/cited/inferred，含 R4 下界口径)；trend=每日 w/r/c 三线；top=高价值 Top；zombies=待归档僵尸；cross_tool=跨工具复用。适用于周报/复盘。",
    "memory_health": "查看记忆库『使用侧健康度』（效果监控）：近 N 天 search/write/returned/cited 次数、检索触发率(search/write)、空召回率、写读比，以及各 agent 的使用漏斗。用于诊断『只写不搜』（触发率→0/搜索趋零）和各工具是否真正在用记忆。",
    "task_gate": "多 Agent 协同·确定性验收门：查看任务的 [gate:预设] 声明与最近一次验收结果。预设白名单（lint-sql/lint-catch/smoke-mcp/smoke-task/smoke-p26/snapshot）——task_done 会先跑该验收，通过才 done，失败 fail-closed 回退 pending（E-0 后无 review 态）。",
    "task_assign": "多 Agent 协同：把任务交给指定 Agent（写 type='task' 记忆，状态 open）。depends_on 声明依赖（逗号分隔），依赖全 done 后本任务才可做；对方用 task_claim 领取、task_done 完成、task_next 查可做集。默认同步建任务地图卡（create_card=true），卡片流转回写 memories 状态头。",
    "task_delegate": "A2A 委派层：把任务对等委派给另一个 agent（A2A agent-to-agent）。内部建 task_assign 任务并打 [a2a] 协议标记；若目标 agent 无有效凭据（A1 认证层）则拒绝委派（fail-closed）。可选声明验收门 gate（P3，task_done 时确定性验收）。",
    "task_claim": "多 Agent 协同：领取『分配给我/未认领』的 pending 任务，状态头 pending→in_progress；不传 memory_id 则列出可领列表。as：缺省=本人（仅领指派给自己或 assignee=? 的）；as=<他人名> 仅限恰指派该名；as='any'=托管认领，跳过接收方校验可领任何 pending，改写归属须携 scope>=write 凭据。租约默认 10 分钟，lease_minutes 可延长。",
    "task_heartbeat": "多 Agent 协同·租约（C-2）：对进行中任务的关联卡片刷新租约窗口（默认 10 分钟，C-3；lease_minutes 可分级 10..120），防止长跑任务被守护回收。调用方应为当前认领者（身份可传 as，仅限本人任务）。无关联卡片（纯任务）时仅记事件。",
    "task_release": "多 Agent 协同·租约（C-2）：释放认领 —— 任务状态头 in_progress → pending（重新可被认领），关联卡片 running → ready 并清租约锁。仅当前认领者（或 human 兜底）可释放。",
    "task_block": "多 Agent 协同·租约（C-2）：把任务标记为受阻（状态头 → blocked，原因留痕）；关联卡片同步 blocked。受阻任务不进可做集；恢复走 task_reopen 或重新认领。",
    "task_reopen": "多 Agent 协同·租约（C-2）：重开已终态任务（done/failed/cancelled → in_progress，重新指派）；关联卡片 done → ready。E-0 裁决口径：reopened 为派生态（展示层），持久态落回白名单。",
    "task_done": "多 Agent 协同：把已认领/待办任务标记为完成（状态头 → done），并把结论追加进任务正文。调用方应为当前认领者或任务接收方。",
    "task_verify": "多 Agent 协同·第三方验收关闭：任务实际已完成但任务头未闭环时，验收方直接把状态头置 done——不改 assignee（归属保留）、不发租约、不写 claim 事件，只写 task_verify 事件（verified_by 留痕），消除「为收口伪造 task_claim」的审计污染。不走 [gate] 门控，验收依据在 reason 留痕。",
    "task_supersede": "多 Agent 协同·去重归档：把一条重复任务标记为「被另一条取代」——状态置 merged + superseded_by=主任务 id。用于跨链路重复（如 dispatcher 卡片派生 与 task_assign 直写 双套）；被并的任务移出可做集、不污染正文、可经 superseded_by 追溯主任务。",
    "task_next": "多 Agent 协同·依赖拓扑：给当前 agent 算出『现在可做的开放任务』（依赖拓扑的入度=0 集）。open 且所有 depends_on 依赖均已 done 的任务才可做；被依赖未完成的任务标记 blocked 并说明卡在哪个依赖。同时列出本人名下已认领/在做的任务。",
    "obsidian_import": "把 Obsidian vault 的 .md 笔记增量导入共享记忆库（幂等：按内容哈希，不变跳过/变更更新/新增入库，agent=obsidian，project 默认取 vault 目录名）。适合把本地笔记/知识库沉淀为可检索记忆。",
    "obsidian_export": "把记忆库中 active 记忆导出为 Markdown 笔记（带溯源 frontmatter），写入 vault/MemoryOS 导出/，幂等不覆盖。适合把高价值记忆沉淀回 Obsidian 复盘。",
    "obsidian_write_note": "往 Obsidian vault 写单条笔记（带溯源 frontmatter），同时同步写入共享记忆库（去重预检 + 埋点），并记录 obsidian_sync 元表映射。文件已存在时加时间戳后缀，绝不覆盖。适用：Agent 把修复结论/技术决策/隐藏约定沉淀回 Obsidian 笔记库。",
};

export function registerGuideTool(server) {
    server.addTool({
        name: "tool_guide",
        description: "按需获取任意 MCP 工具的完整详规（各工具 description 已瘦身为一行；踩坑、拿不准参数、看不懂回执时调用）。未知名返回全部可用清单。",
        parameters: z.object({
            name: z.string().describe("工具名（如 task_done / memory_search）"),
        }),
        async execute(args) {
            const guide = TOOL_GUIDES[String(args.name ?? "").trim()];
            if (guide)
                return `【${args.name} 详规】
${guide}`;
            return `未知工具名「${args.name}」。可用：
` + Object.keys(TOOL_GUIDES).join("、");
        },
    });
}
