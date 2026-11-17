# MemoryOS 个人版开发说明

本页面向开发者。软件用途和下载入口见 [仓库首页](../README.md)，当前发行边界和已知限制见 [验证记录](../RELEASE-VALIDATION.md)。

## 项目结构

| 目录或文件 | 职责 |
|---|---|
| `main.js`、`app/`、`window/`、`services/`、`security/` | Electron 桌面窗口、托盘、进程管理与访问控制 |
| `resources/memoryos/dist/` | 手工维护的 JavaScript 内核源码，含记忆、检索、任务、采集、MCP 与 HTTP 服务 |
| `resources/memoryos/memoryos-dashboard-redesign/` | 桌面工作台的 HTML、JavaScript 与样式资源 |
| `resources/app.asar`、`pack-asar.js` | 已打包壳层及其同步打包工具 |
| `tests/` | 桌面壳的 Node 单元检查 |
| `tools/release/` | Windows 离线安装程序源码与构建脚本 |

`dist/` 即本项目维护的源码目录，没有独立的 TypeScript 编译步骤。不要为它补造不存在的 `src/` 或 `tsc` 构建流程。

## 开发环境与依赖

当前发行验证使用 Node 24，Windows 命令使用 PowerShell 7。依赖以 `resources/memoryos/package-lock.json` 为准：

```powershell
cd resources/memoryos
npm ci
```

Git 仓库不分发 Electron/Node 可执行文件、本地模型或 `node_modules`。要运行完整桌面版，可使用 Releases 中的 Windows 包作为运行环境；它们与源码按版本对应。

## 常用检查

在 `resources/memoryos/` 中运行：

```powershell
npm test
npm run lint
npm run lint:sql
npm run lint:boundary
npm run lint:silent
```

`npm test` 自动发现检查脚本；需要外部模型或特定环境的项目可能跳过，必须结合输出判断。0.1.4 中静默异常检查仍有既有 HIGH 告警，不应将其描述为全绿。

在仓库根目录运行桌面壳检查：

```powershell
node --test tests/shell.test.js
node pack-asar.js --check
```

需要 UI 检查时，内核还提供 `npm run ui:walk`、`npm run ui:walk:settings` 和 `npm run ui:walk:a11y`。它们需要对应的浏览器和服务环境，不等同于默认聚合检查。

## 隔离数据后再运行

单独启动内核时，应显式指定独立测试数据目录，避免读写日常使用的数据库：

```powershell
$testProfile = Join-Path $env:TEMP 'MemoryOS-dev-profile'
New-Item -ItemType Directory -Force -Path (Join-Path $testProfile 'data') | Out-Null
$env:MEMORYOS_DATA_DIR = $testProfile
$env:MEMORY_DB = Join-Path $testProfile 'data/memory.db'
$env:MEMORY_PORT = '18787'
$env:EMBED_MODE = 'fake'
node dist/dashboard.js
```

`fake` 仅用于可重复的开发夹具，不代表已验证真实语义检索。实际模型检查需改用 `local` 并提供对应模型缓存。访问页面/API 时，使用该隔离数据目录生成的令牌，不要混用日常桌面版的令牌。

## 壳层打包

修改壳层源码后，执行：

```powershell
node pack-asar.js
node pack-asar.js --check
```

打包器以现有 `resources/app.asar` 为种子，只同步明确列入 `SYNC_FILES` 的壳层文件。新增壳层模块时要同步更新清单。内核从磁盘 `resources/memoryos/dist/` 启动，内核改动需要重启相应进程。

Windows 安装程序构建方式见 [发行说明](../RELEASE-20261117.md)。

## 提交边界

- 此公开发行只包含个人版；企业版与其运行资料不纳入本次源码。
- 用户数据、模型、运行环境、依赖安装目录和临时实验产物不提交。
- `.env`、API Key、访问令牌、签名私钥和数据库不提交。
- 未完成的 `android/` 与 `window/tray-native/` 源码保持忽略。种子 `app.asar` 中原有的运行模板按发行说明保留。
- 提交前核对暂存文件清单，并运行与改动相关的检查；文档改动不需要重复跑所有业务检查。
