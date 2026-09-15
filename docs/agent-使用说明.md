# MemoryOS Agent 使用说明

> 2026-09-15 新增。内置 agent 复用现有 MCP 工具面（18 工具），不新增任何数据通道：
> 所有读写仍走 `dist/server.js` 的 MCP 工具，审计（`card_events` / `daemon_log`）与埋点（`usage`）口径不变。

## 一、两条入口，同一内核

| 入口 | 文件 | 形态 | 适合 |
|---|---|---|---|
| CLI agent | `dist/agent.js` | 终端 REPL / 单问 / 任务队列 | 无人值守、批量、多实例并行 |
| Dashboard agent | 8787 → 左侧「集成 → Agent」 | 网页对话（步骤轨迹可见） | 人在看板前顺手问、看一眼它干了什么 |

两者共用 `dist/agent-core.js`：

- **LLM 端点可插拔**：任何 OpenAI 兼容 `/v1/chat/completions`（本地 Ollama / mimo-proxy / 云端 API 都行）
- **MCP 客户端**：stdio 拉起 `dist/server.js`，`tools/list` → 18 工具自动转成 OpenAI tools 格式
- **agent 循环**：LLM ⇄ 工具；`maxSteps` 末轮强制无工具收尾（防弱模型无限调工具不收口）
- **写门禁（writeGate）**：写类工具（`memory_write` / `memory_feedback` / `memory_cite` / `task_*` / `obsidian_*`）执行前必须过审

## 二、配置

CLI 读环境变量；Dashboard 读设置页 `config.json` 的 `llmUrl/llmModel`，环境变量兜底。

### 设置页 LLM 配置（2026-09-15 修复）

| 项 | 行为 |
|---|---|
| **URL 写法** | **base 或完整端点都行**：`https://api.deepseek.com/v1` 与 `…/v1/chat/completions` 等价（内核会归一化补全）。原先只认完整端点，填 base 会 404 |
| **密钥** | 用 **Windows DPAPI 用户级加密**后存 `config.json` 的 `llmKeyEnc`，**明文不落盘**（P-4171 的落地补齐）。原实现把密钥直接剥掉，导致「填进去就消失、云端模型根本配不起来」 |
| **密钥来源优先级** | 环境变量 `LLM_API_KEY`/`INGEST_KEY` > `config.json` 密文；设了环境变量时页面会标注「来自环境变量」 |
| **生效方式** | **保存即时生效，无需重启内核**（内核侧每次调用现读 config.json）。仅「受限模式」这类启动期变量仍需重启 |
| **测试连接** | 设置页「测试连接」按钮会用表单里还没保存的值真发一次请求，区分 URL 错(404)/密钥错(401)/限流(429)/超时/网络不可达 |
| **换机器/换用户** | DPAPI 密文解不开 → 页面明确提示「密钥无法解密，请重新填写」，不会静默当没密钥用 |

> ⚠ agent 需要**支持 tool calling** 的模型。本地 `qwen3:8b` 已实测可用；云端模型（如 `agnes-3.0-flash`、`deepseek-chat`）请先点「测试连接」确认连通，再到 Agent 页试一轮——不支持工具调用的模型会退化成纯聊天。


| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `http://127.0.0.1:11434/v1` | OpenAI 兼容端点根（不含 `/chat/completions`） |
| `LLM_MODEL` | `qwen3:8b` | 模型名（必须支持 tool calling） |
| `LLM_API_KEY` | 空 | 云端 API 用；**不落盘**（与 P-4171 一致，config.json 永不含明文密钥） |
| `LLM_NUM_CTX` | Ollama 端点自动 8192 | 上下文窗口；18 个工具 schema 就占 2~3k token，4096 会不够 |
| `LLM_TIMEOUT_MS` | 180000 | 单次 LLM 调用超时 |
| `MEMORY_AGENT` | CLI=`cli-agent`，Dashboard=`dashboard-agent` | 写库时的 agent 身份（价值漏斗按此归属） |
| `MEMORY_AGENT_FPATH` | 自身文件路径 | 身份指纹（库内可佐证来源） |
| `EMBED_MODE` | `local` | 传给 MCP 子进程；`fake` 会导致语义召回失效 |

切云端 API 示例（PowerShell）：

```powershell
$env:LLM_BASE_URL='https://api.deepseek.com'; $env:LLM_MODEL='deepseek-chat'; $env:LLM_API_KEY='sk-...'
node dist/agent.js -m "查一下备份策略"
```

## 三、CLI 用法

```powershell
node dist/agent.js                                  # 交互 REPL（写操作逐个 y/N 确认）
node dist/agent.js -m "任务前先查下备份策略的记忆"      # 单问
node dist/agent.js --work -p memoryos               # 任务队列：认领 1 条可做任务 → 干活 → task_done
node dist/agent.js --work -p memoryos --resume       # 续做自己已认领但未结项的 in_progress 任务
node dist/agent.js --work --loop --every 60          # 持续轮询（无任务时退出；加 --wait 一直等）
node dist/agent.js --tools                           # 只列 18 个工具
node dist/agent.js --help
```

> ⚠ **scope 坑**：`task_next` 的过滤条件是 `project IN (?, 'global')` —— 查 `memoryos` 项目的任务
> **必须** `-p memoryos`，用默认的 `global` 会看不到（表现为「暂无任务」但任务其实存在）。

常用选项：

- `-n/--name <agent>`：身份（决定 `task_next` 的「我的任务」与写库归属）
- `-p/--project <scope>`：任务/记忆 scope（默认 `global`）
- `--steps <n>`：单任务最大 LLM 轮次（默认 12）
- `--confirm-write`：即使在 `--work` 无头模式下也逐个确认写操作
- `--llm-url / --llm-model / --llm-key / --llm-num-ctx`：临时覆盖端点

`--work` 一轮做的事：`task_next`（依赖拓扑+优先级）→ 挑一条（优先派给我的、其次 `?` 未认领、最后托管他人任务 `as=any`）→ `task_claim` → `memory_read` 取全文 → agent 干活 → `task_done` 附结论。
**若 agent 没调 `task_done`，会补一轮「强制收尾」（只暴露 `task_done` 一个工具）**；仍失败才告警并保持 `in_progress`（不假装完成，可用 `--resume` 续做）。

### 弱模型三护栏（2026-09-15 真机测试后补）

本地 8B 模型有两个稳定毛病，`agent-core.js` 里已兜：

1. **重复调用死循环**：同工具同参数（`name|args` 签名）真跑最多 2 次，第 3 次起不再执行，改为回灌「结果不会变，直接给答案」；若整轮全是重复，直接把下一轮切成末轮逼出文本答案。
2. **不收口**：`maxSteps` 末轮不再传 `tools`，强制文本收尾。
3. **不结项**：`--work` 下未调 `task_done` 时补一轮只给 `task_done` 的收尾轮（见上）。

实测：任务 #3306 联调时，模型把 `task_done(...)` 当**文本**输出而未真正调用 —— 正是靠第 3 条护栏补上了结项。这类幻觉（如编造 `#memdiag_001` 引用）是本地小模型的固有风险，重要结论请人工复核。

REPL 内命令：`/tools` 列工具、`/clear` 清上下文、`/quit` 退出。

## 四、写门禁（记忆库写操作须先获同意）

| 场景 | 默认 | 开关 |
|---|---|---|
| CLI REPL / 单问 | **拒绝**（无门禁提供者时写类工具一律拒）→ 交互式 y/N | `--auto-write` 全放行 |
| CLI `--work` | **自动放行**（自主任务流是设计内的无头路径） | `--confirm-write` 改为逐个确认 |
| Dashboard | **拒绝**，页头提示「需先勾选」 | 勾选「允许写入记忆库」；**受限模式下强制只读**（后端强制，不只看 UI） |

被拒时 agent 收到的是「用户拒绝了该写操作，不要重试」而不是错误堆栈 —— 它会退回只读作答，不会硬重试。

## 五、验证与回归

```powershell
node dist/smoke-agent.js          # LLM 工具调用 + MCP 18 工具 + 只读单轮
node dist/smoke-dashboard.js      # dashboard 既有路由回归（agent 端点不影响老路由）
node outputs/agent-ui-walk.mjs    # 真实 Chrome headless 点击巡检 Agent 页（需 dashboard 在 8787 跑着）
```

`outputs/agent-ui-walk.mjs` 断言：导航存在 → 点击激活 → 状态行拿到模型（证明 cookie 鉴权+fetch 通）→ 受限模式写入置灰 → 中文提问真实作答并渲染 → 工具轨迹折叠块 → 全程 0 JS 错误。

## 六、已知限制

- **本地 8B CPU 推理慢**：单轮 5~15s，一次多工具对话 40~90s。要快就换云端 API 或更小模型。
- **弱模型会乱调参**：qwen3:8b 偶发填无关参数（如给 `task_next` 编 `session_id`）。工具侧容错已兜住，但别指望它像 GPT-4 级模型那样精准。
- **工具结果截断 3000 字**：护本地小上下文；要看全文（如长报告）需单独 `memory_read`。
- **对话历史不进库**：Dashboard 的对话历史由前端回传（服务端无状态），刷新页面即清空；有价值的结论要显式让 agent `memory_write`（且开关打开）。
- **不做流式输出**：目前一问一答整轮回传；长任务期间界面只显示「运行中…」。

## 七、故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `agent 执行失败：fetch failed` + 端点提示 | LLM 端点没起：本地 `ollama serve`（注意别让 Ollama 进程跑在受限沙箱里，否则 llama-server 起不来） |
| `MCP 工具面不可用：spawn EPERM` | 进程无法 spawn 子进程（沙箱/权限）；agent 需要在能起子进程的环境运行 |
| 页面状态行显示「工具面 0 个」 | MCP 子进程拉起失败 → 看 dashboard 控制台 stderr，修好后重进页面（服务端不缓存坏句柄） |
| 工具全被拦、答案说「拒绝了写操作」 | 写门禁生效中：CLI 用 `--auto-write`，Dashboard 勾选「允许写入记忆库」 |
| **搜索什么都搜不到 / 只命中字面相同的** | **`EMBED_MODE` 没注入 → 默认 `fake`**（`embed.js:11`）。fake 模式无语义召回：实测 `global` 489 条记忆里查「备份策略」命中 0 条；注入 `EMBED_MODE=local` 后同一查询命中 10 条。**每个 MCP 客户端（Codex/Claude/TRAE/DSH…）的 server 配置都必须带 `EMBED_MODE=local`**（agent 与 dashboard 已自动注入）。自测：`node dist/tmp-search-check.mjs local` 与 `fake` 对比 |
| 设置页保存密钥后状态仍显示「未设置」 | 正常情况下不会：密钥以 DPAPI 密文落盘。若真出现，检查 `config.json` 是否有 `llmKeyEnc`，以及 PowerShell 是否可用（加密借道 PowerShell，`pwsh` 或 `powershell` 任一） |
| 云端模型报 401 | 密钥不对/没填。设置页「测试连接」会直接指出；也可改用环境变量 `LLM_API_KEY`（优先级最高） |
| 云端模型报 404 | URL 写法问题（已支持 base 与完整端点两种）。若仍 404，检查是否漏了 `/v1` 或用了不兼容 OpenAI 协议的地址 |
