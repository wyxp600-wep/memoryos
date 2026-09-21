# MemoryOS

本机共享记忆库 + 多 Agent 协同工作台。SQLite（FTS5 + 向量）落盘，**MCP 工具面**供 AI 读写，**Electron 桌面壳** + **8787 看板**提供人机界面。

> 本文件是仓库唯一入口。文件归属分区见 [CLAIM.md](CLAIM.md)；多 AI 协作细则见 [docs/通用任务协作规则-v3.0.md](docs/通用任务协作规则-v3.0.md)。

---

## 一、两层形态

| 形态 | 入口 | 说明 |
|---|---|---|
| 桌面版 | `MemoryOS.exe`（仓库根） | Electron 壳，双击即启动，托盘常驻 |
| 便携版 | `resources/memoryos/launcher.cjs` | 单文件 SEA 入口，拉起 dashboard 并用浏览器打开 |

两者共用同一内核与同一份数据（`%APPDATA%/MemoryOS/`）。

---

## 二、架构

| 层 | 位置 | 职责 |
|---|---|---|
| **壳层** | 根目录：`main.js`、`window/`、`services/`、`security/`、`app/` | 窗口与托盘、端口分配、访问令牌、进程自愈、热更新、IPC |
| **内核** | `resources/memoryos/dist/` | MCP 服务、HTTP 看板、治理守护、LLM agent、采集、Obsidian/技能同步 |
| **前端** | `resources/memoryos/memoryos-dashboard-redesign/` | `index.html` + `app.js`，**可直接改并热生效** |
| **运行时** | `resources/memoryos/runtime/node.exe` | 内置 Node（随包分发，不依赖系统 Node） |
| **模型** | `resources/memoryos/models/` | BGE-M3 ONNX，本地嵌入 |

### 进程模型

壳层拉起两个内核进程并做自愈（[services/core-process.js](services/core-process.js)）：

| 进程 | 作用 |
|---|---|
| `dist/dashboard.js` | HTTP 看板 **8787**；同时提供 `/v1/embeddings` 共享嵌入端点 |
| `dist/daemon.js` | 治理任务（去重、补嵌），经 dashboard 复用同一份嵌入模型 |

**端口**：默认 8787，被占用则顺延扫描 `8787-8806`（[services/port.js](services/port.js)）。

### 鉴权

令牌落 `%APPDATA%/MemoryOS/data/token`。支持四通道，任一命中即放行：

- `?token=<令牌>` —— 浏览器首次访问，随即 **302 剥离 URL** 并种 HttpOnly cookie
- `x-memory-token` 头 —— 脚本/API 调用
- 同源 cookie —— 前端 `app.js` 全部走这条
- `Authorization: Bearer` —— `/v1/embeddings` OpenAI 兼容端点

另有两道防线：Host 白名单（限 loopback，防 DNS rebinding）、令牌缺失时 fail-closed。响应头带 CSP + nosniff + no-referrer。

> ⚠ **令牌有两份，别读错**（曾导致 CDP 走查脚本 100% 失败）
> - `%APPDATA%/MemoryOS/data/token` —— **Electron 壳的真源**（[security/token.js](security/token.js) 生成并注入内核）
> - `resources/memoryos/data/token` —— 仅**独立跑内核**时自举生成（`launcher.cjs` / `restart-core.js`）
>
> 两者内容不同、互不通用。脚本要用令牌请按 `MEMORY_TOKEN` env → `%APPDATA%` 真源 → 仓库内自举 的顺序解析（`outputs/*-ui-walk.mjs` 已按此实现）。

---

## 三、MCP 工具面

**权威清单以运行时为准**（勿手抄，会漂移）：

```powershell
cd resources/memoryos
node dist/server.js --list-tools      # 打印实际注册清单后退出（不启动 stdio transport）
```

当前 **26 个常驻工具**；另 3 个执行面工具按 env 开关（默认关闭）：

| 分组 | 数量 | 工具 |
|---|---|---|
| **记忆** | 11 | `memory_write` 写入（含去重/冲突预检）、`memory_search` 混合检索、`memory_ask` 检索后作答、`memory_projects` 列项目、`memory_context` 开工前注入高价值上下文、`memory_read` 读全文、`memory_feedback` 标错、`memory_cite` 引用计数、`memory_credential` 短生命周期凭据、`memory_report` 周报、`memory_health` 使用侧健康度 |
| **Obsidian** | 3 | `obsidian_import` 增量导入、`obsidian_export` 导出 Markdown、`obsidian_write_note` 写单条笔记（同步入库） |
| **任务协同** | 12 | `task_gate` 验收门、`task_assign` 指派、`task_delegate` A2A 委派、`task_claim` 认领、`task_heartbeat` 续租、`task_release` 释放、`task_block` 受阻、`task_reopen` 重开、`task_done` 完成、`task_verify` 第三方验收、`task_supersede` 去重归档、`task_next` 依赖拓扑算可做集 |
| **执行面** | 3 | `file_read` / `file_write` / `exec_run` —— **默认关闭**，需 `MEMORYOS_EXEC_ON=1` 显式开启；`MEMORYOS_EXEC_OFF=1` 可强制熔断 |

---

## 四、常用命令

### 内核（`cd resources/memoryos`）

| 命令 | 作用 |
|---|---|
| `npm test` | 聚合冒烟（`dist/smoke-all.js`，**自动发现** 24 项 `smoke-*.js`；缺环境项记 SKIP 不记 FAIL） |
| `npm run lint` | 语法检查（`node --check`，**白名单式**显式列举 —— 新增文件需手动入列，否则不受覆盖） |
| `npm run lint:sql` | SQL 占位符/实参数量体检（含自测） |
| `npm run lint:silent` | 静默 catch 体检（含自测） |
| `npm run snapshot:check` | 路由快照逐项比对 |
| `npm run audit` | 执行面审计探针（临时库真跑） |
| `npm run ui:walk` | **手动**：Agent 页 CDP 真实浏览器点击巡检（需 Chrome + dashboard 在跑 + 可用 LLM） |
| `npm run ui:walk:settings` | **手动**：设置页 LLM 配置走查（自起内核于 8792，用临时 data 目录） |
| `npm start` | 单独起 dashboard |

### 壳层（仓库根）

| 命令 | 作用 |
|---|---|
| `node pack-asar.js` | 重打包 `resources/app.asar`（改壳层源码后**必须**执行） |
| `node pack-asar.js --check` | 校验 asar 与工作树副本是否一致 |
| `node pack-asar.js --extract-only` | 把 asar-only 条目补到工作树 |

> **打包注意**：`app.asar` 只纳入 `pack-asar.js` 的 `SYNC_FILES` 白名单里的文件。新增壳层文件务必同步加进该清单，否则改动重打包后会**静默丢失**。重打包前需先退出 MemoryOS（asar 被运行中的进程占用）。

---

## 五、回滚策略

| 对象 | 方式 |
|---|---|
| 代码 | git 提交 / tag（`baseline-20260914-pre-fullopt`、`p0-exec-face`、`p1-done-20260915`、`p2-done-20260916`、`t8-done-20260916`） |
| 数据库 | daemon 的 `VACUUM INTO` 自包含快照 —— **严禁直接复制 `.db` 文件** |
| 壳层二进制 | git 里的 `resources/app.asar` 历史版本 |
| 临时归档 | `archive/<日期>-<主题>/`（按原相对路径保存，可原路还原） |

---

## 六、工作区约定

- **分区归属**：多 AI / 多会话并行时，改文件前先读 [CLAIM.md](CLAIM.md)，确认目标文件在本会话分区内；越界需先报备并登记。
- **短提交**：每次改动立即 commit，信息含「为什么」；不把多主题堆进一个提交。
- **验收门禁只认脚本**：自述「已通过」必须能被 `npm test` / `lint` / `lint:sql` / `lint:silent` / `snapshot:check` 复现。
- **仓库卫生**：不新增 `*.bak-*` 命名（已由 git 取代）；临时脚本用完归档到 `archive/`，不要留在根目录。
- **密钥**：`.env`、API Key、Token、签名私钥一律不入库。签名私钥存仓库外 `~/Desktop/_memoryos-signing-keys/`（可用 `MEMORYOS_SIGN_KEY_DIR` 覆盖）。

---

## 七、深入文档

| 主题 | 文件 |
|---|---|
| Agent 使用（CLI / 看板） | [docs/agent-使用说明.md](docs/agent-使用说明.md) |
| 多 AI 协作规则 | [docs/通用任务协作规则-v3.0.md](docs/通用任务协作规则-v3.0.md) |
| 分区与文件归属 | [CLAIM.md](CLAIM.md) |
| 架构与性能分析 | [MemoryOS-架构与性能分析.md](MemoryOS-架构与性能分析.md) |
| 全维度优化分析 | [MemoryOS-全维度优化分析-20260914.md](MemoryOS-全维度优化分析-20260914.md) |
| 项目记忆与约定 | [PROJECT_MEMORY.md](PROJECT_MEMORY.md) |