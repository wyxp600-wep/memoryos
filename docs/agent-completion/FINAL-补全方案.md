# MemoryOS 补全为「完整 agent」· 最终方案（收敛定稿）

> 定稿人：主线程（DSH）｜日期：2026-09-15｜证据基准：`FACTS-PACK.md`（F1-F19 / B1-B3 / A1）
> 证据等级标注：【实测】= 本人独立复核（grep/活体协议/命令输出）；【专家】= 分域专家产出（关键项已抽查）；【待补】= 对应专家代理中止，本节由主线程依已核实事实补写。
> 全文遵守 B1（写操作先获同意）/ B2（WAL 严禁复制 .db，只走 VACUUM INTO）/ B3（改版只改呈现不改功能 / 改前时间戳快照）。

---

## 一、一句话结论

**MemoryOS 补全为完整 agent = 给 MCP 服务端加「执行工具面」+ 修 7 个行号级耦合缺陷，不是架构重写。**

依据 **A1【实测】**：`agent-core.js` 的 `runAgent()` 完全工具无关——`createMcpClient()` 用 `StdioClientTransport` 拉起 `server.js` → `tools/list` → `mcpToolsToOpenai()` 转 OpenAI tools → 循环「LLM ⇄ `mcp.callTool(name,args)`」。**MCP 服务端每多暴露一个工具，agent 自动就能调**；代价全部集中在门禁、schema、输出截断、上下文预算四处。

你原文里判断的「我是协调型 agent，要补全就是加执行型工具面」——**方向完全正确**，且比预想的更省：连 agent 循环都不用动。

---

## 二、五层能力矩阵（定稿）

| 层级 | 当前有什么（锚点） | 缺什么 | 补什么 | 优先级 |
|---|---|---|---|---|
| **感知** | 工具结果回灌（`agent-core.js:236-238`）；`task_next` 文本解析（`agent.js:78-99`）；onStep 事件流 | 无现场感知：读不了文件/日志/测试输出/git 态/DB 态；F3 头部截断丢尾部 | `file_read/grep/glob`、`git_status/diff/log`、`test_run`(只读模式)、`db_query`(SELECT-only)、`http_get`；F3 改 tail-aware | **P0**（文件/测试/git 只读）· P1（DB/网络） |
| **规划** | 任务队列 + 依赖拓扑（`task_next`）；maxSteps/去重护栏；收尾轮 toolsFilter（`agent.js:195`） | F4：`num_ctx=8192` 已装 18 工具 schema；F5：去重误杀合法重复；F17：toolsFilter 语义反转**使权限收窄失效** | 修 F17 → 阶段化工具面（感知轮=只读 / 执行轮=+写 / 收尾轮=只 `task_done`+`memory_write`）；F5 设豁免白名单 | **P1**（F17 属 P0） |
| **执行** | **零** —— 18 工具全在 memory/obsidian/task 域【实测】 | 文件/shell/测试/git/网络/DB/浏览器/编排八域全缺；F9 无沙箱/无 cwd 约束/无单调用超时 | 八域工具（§三）+ shell 子进程隔离 + cwd 白名单 + 每调用超时 | **P0**（四域）· P1 · P2（浏览器/编排） |
| **记忆** | 10 个 `memory_*` 工具 + 任务队列 + Obsidian 同步 + WAL/VACUUM 纪律 + bge-m3 本地向量（**核心优势**） | F8：任务正文与工具结果可携带指令注入；执行结论不自动沉淀 | F8 数据栅栏（untrusted 标记）；收尾提示可选 `memory_write`（≤200 字可复用结论）；F15 日志脱敏 | **P0**（F8 栅栏）· P1（F15） |
| **评估** | `memory_cite`（价值漏斗 R4）、`memory_feedback`（纠错闭环）、`report.js`、`arbitrate.js`、健康度/周报 | 执行结果无结构化证据字段（"测试通过"只是自然语言） | `task_done` 结论携带结构化证据（`{test:"34/34 passed", files:[...]}`）；**复用** report/arbitrate，不新建度量系统 | **P1** |

---

## 三、执行工具清单模板（定稿）

**风险级定义（L0-L4）**：L0 只读无副作用 / L1 工作区内变异（源码、项目文件）/ L2 工作区外变异 / L3 网络出站 / L4 特权（提权、系统级、DB 写）。
**审批策略**：`自动` = L0 直接放行；`必审` = 走 writeGate 单点（`agent-core.js:215-224`，F1 修好后由工具自声明风险级驱动）；`参数级` = 同工具内按参数细分（如 `git status` 放行 / `git push` 拒绝）。

| 域 | 工具 | 入参要点 | 返回契约 | 风险级 | 审批 | 超时 | 输出预算 | 记忆钩子 | 状态 |
|---|---|---|---|---|---|---|---|---|---|
| 文件 | `file_read` | `path, offset?, limit?` | `{lines[], total, truncated}` | L0 | 自动 | 5s | 8KB，超限落 artifact | — | **P0** |
| 文件 | `file_grep` | `pattern, path?, include?` | `[{file,line,text}]` | L0 | 自动 | 15s | 8KB + 落盘指针 | — | **P0** |
| 文件 | `file_glob` | `pattern, path?` | `[path]` | L0 | 自动 | 5s | 2KB | — | P1 |
| 文件 | `file_write` | `path, content, backup?=true` | `{ok, backupPath}` | L1 | **必审** | 10s | diff 摘要 | 改前自动时间戳备份 | **P0** |
| 文件 | `file_edit` | `path, old, new, replace_all?` | `{ok, replaced}` | L1 | **必审** | 10s | diff 摘要 | 同上 | P1 |
| shell | `exec_run` | `cmd[], cwd?, timeout_ms?` | `{exit, stdoutHead/Tail, stderrHead/Tail, ms, truncated, artifactPath}` | L1/L2 | **必审** | 默认 30s | 4KB（头/尾双端） | — | **P0** |
| shell | `shell_poll` | `jobId, lines` | `{alive, tail}` | L0 | 自动 | 3s | 4KB | 去重豁免成员 | P1 |
| 测试 | `test_run` | `cwd?, cmd?, args?` | `{exit, passed, failed, errors[], tail}` | L1 | 必审（首版） | 300s | 8KB + artifact | 结果回写任务卡验收字段 | P1 |
| git | `git_status/diff/log` | `cwd?` | 文本 | L0 | 自动 | 10s | 4KB | — | P1 |
| git | `git_commit` / `git_backup` | `cwd?, msg, tag?` | `{commit, tag}` | L1 | **必审** | 15s | 回执 | 改前回滚点（B3 工具化） | P1 |
| git | `git_rollback` | `tag` | 回执 | L2 | **必审+双确认** | 15s | 回执 | 代码回滚唯一入口 | P1 |
| 网络 | `http_get` | `url, headers?` | `{status, bodyTail}` | L3 | **域名白名单**（默认空=全拒） | 30s | 4KB + artifact | — | P1 |
| 网络 | `http_post` | `url, body` | `{status, bodyTail}` | L3 | **必审** | 30s | 4KB | — | P1 |
| DB | `db_query` | `sql`（服务端强制 SELECT-only） | `{rows, n}` | L0 | 自动 | 15s | 200 行 × 8KB | 只读连接，无写路径 | P1 |
| DB | `db_snapshot` | `keep?=7` | `{path, size}` | L1 | **必审** | 120s | 回执 | **B2 唯一合规备份** | P1 |
| 浏览器 | `browser_open/snapshot/shot` | `url, ref?, path?` | 文本/路径 | L0-L2 | 分级 | 30s | 2KB + 截图落盘 | 独立 profile，**不继承已登录会话** | P2 |
| 浏览器 | `browser_act` | `ref, kind, value?` | `{ok}` | L2 | **必审** | 30s | 2KB | — | P2 |
| 编排 | `agent_status` / `task_cancel` / `task_brief` | `project?` / `memory_id, reason` | 行列表/回执 | L0/L1 | 自动/必审 | 5s | 4KB | 复用既有 task_* 队列 | P2 |
| 编排 | `task_spawn_subagent` | 子卡字段 | 子卡摘要 | L1 | **必审** | 10s | 4KB | 子任务树进队列 | P2 |

**明确不做（YAGNI，架构师定稿）**：容器级隔离 / 第二 MCP 或 RPC 通道 / 全套 Playwright 级浏览器 / 内核内 subagent 生成器与分布式调度 / 新 GUI 审批平面 / 新度量系统 / email·calendar·IM 类集成。
理由：本机单用户场景下边际收益≈0，且每一项都新增出站与外泄面；编排限定在既有队列语义内（#4073/#4129 在队列侧协同）。

---

## 四、P0 开工序（顺序不可颠倒）

**0-A【实测·阻断】git 回滚能力缺口（F18）**
`git status` 实测：`agent-core.js`、`agent.js`、`smoke-agent.js`、`secret-store.js` 全为 `??` untracked，仅 `server.js` 为 ` M`。⇒ 你既有的回滚纪律「代码回滚走 git 提交/tag」**对 P0 要改的文件不成立**。
处置：`git add` 全部改动 → checkpoint commit → 打新 tag → 按 B2 建 `data/memory.db.pre-exec-<ts>`（VACUUM INTO，**严禁复制 .db**）。

**0-B【实测·阻断】过期断言（F16）**
`smoke-mcp.js:77` 断言 17 工具（白名单漏 `task_supersede`），`smoke-agent.js:49` 断言 18，活体实测 **18**【实测】。专家实跑：**13 PASS / 1 FAIL，exit 1**。
且是双重错误 + `&&` 短路 ⇒ 只改计数仍 FAIL。处置：修 :77（计数 18 + 名单补 `task_supersede`）+ 补 `smoke-all.js` 聚合 runner。**不修则 P0 验收标准不可满足**，且新工具上线后无法区分「陈旧噪声」与「真实注册缺失」。

**0-C【实测·条件触发】** 若要动 `preload.js` / `welcome.html` / 托盘图标（做 IPC 或审批 UI 几乎必然碰到）
这 5 个条目是 **asar-only**：不在工作树、不在 git。`pack-asar.js` 是**补丁器**（只热替换 `SYNC_FILES` 4 个文件：`/main.js`、`/services/core-process.js`、`/window/tray.js`、`/services/updater.js`）。
处置：把路径加进 `pack-asar.js:17` 的 `SYNC_FILES` + 落树内副本 + `git add -f`。

**P0 实质范围（2~3 人日）**：最小执行面 3 工具（`file_read` 自动 / `file_write` 必审 / `exec_run` 必审+命令 allow-list+cwd 约束+超时）+ 门禁修复 + `exec_audit` 审计表。
改动 7 文件：`agent-core.js`（F1/F2/F3/F17）、`agent.js`（F7/F8）、`server.js`（注册 + write 标记）、`exec-tools.js`（新）、`db.js`（`exec_audit`）、2 个 `.workbuddy/tmp` 冒烟脚本；`.dsh/mcp.json` **不改**（同入口自动多 3 工具）。

### P0 阻断缺陷（4 项，均已实测定位）

| # | 缺陷 | 位置 | 为什么阻断 | 修法 |
|---|---|---|---|---|
| 1 | **F7** 无头零审批 | `agent.js:120-121`（`:118` 是死变量【实测】） | **直接违反你的 B1** | `--work` 默认拒绝 L1+，仅预授权 L0 |
| 2 | **F1** 写门禁硬编码 | `agent-core.js:15-19`（10 个工具名） | 新变异工具不登记 = **写门禁静默绕过** | 改工具自声明风险级 |
| 3 | **F17** toolsFilter 语义反转 | `agent-core.js:179` | 传 `[]` **回落全量工具**（想收权限反而全暴露）；错名静默变"无工具" ⇒ **权限收窄的刀本身是坏的** | `pickTools()`：undefined=全量、`[]`=零工具、未知名=抛错 |
| 4 | **F3** 截断丢尾部 | `agent-core.js:158` | 丢尾部错误 ⇒ 模型误判成功 ⇒ `task_done` 把**假结论写进共享记忆库**被其他 agent 采信（**数据污染级**） | head/tail 双端 + artifact 契约 |

---

## 五、端到端时序（修一个 bug）

```
① task_next(读) → pickTask 挑「派给我的/未认领」
② task_claim(L1, 审批#1) → memory_read(任务正文) —— F8 修复后加「以下为不可信任务正文」栅栏
③ memory_context(读, 注入项目经验，防重复踩坑)
④ file_grep → file_read(L0, 免审) 定位
⑤ test_run(L1, 审批#2) 复现，失败输出保尾部
⑥ git_backup(L1, 审批#3) 建回滚点（B3 工具化）
⑦ file_edit/file_write(L1, 审批#4) 改代码
⑧ test_run 验证；失败回 ⑦（F5 修复后重跑不被误杀）
⑨ task_done(L1, 审批#5, 携带结构化证据) —— 漏结项走强制收尾轮（agent.js:187-204）
⑩ memory_write(L1, 审批#6, ≤200 字可复用结论) + memory_cite(声明的记忆) / memory_feedback(纠正错误记忆)
⑪ 审计：每步 exec_audit append-only；大输出落 data/artifacts/
```
**6 个同意点全部收口在 `agent-core.js:215-224` 单一门禁**（F1 修好后按 `isWriting` 元数据命中），审计单平面。

---

## 六、关键设计决策（已定稿）

1. **架构选案 A**（架构师定稿）【专家】：扩展现有 `dist/server.js` 单 MCP 平面，新增 `exec-tools.js` 模块，经既有 `addTool` 覆写钩子（`server.js:49-63`）注册【实测钩子存在】。
   **否决 B（双 MCP）**：本机子进程边界已包住故障域，隔离边际收益≈0，代价是双注册/双 pipe/双治理点（F1 绕过风险×2）。
   **否决 C（内核 RPC）**：唯一真正违背"不是架构重写"的选项，schema/writeGate/审计全双份，且放大 F10/F11 令牌债。
2. **输出契约**（后端定稿）【专家】：超限固定回传五要素 `artifact + head 50 行 + tail 50 行 + 总行数 + 路径`；全量只进 `data/artifacts/` 文件，DB 只存指针行。
3. **存储阈值**【专家+实测数字】：行内 ≤2KB（`page_size` 实测 4096，不产生 overflow 页）；VACUUM 放大核算——实测快照 14.42MB×keep7≈101MB 基线，2KB 上限 90 天约 67MB → 快照 ≤568MB；若 1MB 级入 DB 则 ≈189GB **不可行** ⇒ 大文本必须外置。
4. **审计可靠性**（DB 可靠性定稿）【专家】：三张附加式表（`tool_call_audit`/`approvals`/`artifacts`）+ 触发器 `RAISE(ABORT)` + JS 端 sha256 哈希链（`node:sqlite` 禁 `load_extension`，SQL 内无内建哈希）+ 链头外置锚；关键审计走专用 `synchronous=FULL` 连接（默认 NORMAL 有 fsync 丢失窗口）；备份零改动（新表自动入每日 VACUUM INTO + 7 份轮转）。
5. **降级开关**（工程效率定稿）【专家】：`MEMORYOS_EXEC_OFF=1` 全局熔断 → 工具级禁用 → config 热更；**P0 上线默认关闭执行面、逐工具 opt-in**。

---

## 七、待你拍板的决策

**决策 1（必须）：`--work` 无人值守模式下，L1 是否预授权？**
- 背景：`task_done`、`task_claim`、`memory_write` 本身都是 L1。若 L1 一律拒绝，`--work` **无法自行认领与结项，功能直接不可用**（等于废掉任务队列自主模式）。
- 三个选项：(a) **L1 预授权、L2+ 拒绝**（保住自主闭环，风险=无头模式下可改工作区内文件）；(b) **L1 也拒绝**（最安全，但 `--work` 不可用，需改为纯人工驱动）；(c) **L1 预授权 + 白名单工具集**（如仅 `task_*`+`memory_*` 预授权，执行类 L1 仍拒绝）——**我推荐 (c)**，它同时满足 B1 精神与自主性。
- 代码审查专家指出：此项不定，P0 补丁的最终形态无法确定。

**决策 2（可选）**：`test_run` 首版是否免审？架构师建议自动（只读语义），但它会写测试缓存/产物 → 我方建议**首版必审**，稳定后再降级。

**决策 3（可选）**：执行面首个上线环境是否直接是生产库？建议先在 `data/memory-mcp-smoke.db` 临时库跑通全部验收再切生产。

---

## 八、分批路线

| 批次 | 内容 | 工作量 | 验收 |
|---|---|---|---|
| **P0** | 开工序 0-A/0-B(/0-C) + 最小执行面 3 工具 + F7/F1/F17/F3/F2 修复 + `exec_audit` | 2~3 人日 | `list-tools` 21 工具；`smoke-mcp` 全 PASS；`smoke-exec` 5 断言全绿（含"无审批写必拒""危险命令必拒""审计 ≥3 行"）；`agent.js -m` 出现 `✍/✋` 门禁；`--work` 写工具默认拒绝 |
| **P1** | 测试/git/网络/DB 四域工具 + `exec-config` 白名单 + dashboard 执行审计页签 + 能力矩阵补全 | 3~5 人日 | 每工具一条冒烟断言；白名单外 URL 必拒；`db_query` 的 `DELETE` 必拒 |
| **P2** | 浏览器域 + 双路径编排（#4073/#4129）+ 评估闭环 | 5~10 人日 | 浏览器自点 8787；一条任务在 DSH subagent 与 `--work` 队列各跑一遍不串台；三指标连续 7 天可查 |

---

## 九、证据等级与缺口（诚实标注）

| 分域 | 状态 | 备注 |
|---|---|---|
| 事实基准 FACTS-PACK（F1-F19） | 【实测】 | 每条经 grep / 活体协议 / 命令输出复核 |
| 软件架构 / 后端 / 代码审查 / DB可靠性 / DB性能 / 工程效率 / 前端 | 【专家】已交付并抽查 | 7 份文档见本目录 |
| **安全（威胁建模 + L0-L4 门禁）** | ⏳ **仍在运行** | 已收到 2 条早期核实（F14 证实、工作树文件核实），完整文档未落盘 |
| **桌面（Electron 侧落地）** | ❌ **代理中止，无产物** | 本方案中桌面相关结论（F10/F11/F19、webPreferences、IPC sender 校验）由主线程基于【实测】事实给出；**进程归属选型、Windows 细节、崩溃恢复仍需补做** |

**补齐建议**：安全与桌面两份可直接以现有事实包为输入重跑（一个 subagent 1 路即可），或由你先看本方案定稿再决定是否补。

---

## 十、文档索引

| 文件 | 内容 |
|---|---|
| `FACTS-PACK.md` | F1-F19 行号级事实 + B1-B3 硬约束（**唯一事实基准**） |
| `expert-软件架构.md` | 五层矩阵 + A/B/C 选型 + 八域工具表 + YAGNI |
| `expert-后端架构.md` | 声明式注册表 + 七环中间件 + exec-runner 进程模型 + 五类失败模板 |
| `expert-代码审查.md` | F1-F15 逐条核实 + F16/F17 实测 + 37 条 checklist（994 行） |
| `expert-数据库可靠性.md` | 三表 DDL + 触发器 + 哈希链 + 崩溃对账 + 三腿回滚（478 行） |
| `expert-数据库性能.md` | 索引设计 + 2KB 阈值 + VACUUM 放大核算 + FTS5 收窄 |
| `expert-前端.md` | V1-V6 组件 + SSE 推送 + 审批三键 + 虚拟滚动 |
| `expert-工程效率.md` | 30 分钟上手 + 冒烟模板 + P0/P1/P2 + 降级开关 |
| `INDEX.md` | 导航（本文件为其定稿版） |
