# MemoryOS 补全为完整 agent · 软件架构专家意见

> 结论先行（四条 TL;DR）：
> 1. **执行工具面选方案 A**：在现有 `dist/server.js` 单 MCP 平面上按「模块分离」方式追加八域执行工具（新增 `exec-tools.js`，经 `server.js:49-63` 的 `addTool` 钩子注册），agent 侧只做 F1–F7 缺陷修复，**不动 agent 循环架构**（A1：`runAgent()` 完全工具无关，agent-core.js:174-247）。方案 B（双 MCP）与方案 C（第二协议通道）否决，理由见 §2.3。
> 2. **P0 必做三件事**：修 F7（`--work`/`--auto-write` 下 gate=null 零审批，agent.js:118-121，直接违反 B1）；WRITE_TOOLS 由硬编码 Set（agent-core.js:15-19，F1）改为**注册期元数据驱动**（每个工具声明 `isWrite`）；核心执行四域工具（文件/shell/测试/git）+ 每调用超时与 cwd 白名单（修 F9）。
> 3. 五层能力矩阵：感知/执行层 P0，规划/记忆/评估层 P1，浏览器域与编排扩展 P2。详见 §1。
> 4. 明确不建的：容器级隔离、第二 MCP/RPC 通道、全套浏览器自动化、内核内 subagent 生成器、新 GUI 审批面板——YAGNI 清单见 §5。

证据基础：FACTS-PACK（2026-09-15 核实）+ 本专家当日复读 `agent-core.js`（247 行全文）、`agent.js`（252 行全文）、`server.js` 注册结构（`addTool` 覆写于 :49-63，18 处 `addTool` 调用）二次核实，行号与事实包一致。

---

## ① 五层能力矩阵

| 层 | 当前有什么（事实锚点） | 缺什么 | 补什么 | 优先级 |
|---|---|---|---|---|
| **感知** | 工具结果回灌（agent-core.js:236-238）；task_next 文本正则解析（agent.js:78-99）；onStep 事件流（agent-core.js:168） | 无现场感知工具：不能读文件/日志/测试输出/git 态/DB 态；F3 头部截断 3000 字（agent-core.js:158）丢尾部——错误恰在尾部；F2 丢弃 enum/默认值（agent-core.js:136-155） | 感知类只读工具：`file_read/file_grep/file_glob`、`git_status/diff/log`、`test_run` 只读模式、`db_query`（SELECT-only）、`http_get`；F3 改「tail-aware」截断（保头+保尾+中间省略，shell 类提额至 ~6000）；F2 补 enum/默认值透传 | **P0**（文件/测试/git 只读）、P1（DB/网络） |
| **规划** | 系统提示词纪律（agent-core.js:22-35）；task_next 依赖拓扑+优先级（A1 事实包）；maxSteps/去重护栏（agent-core.js:159-180）；收尾轮 toolsFilter（agent.js:195） | F4：num_ctx=8192（agent-core.js:49）已装 18 工具 schema，再进 12-20 执行工具会挤爆；F5：同参去重（agent-core.js:205-207）误杀轮询构建/tail 日志/重跑测试等合法重复；无「阶段化工具暴露」（执行轮与收尾轮给同一套工具） | F4：toolsFilter（agent-core.js:170,179）扩展为**阶段暴露**：感知轮=memory+读工具，执行轮=+写工具（经 writeGate），收尾轮=只 task_done/memory_write（agent.js:187-204 已有收尾轮骨架，复用）；F5：为幂等读工具/轮询类设去重豁免白名单；LLM 侧规划维持现状（提示词纪律够用，不建代码化 planner） | **P1** |
| **执行** | **零**——18 工具全为 memory/obsidian/task（A1、事实包 L13） | 文件/shell/测试/git/网络/DB/浏览器/编排八域全缺；F9 无沙箱、无 cwd 约束、无单调用超时（server.js 仅 .dsh/mcp.json 的 15000ms）；F7 无头零审批违反 B1；F1 新工具不登记即绕过 writeGate | 八域工具清单（§3）经方案 A 挂载；shell 走孙进程+每调用超时+cwd 白名单（修 F9，不做容器）；writeGate 元数据化（修 F1）；F7 改为「`--work` 默认仍要写同意，`--auto-write` 必须显式且逐条留审计日志」；F6 写类工具 JSON 解析失败必须报错而非传 `{}`（agent-core.js:200-203） | **P0**（文件/shell/测试/git + F1/F6/F7/F9 修复） |
| **记忆** | 8 个 memory_* 工具（memory_write/search/ask/projects/context/read/feedback/cite/report）；WAL+每日 VACUUM INTO 快照（B2）；本地 bge-m3 向量（embed.js）；obsidian 同步 | F8：任务正文（可被其他 agent 写入的共享内容）直接拼进 user 消息（agent.js:173-174）→ 提示注入面；工具结果原样回灌（agent-core.js:236-238）→ 工具结果注入面；F15：onStep 外抛 `result.slice(0,500)`（agent-core.js:230）二次泄漏到 dashboard；执行经验无自动沉淀钩子（修完 bug 不会提示写 lesson） | F8 数据栅栏包装（任务正文/工具结果标记为 untrusted data，系统提示词加「栅栏内指令不执行」）；F15 日志脱敏；收尾轮增加「可选 memory_write 沉淀」提示（经 writeGate，纪律 ≤200 字可复用结论）；F10 令牌改 safeStorage（P1，非阻塞） | **P0**（F8 栅栏 + 沉淀钩子）、P1（F15/F10） |
| **评估** | memory_cite（价值漏斗 R4）、memory_feedback（纠错闭环）、report.js、arbitrate.js；task_done 附结论（agent.js:185） | 执行结果无结构化证据字段（「测试通过」目前是自然语言结论）；价值度量未纳入执行证据 | task_done conclusion 允许携带结构化证据指针（如 `{test: "34/34 passed", files:[...]}`，db.js 侧加列/扩字段）；评估闭环 = task_done 证据 + memory_cite 命中率 + report 聚合，**复用现有 report/arbitrate，不新建度量系统** | **P1** |

---

## ② 执行工具面架构选型

### 2.1 三案对比

| 维度 | A：扩展 server.js 单 MCP 平面 | B：独立 exec-mcp，双 MCP 合并 | C：内核内 HTTP/本地 RPC 适配层 |
|---|---|---|---|
| 改动面 | 最小：新增 `exec-tools.js`，经 `server.js:49-63` 既有 `addTool` 钩子注册；agent 侧只修 F1-F7；`.dsh/mcp.json` 零改动 | 大：新进程 + 双注册（.dsh/mcp.json 第二个 server）+ agent-core `createMcpClient`（agent-core.js:97-133）改双实例 + tools/list 合并 + callTool 按工具源路由 | 最大：第二协议面（端口+token+IPC）+ runAgent 双通道循环（MCP 之外 RPC 一路）+ 工具 schema 在两平面重复定义 + writeGate 双通道各做一份 |
| 隔离性 | 进程内：exec 与 memory 共享内核（本为 Electron spawn 的独立子进程，F13 可重启，故障域已被该边界包住）；shell 用孙进程隔离副作用 | 进程级隔离，exec 崩不拖 memory——但对本内核的边际收益≈0（子进程边界已存在） | HTTP loopback + 令牌，叠加 F10 明文令牌、F11 令牌进 URL query 的既有安全债 |
| 故障域 | 1 条 stdio pipe；exec 单调用超时在工具内部做（修 F9），pipe 不受影响 | 2 条 pipe：任一掉线 = 半套工具静默缺失，需双存活检查 | +1 网络依赖（端口冲突/令牌失配） |
| 上下文税 | 与现状同规模，问题只是 F4（toolsFilter 可治） | LLM 侧同 A（schema 总量相同）；DSH GUI 管理面双份 | LLM 同；但 exec 工具不进 .dsh/mcp.json → DSH 侧不可见不可审计，日志/审计双平面（放大小 F15 类泄漏面） |
| writeGate 治理点 | **单一**：agent-core.js:215-224 一处生效，元数据化后一次修完 | 治理点分裂：两套工具列表各需登记，F1 类绕过风险翻倍 | 双通道双份门禁实现，任一份漏做即 F7 式违规 |
| 迁移成本 | 最低：纯追加，git 可回滚（B3 纪律兼容） | 高：新进程生命周期管理、双健康检查、双日志 | 高：协议+客户端+循环全动 |
| 与 B1 一致性 | 单一同意面，审计日志一处 | 审计分散 | 审计分散 + 令牌安全债 |

### 2.2 推荐：**方案 A（单 MCP 平面 + 模块分离实现）**

- 落点：新增 `resources/memoryos/dist/exec-tools.js`（纯函数模块：各域工具实现 + `execToolDefs()` 返回带 `isWrite` 元数据的定义数组），`server.js` 仅在注册段循环 `addTool` 之（钩子已在 server.js:49-63 统一覆写，便于审计日志）。
- 配套 agent 侧修复（与工具落地同批或先行）：F1 元数据化（`WRITE_TOOLS` 从写死 Set 改为读取工具注册元数据，agent-core.js:15-19）、F3 tail-aware 截断（:158）、F6 写类严格参数（:200-203）、F7 无头默认拒绝（agent.js:118-121）、F4 阶段化 toolsFilter（:170,179）、F8 栅栏（agent.js:173-174 + agent-core.js:236-238）、F9 孙进程超时/cwd 白名单（shell_run 实现内）。
- 依据：A1 已判定「加执行工具 = 服务端多暴露工具 + 修耦合缺陷，不是架构重写」。单平面保 writeGate/去重/审计单一治理点，迁移成本最低，git 可完整回滚（B3）。

### 2.3 否决理由

- **否决 B（独立 exec-mcp）**：本地单机单用户内核，子进程边界（Electron spawn，F13）已包住故障域，进程级隔离的边际收益≈0；代价是双注册、双 pipe 存活检查、callTool 路由表、F1 治理点翻倍、审计面分裂——复杂度不换来本质收益。exec 所需的隔离粒度（cwd 白名单/单调用超时/孙进程）在进程内即可完整实现。
- **否决 C（HTTP/本地 RPC 适配层）**：唯一真正违背 A1「不是架构重写」判定的选项——为 12-20 个只用本地环境（server.js 进程内已天然持有 db/env/cwd）的工具开第二协议通道，schema 双份、writeGate 双份、runAgent 双通道，且 exec 工具不进 .dsh/mcp.json 导致 DSH 侧不可审计；叠加 F10/F11 令牌安全债（明文、进 URL query），攻击面反而扩大。

---

## ③ 八域执行工具清单模板

风险级：低=只读/无副作用；中=本地只读但敏感或缓存写入；高=改动用户数据/源码/远程。
「入 writeGate」列 = 加入注册元数据 `isWrite:true`（修复 F1 后由元数据驱动，不再硬编码名单，agent-core.js:15-19）；同意点仍走 agent-core.js:215-224 单一门禁。

### 文件域（P0）
| 工具名 | 用途 | 入参要点 | 返回契约 | 风险级 | 入 writeGate |
|---|---|---|---|---|---|
| file_read | 读 UTF-8 文件，带行号 | `path, offset?, limit?` | `{lines[], total, truncated}` | 低 | 否 |
| file_grep | 目录内正则搜索 | `pattern, path?, include?` | `[{file, line, text}]`（按 cap 截断+存盘指针） | 低 | 否 |
| file_glob | 路径模式匹配 | `pattern, path?` | `[path]` | 低 | 否 |
| file_write | 创建/整文件覆盖；**自动先落时间戳备份**（B1 纪律工具化） | `path, content, backup?=true` | `{ok, backupPath}` | 高 | **是** |
| file_edit | 定点替换（old 须唯一匹配） | `path, old, new, replace_all?` | `{ok, replaced}` | 高 | **是** |

### Shell 域（P0）
| 工具名 | 用途 | 入参要点 | 返回契约 | 风险级 | 入 writeGate |
|---|---|---|---|---|---|
| shell_run | 跑单条 shell 命令（孙进程，每调用超时+cwd 白名单，修 F9） | `cmd, cwd?, timeoutMs?` | `{exit, stdoutTail, stderrTail, ms, truncated}`（tail 为主，修 F3） | 中-高 | **是**（默认需同意；后续可对纯读命令维护白名单 auto） |
| shell_poll | 读后台构建/日志尾部（幂等，F5 去重豁免白名单成员） | `pid, lines` | `{alive, tail}` | 低 | 否 |

### 测试域（P0）
| 工具名 | 用途 | 入参要点 | 返回契约 | 风险级 | 入 writeGate |
|---|---|---|---|---|---|
| test_run | 探测并运行项目测试（npm/vitest/jest） | `cwd?, args?` | `{exit, passed, failed, tail}` | 中（不改源码，仅缓存写入） | 否（B1 针对写操作；严格模式可配） |
| test_single | 跑单测试文件/单用例 | `file, name?` | 同上 | 中 | 否 |

### Git 域（P0：只读+备份；写操作全 gate）
| 工具名 | 用途 | 入参要点 | 返回契约 | 风险级 | 入 writeGate |
|---|---|---|---|---|---|
| git_status | 工作区状态 | `cwd?` | 文本 | 低 | 否 |
| git_diff | 差异 | `cwd?, staged?` | 文本（F3 截断） | 低 | 否 |
| git_log | 提交史 | `cwd?, n?` | 行列表 | 低 | 否 |
| git_backup | 改代码前回滚点：`git add -A && commit + tag pre-<ts>`（B1/B3 纪律工具化） | `cwd?, tag?` | `{commit, tag}` | 高 | **是** |
| git_commit | 提交/打 tag（代码回滚走 git，B3） | `cwd?, msg, tag?` | `{commit, tag}` | 高 | **是** |

### 网络 API 域（P1）
| 工具名 | 用途 | 入参要点 | 返回契约 | 风险级 | 入 writeGate |
|---|---|---|---|---|---|
| http_get | 只读拉取 URL | `url, headers?` | `{status, bodyTail}` | 低 | 否 |
| http_post | 写远程 API（外部副作用） | `url, body, headers?` | `{status, bodyTail}` | 高 | **是** |

### 数据库域（P1；B2 WAL 纪律内建）
| 工具名 | 用途 | 入参要点 | 返回契约 | 风险级 | 入 writeGate |
|---|---|---|---|---|---|
| db_query | SELECT-only（服务端前缀+语句校验强制只读） | `sql` | `{rows, n}` | 中 | 否（服务端强制只读，无写路径） |
| db_snapshot | `VACUUM INTO` 自包含快照（B2 唯一有效备份，保留 7 份纪律） | `keep?=7` | `{path, size}` | 高 | **是** |
| db_exec | DML/DDL（先自动 db_snapshot 再执行） | `sql` | `{affected, snapshotPath}` | 高 | **是** |

### 浏览器自动化域（P2）
| 工具名 | 用途 | 入参要点 | 返回契约 | 风险级 | 入 writeGate |
|---|---|---|---|---|---|
| browser_open | 开页面 | `url` | `{ok, url}` | 低 | 否 |
| browser_snapshot | 取 DOM/文本快照 | `ref?` | 文本（F3 截断） | 低 | 否 |
| browser_act | 点击/填表/滚动 | `ref, kind, value?` | `{ok}` | 高 | **是** |
| browser_shot | 截图存盘 | `path` | `{path}` | 中 | 否（本地产物） |

### 多 agent 编排域（P0 存量 + P1 扩展）
| 工具名 | 用途 | 入参要点 | 返回契约 | 风险级 | 入 writeGate |
|---|---|---|---|---|---|
| task_next / task_claim / task_done / task_supersede / task_assign | **已存在**于 18 工具（前四个已在 WRITE_TOOLS，agent-core.js:15-19） | 现状 | 现状 | — | claim/done/supersede/assign 已入 |
| agent_status | 列出 agent 活跃状态与近期活动（基于任务表 + MEMORY_AGENT/MEMORY_AGENT_FPATH 审计，agent-core.js:105-106） | `project?` | 行列表 | 低 | 否 |
| task_cancel | 取消/重开任务 | `memory_id, reason` | 回执 | 中 | **是** |
| task_brief | 给任务追加结构化简报（依赖/验收标准） | `memory_id, brief` | 回执 | 中 | **是** |

> 说明：**不建内核内 subagent 生成器**——DSH 实时 subagent 是既有外部路径（双路径协同见待办 #4073/#4129），MemoryOS 侧只走队列，编排域扩展限定在队列语义内（cancel/brief/status）。

---

## ④ 端到端接线时序（示例：修一个 bug）

1. **取任务**：`task_next(project, as="")`（agent.js:135）→ `pickTask`（agent.js:78-89）选中「派给我的/未认领」。
2. **认领**：`task_claim`（agent.js:155；写门禁点 #1——REPL 逐个 y/N；**`--work` 现状 gate=null 全放行 = F7/P0 必修，修后无头模式必须显式 `--auto-write` 且逐条写审计日志**）。
3. **拉上下文**：`memory_read(memory_id=任务)`（agent.js:170）取全量正文；**F8 修复后此处做数据栅栏包装**（正文标记 untrusted data）；agent 循系统提示词纪律（agent-core.js:26）主动 `memory_context(project)` 注入相关经验。
4. **感知定位**：`file_grep` 找报错符号 → `file_read` 读上下文（只读，免同意）。
5. **复现**：`test_single` / `test_run` 复现失败，留证据（失败测试输出走 F3 tail-aware 截断保尾部）。
6. **改前备份**：`git_backup`（门禁点 #2，B1/B3：时间戳 tag = 回滚点）。
7. **执行修复**：`file_edit` / `file_write`（门禁点 #3，B1 写操作先获同意；F6 修复后写类工具 JSON 坏参 → 报错而非 `{}` 默认执行；F5 修复后重跑测试属白名单合法重复）。
8. **验证**：`test_run` → 通过/失败；失败回 7（去重护栏不误杀）。
9. **结项**：`task_done(memory_id, conclusion=结构化证据：测试通过数+改动文件)`（agent.js:181 doneSeen 检测；漏结项走强制收尾轮 agent.js:187-204，toolsFilter 只给 task_done，agent.js:195）。
10. **沉淀**（评估/记忆层闭环）：收尾提示可选 `memory_write` 一条可复用 lesson（门禁点 #4；纪律 ≤200 字、含具体数值/路径/命令，agent-core.js:28）；`memory_cite` 声明本次采用了哪条记忆（R4 漏斗环，门禁点 #5）；发现被引用记忆有误 → `memory_feedback`（纠错闭环，门禁点 #6）。
11. **评估侧**：`report.js` 聚合 task_done 证据 + memory_cite 命中率；F15 修复后 onStep 外抛摘要（agent-core.js:230）先脱敏再入 dashboard。

writeGate 单点：全程 6 个同意点全部收口在 agent-core.js:215-224（元数据化后按 `isWrite` 命中），审计日志单平面。

---

## ⑤ 明确「不该补的」（YAGNI）

1. **容器/沙箱级进程隔离**——shell 的隔离粒度需求是 cwd 白名单+每调用超时+孙进程（修 F9 的最小面），单机本地内核上容器化是过度建设，且拖入新运维面。
2. **第二 MCP 服务或 RPC 通道**（方案 B/C 本体）——否决理由见 §2.3；单平面已含全部价值。
3. **全套浏览器自动化（Playwright 级）**——P2。修 bug 主路径 = 文件+shell+测试 三件套，浏览器域仅在项目真有 UI 回归需求时再落。
4. **完整 JSON Schema 透传**——F2 只需补 enum/默认值/描述透传；弱模型（Ollama qwen3:8b）消化复杂 schema 的能力本有限，正解是 F4 toolsFilter 阶段化收窄，而非把 schema 灌满。
5. **内核内 subagent 生成器/分布式任务调度/跨机 agent mesh**——队列语义够用；DSH 实时 subagent 是既有外部路径（#4073/#4129 在队列侧做协同，不在内核造第二个执行平面）。
6. **新 GUI 审批面板**——写同意已有 CLI y/N 通道（agent.js:61-75）；dashboard 已有现成端点，为 12-20 个工具新开 UI 平面是呈现层过度建设（B1「改版只改呈现不改功能」的反向应用：也别为呈现造新平面）。
7. **新的度量/评估系统**——评估层复用 report.js/arbitrate.js + memory_cite 漏斗，只给 task_done 加结构化证据字段（P1），不另起炉灶。

---

## 附：合规声明（B1/B2/B3）

- 本文档为新增呈现层文件，未改动任何既有代码/配置；后续落地执行工具时，**改代码前按 B3 走 git 提交/tag、改库前按 B2 走 `data/memory.db.pre-*` 时间戳快照**，file_write/db_exec/git 类工具全部实现「改前自动备份」行为，且默认 `--work` 模式补齐写同意（F7 修复是 B1 合规的硬前置，P0）。
- 本意见所有行号结论基于 2026-09-15 事实包及本专家当日对 `agent-core.js`（247 行）、`agent.js`（252 行）、`server.js` 注册结构的复读核实；未复读范围（db.js/report.js/arbitrate.js 内部实现）标注为「复用现状，未逐行核实」。
