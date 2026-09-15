# MemoryOS 完整 agent 补全 · 收敛文档（INDEX + 能力矩阵 + 工具清单模板）

> 状态：收敛中。专家分域产出见本目录 `expert-*.md`（9 份）。事实基准见 `FACTS-PACK.md`（F1-F15 / B1-B3 / A1）。
> 原则：结论先行 · 最小改动 · 符合用户三条硬约束（B1 写操作先获同意 / 改版只改呈现不改功能 / 改前时间戳备份；B2 WAL 下严禁复制 .db、只走 VACUUM INTO）。

## 一句话结论

**MemoryOS 补全为完整 agent = 给 MCP 服务端加「执行工具面」+ 修掉 5 个行号级耦合缺陷，不是架构重写。**
依据 A1：`agent-core.js` 的 `runAgent()` 完全工具无关（`tools/list` → OpenAI tools → `mcp.callTool` 循环）。
服务端每多暴露一个工具，agent 自动就能调；代价全部集中在门禁（F1/F7）、schema 透传（F2）、输出截断（F3）、上下文预算（F4）四处。

## 五层能力矩阵（基线版，待专家修订后定稿）

| 层级 | 当前能力 | 缺口 | 补什么 | 优先级 |
|---|---|---|---|---|
| 感知 | 只有记忆/任务/看板视图 | 无日志、无仓库、无 CI、无监控入口 | `repo_grep`、`repo_read`、`repo_list`（长上下文项目导航）；`http_get` 拉 CI/监控 JSON | P1 |
| 规划 | 任务队列 + 依赖拓扑（task_next） | 无自动任务生成、无风险预判 | 任务卡附「执行计划草案」字段；规划轮用 toolsFilter 只给只读工具（F4 钩子） | P1 |
| 执行 | **基本没有** | 缺 shell/文件/patch/测试/网络/DB/浏览器 | 八组执行工具（下表），带风险分级审批（L0-L4） | **P0** |
| 记忆 | 很强（18 工具全在记忆/任务/Obsidian 域） | 执行结论未自动回写 | 执行完成自动 `memory_write`（可复用结论）+ `task_done`（结项）+ artifact 落审计表 | P0 |
| 评估 | 有健康度/周报（memory_report/health） | 无自动闭环验证 | 任务卡挂验收命令（测试/断言脚本），daemon 定期重跑；失败进任务队列 | P2 |

## 八组执行工具清单模板（P0 = 首批必做）

| 组 | 工具 | 风险级 | writeGate | 输出预算 | 备注 |
|---|---|---|---|---|---|
| 文件 | `file_read` / `file_list` / `file_grep` | L0 只读 | 否 | 4KB，超限落 artifact | 路径必须在 workspace allowlist 内 |
| 文件 | `file_write` / `apply_patch` | L1 工作区变异 | **是（P0 修复 F1 后生效）** | 回传 diff 摘要 | 改前走 B2 快照纪律（DB 域改动） |
| shell | `shell_run`（禁 shell:true 拼接，参数数组 + 允许命令前缀白名单） | L1/L2（工作区内 L1，外 L2） | **是** | 超时 120s，stdout+stderr 各留 head/tail，全量落 artifact | Windows 进程树 kill（taskkill /T /F） |
| 测试 | `test_run`（`shell_run` 的薄封装：固定 cwd + 项目测试命令 + 解析 pass/fail） | L1 | 是 | 同上 + 结构化 {passed,failed,errors[]} | 结果回写任务卡验收字段 |
| git | `git_status/diff/log/show`（只读组） | L0 | 否 | 4KB | — |
| git | `git_commit/branch`（工作区内） / `git_push`（网络域） | L1 / L2 | 是 | 回执 | push 默认拒绝，参数级策略 |
| 网络 | `http_request`（域名白名单、禁私网/169.254.169.254、超时 30s） | L3 | 是 | 响应体 8KB，超限落 artifact | 云端 LLM 切换时出境面需安全专家过审 |
| 数据库 | `db_query`（对 memory.db **只读连接**，禁 PRAGMA/ATTACH/VACUUM/写 DDL） | L0 读 / L4 写 | 写=否（不提供） | 200 行 × 8KB | 与 B2 备份纪律隔离：审计/快照只走 daemon 既有通道 |
| 浏览器 | `browser_*`（Playwright/CDP，独立 profile 不继承已登录会话） | L2/L3 | 是 | 截图落 artifact + 快照文本 | P2 |
| 编排 | `task_spawn_subagent`（子任务树：拆子卡进任务队列，父卡挂验收） | L1 | 是 | 子卡摘要 | P2；复用现有 task_* 队列，不新造 |

> 明确不做（YAGNI）：email/calendar/slack 类 IM 集成、部署/回滚编排、通用 RPA 宏。
> 理由：超出「开发-运维-复盘」本地场景，且每个都是新的出境/外泄面。

## P0 阻断项清单（不修则执行面不能上线）

**开工前置（顺序不可颠倒，2026-09-15 代码审查实锤）**
0-A. **F18** `agent-core.js`/`agent.js`/`smoke-agent.js` 均 **untracked**，git 回滚对 P0 目标文件不成立 → 先 `git add` 全部改动 → checkpoint commit → 打新 tag → 建 `data/memory.db.pre-exec-<ts>`（VACUUM INTO）
0-B. **F16** `smoke-mcp.js:77` 陈旧断言（17→18 且白名单漏 `task_supersede`，`&&` 短路致只改计数仍 FAIL）→ 修断言 + 补 `smoke-all.js` 聚合 runner，否则验收标准不可满足
0-C. **F19** 若 P0/P1 要动 preload / welcome / 托盘图标面：这 5 个条目是 **asar-only**（不在工作树、不在 git）。`pack-asar.js` 是**补丁器**而非构建脚本，只热替换 `SYNC_FILES` 4 个文件（`:17`/`:130`）→ 须先把路径加进 `SYNC_FILES` + 落树内副本 + `git add -f`，否则改不动、无 git 回滚、只能从 asar 反向提取

**执行面阻断项**
1. **F7** `agent.js:120-121`（生效点）`--work`/`--auto-write` 门禁默认 null 全放行 → 默认拒绝 L1+，仅预授权 L0；顺带删 `:118` 死变量
2. **F1** `agent-core.js:15-19` WRITE_TOOLS 硬编码 10 个工具名 → 改为工具自声明风险级（后端/安全专家方案定稿）
3. **F17** `agent-core.js:179` `toolsFilter?.length` 语义反转（`[]` 回落全量 = 权限放大）+ 错名静默无工具 → 改 `pickTools()` 严格语义 + `tool_face` 事件
4. **F3** `agent-core.js:158` 3000 字符 head-only 截断丢尾部 → head/tail 双端 + artifact 契约。**注意级联伤害**：丢尾部错误 ⇒ 模型误判成功 ⇒ `agent.js:181` 触发 doneSeen ⇒ `task_done` 把**假结论写进共享记忆库**被其他 agent 采信（数据污染级，非体验级）

**P1（顺带修）**：F2 顶层 schema 关键字透传 + 新工具侧 `pickArgs(args, ALLOWED)` 白名单化（把校验职责从声明式 schema 搬到命令式实现）；F10/F11 令牌硬化（safeStorage + 一次性 code 换 header token）；F4 阶段化工具面；F5 去重键 `stableStringify` + 分级预算 + `exec_run` 排除 seq/timeout_ms；F8 数据栅栏；F15 日志脱敏。

**待用户拍板的产品决策**：`--work` 无人值守模式下 **L1 是否预授权**——`task_done` 本身是 L1，若一律拒绝则 `--work` 无法自行结项、直接不可用（见 expert-代码审查.md §6）。

**P0 具体范围（工程效率定稿，2~3 人日，详见 expert-工程效率.md §3）**：
最小执行面 3 工具（`file_read` 自动放行 / `file_write` 必审 / `exec_run` 必审+命令 allow-list+cwd 约束+超时）+ F7 无头门禁修复 + `exec_audit` 审计表。
改动 7 文件：agent-core.js（F1/F2/F3/F4/F14）、agent.js（F7/F8 栅栏标记）、server.js（注册 3 工具 + write 标记）、exec-tools.js（新，三工具实现）、db.js（exec_audit 表 + logExecAudit）、.workbuddy/tmp/smoke-exec.mjs + audit-probe.mjs（新）；`.dsh/mcp.json` **不改**（同入口自动多 3 工具）。
上线默认 `MEMORYOS_EXEC_OFF=1` 熔断执行面、逐工具 opt-in（三层降级开关见 expert-工程效率.md §5.2）。
开工前置：checkpoint commit + 新 tag（工作树 22 个未提交改动，旧 tag 已过期）+ B2 时间戳快照。

## 接线时序（修一个 bug，端到端）

```
task_next(读) → task_claim(L1,审批) → memory_context(读,拉项目记忆防重复踩坑)
→ file_grep/file_read(读,定位) → apply_patch(L1,审批) → test_run(L1,审批,结果落 artifact)
→ 失败: 回灌 head/tail 继续修;  成功: task_done(L1,结项+结论)
→ memory_write(L1,可复用结论≤200字,含命令/路径/数值) → daemon 周报引用该卡健康度
→ 审计: 每步 tool_call_audit append-only(哈希链), artifact 存 data/artifacts/
```

## 文档索引

| 文件 | 产出方 | 内容 | 状态 |
|---|---|---|---|
| FACTS-PACK.md | 勘察 | F1-F15 行号级缺陷 + B1-B3 硬约束（事实基准） | ✅ |
| expert-软件架构.md | 软件架构师 | 五层矩阵 + A/B/C 选型 + 工具域 | ✅ 已核对（addTool 钩子 server.js:49-63、18 处注册点属实） |
| expert-后端架构.md | 后端架构师 | 注册表/middleware/进程模型/失败语义 | ✅ 已核对（exec-runner 进程模型、七环中间件、5 类失败模板；带来 3 处事实包修正已回写 FACTS-PACK：WRITE_TOOLS 实为 10 工具、F14 死代码是 :118 writeGate、server.js:41「16 工具」注释过期） |
| expert-安全.md | 安全工程师 | 威胁建模 + L0-L4 门禁 + 验收清单 | ⏳ |
| expert-代码审查.md | 代码审查工程师 | F1-F15 逐条确认 + 补丁级修复 + 37 条 checklist | ✅ 已核对（独立实测锤下 F16 双重错误 + 新增 F17 toolsFilter 语义反转 + F18 git 纳管缺口；F2 定性修正为「运行时已丢失但当前无害、触发条件=参数进 exec/路径汇点」；F5 修正为 runAgent 内局部持久） |
| expert-桌面.md | 桌面应用工程师 | Electron 侧落地 + Windows 细节 | ⏳ |
| expert-数据库可靠性.md | DB 可靠性工程师 | 审计表可靠性 + 备份纪律延伸 | ✅ 已核对（db.js:5/:347/:354/:707 行级主张全部属实；三表附加式 DDL + 触发器 + JS 哈希链 + 三腿回滚方案成立） |
| expert-数据库性能.md | DB 性能工程师 | schema/索引/artifact 存储阈值 | ✅ 已核对（3 复合索引 + 2KB 行内阈值（page_size 实测 4096）+ VACUUM 放大核算 14.42MB×7≈101MB + FTS5 收窄方案；勘误：FTS5 实现在 db.js 而非 search.js，search.js 仅 RRF 层） |
| expert-前端.md | 前端开发者 | 看板执行可视化 + 审批 UI | ✅ 已核对（修正事实：UI 真身是 memoryos-dashboard-redesign/{index.html,app.js}，经 resolveUiDir 伺服；SSE 推送 + 审批三键 + 虚拟滚动方案落位） |
| expert-工程效率.md | 工程效率工程师 | P0/P1/P2 分批路线 + 30 分钟上手 | ✅ 已核对（daemon_log db.js:60、/api/audit dashboard.js:1085、默认库 server.js:17、基线 tag + 22 个未提交改动均属实） |
