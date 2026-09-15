# MemoryOS 完整 agent 补全 · 共享事实包（供专家团引用）

> 本文件是勘察结论，所有行号级事实均已在 2026-09-15 当日核实。专家产出请引用编号（F1、F2…）而不是复述。

## 项目定位
MemoryOS（Windows，`C:\Users\WYX\Desktop\MemoryOS`）：本地记忆中枢 + 多 agent 任务队列。
现状：共享记忆读写 / 任务队列 / 多 agent 协同 / Obsidian 同步 / 价值度量。**缺现场执行能力**（文件/shell/patch/测试/网络/DB/浏览器/编排）。
目标：补成"完整 agent"——结论先行，最小改动，符合用户三条硬约束。

## 现状架构
- **Electron 壳（CommonJS）**：`main.js`(7.9KB)、`app/lifecycle.js`、`services/{core-process,port,scheduler,updater}.js`、`window/{main-window,tray,welcome-window}.js`、`security/{ipc,token}.js`、`preload.js`。
- **Node 内核（ESM，真相源）** `resources/memoryos/dist/`：
  - `server.js` 59KB — MCP stdio 服务端，**恰好 18 个工具**：memory_write/search/ask/projects/context/read/feedback/cite/report/health、obsidian_import/export/write_note、task_assign/claim/done/supersede/next。
  - `agent-core.js` 13.6KB — LLM 端点解析 + MCP 客户端 + 通用 agent 循环。
  - `agent.js` 13KB — CLI agent（REPL / `-m` 单问 / `--work` 任务队列 / `--resume` / `--loop`）。
  - `dashboard.js` 146KB（HTTP 看板 127.0.0.1:8787 + 内嵌 UI）、`daemon.js` 35KB、`db.js` 67KB（SQLite，WAL）、`obsidian-sync.js` 34KB、`llm.js`、`ingest.js`、`scan.js`、`search.js`、`merge-db.js`、`secret-store.js`、`report.js`、`arbitrate.js`、`embed.js`（Xenova bge-m3 本地向量）。
- `.dsh/mcp.json`：stdio 注册 memoryos → `node .../dist/server.js`，`toolCallTimeoutMs: 15000`。

## 关键架构事实
**A1** `agent-core.js` 的 `runAgent()` 完全工具无关：① `createMcpClient()` 用 `StdioClientTransport` 拉起 `server.js` → `tools/list`；② `mcpToolsToOpenai()` 转 OpenAI tools 格式；③ 循环「LLM ⇄ `mcp.callTool(name,args)`」带 maxSteps / 去重护栏 / writeGate。
⇒ **加执行工具 = 让 MCP 服务端多暴露工具 + 修好以下耦合缺陷。不是架构重写。**

## 已核实缺陷（行号级）
- **F1** `agent-core.js:15-19` `WRITE_TOOLS` 是硬编码 Set（**10 个**工具名：memory_write/feedback/cite、obsidian_import/export/write_note、task_assign/claim/done/supersede；task_next 不在集内；初稿误记 11，2026-09-15 后端专家复核修正），唯一写门禁判据。新变异工具不登记 → writeGate 被静默绕过。
- **F2** `agent-core.js:136-155` `mcpToolsToOpenai` 只透传 `schema.properties` + `required` + `description`。**2026-09-15 活体证据修正**：运行时 `tools/list` 的每个 `inputSchema` 确实带 `additionalProperties:false` 与 `$schema`(draft-07)——源码 grep 不到是因为由 FastMCP/zod 运行时生成；而 `properties` 是**整体引用透传**，嵌套的 `enum/items/additionalProperties/min/max/default` 全部保留 ⇒ **实际丢失仅限顶层关键字**（`additionalProperties`/`$schema`/`$defs`/顶层 `oneOf|anyOf|$ref`）。影响：既不是"当前潜伏"（顶层关键字已在丢），也不是"schema 全面降级"；真实风险 = 未来新工具若用**顶层** `oneOf/$ref` 表达动作联合类型会失效 ⇒ 设计约束：新工具把复杂结构放进 `properties` 内即可，F2 降为 P1 顺带修。
- **F3** `agent-core.js:158` `MAX_TOOL_RESULT = 3000` 字符硬截断且只保头部 → shell 输出/测试日志/栈追踪（错误常在尾部）被腰斩。
- **F4** `agent-core.js:49` Ollama 默认 `num_ctx=8192`，已装 18 个工具 schema；再加 12~20 个执行工具会挤爆上下文。`toolsFilter`（:170,:179）是现成收窄钩子，目前仅 agent.js:195 收尾轮用过。
- **F5** `agent-core.js:159` `MAX_SAME_CALL=2`，去重键 `name|JSON(args)`，`seen` Map 为 `runAgent` **局部变量（:180）** ⇒ 准确表述是「同一 runAgent 调用内跨轮持久」，**不是**跨任务持久（2026-09-15 代码审查修正）。对执行面的真实风险 = 同任务内合法重复被误杀（重跑测试、回读产物、轮询就绪）。
- **F6** `agent-core.js:200-203` JSON 解析失败静默传空参 `{}`，对只读工具无害，对新执行工具可能被解读为"默认参数执行"。
- **F7** writeGate 是二值布尔（:215-224）；agent.js:118-121 中 `--work`/`--auto-write` 模式**默认 null = 全放行**（无头零审批）。
- **F8** `agent.js:173-174` 任务正文（其他 agent 可写入的共享记忆内容）直接拼进 user 消息 → 提示注入面；`agent-core.js:236-238` 工具结果原样回灌 → 工具结果注入面。
- **F9** `services/core-process.js:15-46` spawn 子进程：`stdio:["ignore","pipe","pipe"]`、`cwd=内核目录`、env 注入 `MEMORY_DB/MEMORY_PORT/MEMORY_TOKEN`；无沙箱、无 cwd 约束、无单次调用超时（仅 .dsh/mcp.json 15000ms）。
- **F10** `security/token.js:26` 令牌 `randomBytes(24).hex` **明文**存 `%APPDATA%\MemoryOS\data\token`（注释自认应走 safeStorage）；经 env 传子进程。
- **F11** `window/main-window.js:19` 令牌放 **URL query**（`?token=...`，进历史/Referer/日志）；该窗口**未声明任何 webPreferences**（依赖默认值）。`welcome-window.js:14-17` 才是 `contextIsolation:true/nodeIntegration:false`。
- **F12** `security/ipc.js` 仅对 `welcome-save-config` 做 `event.sender` 白名单校验。
- **F13** `core-process.js:34-43` 内核意外退出只弹框不自动重启；`restartCore/killAll` 用 `taskkill /PID /T /F`。
- **F14** `agent.js:209` `setTimeout(res, 5000)` 为**合法延迟写法（非缺陷，已复核）**；真正死代码是 `:118` 的 `writeGate` 变量——赋值后从未被引用，实际生效的是 `:120` 的 `gate`（使用点 :183/:197/:219，grep 已核实）。
- **F15** `agent-core.js:230` onStep 外抛 `result.slice(0,500)` 摘要，dashboard 侧可能二次泄漏敏感内容。

> 附注：`server.js:41` 文件头注释「本文件注册 16 个工具」为过期注释，实测 18 个（addTool 覆写 :49-63 + 18 处注册点 :64-937，grep 已核实）。

## 追加核实（2026-09-15 活体探测）
- **F16** `smoke-mcp.js:77` 断言 `tools.length === 17`（白名单 17 名漏 `task_supersede`），`smoke-agent.js:49` 断言 18（正确）。**活体探测实测 18**（memory×10 + obsidian×3 + task×5）⇒ F16 坐实。**实跑结果（代码审查专家实测）：13 PASS / 1 FAIL，exit code 1**，唯一 FAIL 即 :77。**且 :77 是双重错误**：① 计数 17→18；② 白名单与自身标题矛盾（标题写 task×4，名单只有 assign/claim/done/next）。因 `&&` 短路，count 为假时 `every()` 根本没执行 ⇒ **只改计数仍会 FAIL**。
  **影响（阻断级）**：P0 验收标准「`smoke-mcp.js` 全 PASS」当前不可满足；且 4 个 smoke 各自独立退出码、**无聚合 runner**，`smoke-agent` 全绿会造成"回归是绿的"错觉。新工具注册后真实计数变 21，该 FAIL 依然 FAIL，**无法区分「陈旧断言噪声」与「真实注册缺失」**——恰好吃掉执行面最需要的告警力。⇒ P0 开工前先修 :77 并补 `smoke-all.js` 聚合 runner。
- **F17（新发现，阻断级）** `agent-core.js:179` `o.toolsFilter?.length ? filter : allTools` **语义反转 + 静默失败**（已复核源码）：传 `[]`（本意"零工具"）→ `.length` 为假 → **回落全量工具**（想收权限反而放大到执行面全暴露）；传错名字 → filter 得 `[]` → `callLlm` 因 `tools?.length` 为假**不发 tools 字段**（:72）→ 模型静默不再调工具且无任何报错。⇒ 需改 `pickTools()`：`undefined`=全量、`[]`=零工具、未知名=抛错、过滤后为空=抛错，并把 `tool_face(exposed/total/names)` 打进 onStep。
- **F19（机制澄清，修正误判）** Electron 壳的**打包真相**：`pack-asar.js` 不是构建脚本而是 **asar 补丁器**——读入现有 `resources/app.asar`，仅把 `SYNC_FILES`（`:17` = `/main.js`、`/services/core-process.js`、`/window/tray.js`、`/services/updater.js`）从工作树热替换（`:130` `sourceFile(f.p)`），**其余 14 个条目从旧 asar 原样 extract**，并自检条目数相等（`:110`）。
  ⇒ `preload.js`(253B)、`welcome.html`(3791B)、`assets/{icon-512.png,icon.ico,tray.png}` **不在工作树、也不在 git**（`git ls-files` 只匹配到 `window/welcome-window.js`）**属于设计使然，不是文件丢失/树不完整**；不要据此判断「树不完整」或「rebuild 会打坏包」（已收回该推断）。**改动它们的唯一正确路径 = 把路径加进 `pack-asar.js:17` 的 `SYNC_FILES` 并落一份工作树副本**（外加 `git add -f`，因 `.gitignore` 未忽略但从未纳管）。此结论修正了安全专家的早期同步项①。
- **F18（新发现，开工前置阻断）** git 纳管缺口：`git status --porcelain` 实测 `?? resources/memoryos/dist/agent-core.js`、`?? agent.js`、`?? smoke-agent.js` **均未纳入 git**（仅 `server.js` 为 ` M`），全仓 9 项 untracked，tag 只有 `baseline-20260914-pre-fullopt` 一个 ⇒ **B2/B3 承诺的「代码回滚走 git 提交/tag」对 P0 要改的目标文件不成立**。P0 开工顺序不可颠倒：`git add` 全部改动（含 agent-core.js/agent.js/smoke-agent.js）→ checkpoint commit → 打新 tag → 按 B2 建 `data/memory.db.pre-exec-<ts>`（VACUUM INTO，严禁复制 .db）。
- **环境实测**：Node **v24.9.0**，`node:sqlite` 可用（带 ExperimentalWarning）；默认库 `resources/memoryos/data/memory.db` 健康（memories=907 / active=517 / projects=7 / grams=82143）；`initialize` + `tools/list` 直连握手正常。
- **EXIT=13 已定论（撤回先前的"无法确认"）**：本 DSH 会话内直跑 `smoke-mcp.js` 得到 EXIT=13（`:68` 顶层 await 未落定，spawn + 管道 stdio 受限），属 **harness 环境因素**；代码审查专家在不受该限制的环境实跑同一脚本得 **13 PASS / 1 FAIL、exit 1**（失败项即 F16 的 :77）⇒ 产品侧无此问题，此类「spawn 管道」型脚本在本会话内不可作为判据，须在普通终端复跑。

## 备份与运行时纪律（用户硬性约束）
- **B1** 写操作先获同意；改版只改呈现不改功能；改代码前按时间戳备份。
- **B2** SQLite WAL 模式：严禁直接复制 .db；唯一有效备份 = daemon 每日 `VACUUM INTO` 自包含快照、保留最近 7 份；改前手动建 `data/memory.db.pre-*` 时间戳快照。
- **B3** LLM 优先本地 Ollama `qwen3:8b`（支持 tool calling）；可经 `LLM_BASE_URL/LLM_MODEL/LLM_API_KEY`（壳侧注入 `MIMOS_URL/INGEST_MODEL/INGEST_KEY`）切云端；mimo-proxy（127.0.0.1:18900）备选。
- 代码回滚走 git 提交/tag；数据库回滚走 VACUUM INTO 快照。

## 待办
#4073、#4129（MCP 异步任务队列与 DSH 实时 subagent 双路径协同相关）。
