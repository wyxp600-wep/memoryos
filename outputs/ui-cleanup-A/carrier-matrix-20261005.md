# P4 载体矩阵表（2026-10-05）

> 用户点名 6 载体：trae、dsh、minimaxcode、workbuddy、opencode、mimocode + 执行层要求（VS Code/ZCode/Trae CDP + CLI 直控「都要」）。
> 状态口径：✅=端到端实证点亮 / 🔶=管线通、差一个明确缺口 / ❌=未连通（已探明原因）。

## 一、CLI 直控通道（dashboard-reg-cliexec.js）

| 载体 | 状态 | 实证 | 缺什么 / 用户要做的事 |
|---|---|---|---|
| **mimocode（mimo）** | ✅ 点亮 | e2e：派发 202→running→review 收口 + 交接卡 + 边 completed；验收文件 `outputs/p4-acceptance/mimo-smoke.md`（ok）；提交 566bd2b | 无 |
| **opencode** | ✅ 点亮 | e2e：任务卡 #183 review 收口 + 交接卡 #184 done + 日志 exit=0 + 验收文件 `opencode-smoke.md`；提交 98e1a13。桌面版自带 `resources/opencode-cli.exe`，登录态复用桌面版，**本机免 key** | 无（注册档案时 launch_overrides.cmd 指完整 exe 路径） |
| **dsh（DeepSeek Harness）** | 🔶 管线点亮 | e2e：拉起成功、任务文本按位置参数送达（promptAsArg 生效）、`MISSING_CREDENTIAL` exit=1、卡片 failed 诚实降级、日志落盘；提交 f977657。旧注释「dsh 无 headless」已实证修正 | **DEEPSEEK_API_KEY**：在 dsh web 的 Models 页填写，或在系统/用户环境变量导出 `DEEPSEEK_API_KEY`（重启 dashboard 后生效） |
| **codex** | 🔶 预设就绪 | 预设 `codex exec --json`（stdin 提示词）；CLI 已在 PATH | 代理 **127.0.0.1:57321** 未启动（用户侧）；启动后即可派发 |
| **claude** | 🔶 预设就绪 | e2e 诚实降级实证：`Not logged in · Please run /login`；日志落盘、边 cancelled、卡 failed、无 Bug③ 回归 | 终端跑一次 `claude /login`（或配 ANTHROPIC_API_KEY） |

## 二、CDP 桌面驾驶通道（dashboard-reg-cdpexec.js）

| 载体 | 状态 | 实证 | 缺什么 |
|---|---|---|---|
| VS Code（Copilot） | ❌ 未连通 | 探针实例（--remote-debugging-port=9301 + 独立 user-data-dir）：CDP attach 成功（7 targets、workbench 页在），但 DOM 无聊天框（chatPanel=false、signIn=false、仅 monaco 内部 ime 输入）；**全新 user-data-dir 没有 Copilot 登录态**。探针实例已清理（PID 33676 终止、9301 释放、临时目录删除） | 主 VS Code 带 CDP 参数启动 + Copilot 已登录 → 现场取选择器写入 launch_overrides |
| ZCode / Trae CN / MiniMax Code / WorkBuddy / DSH Desktop | 🔶 机制已通、选择器未配 | CDP 拉起+attach+screencast 直播的通用机制已由 VS Code 探针实证（launch 带 CDP 口、attach 成功）；各 App 的 exe 均在 `%LOCALAPPDATA%\Programs\` 就位（OpenCode.exe / MiniMax Code.exe / DSH Desktop.exe / WorkBuddy） | 每个 App：主实例登录态下配选择器（聊天输入框/发送键/结束判定）写入该档案 launch_overrides；未配前 📺 直播可用、注入步骤诚实降级 |
| 队列通道（内部 agent 拉取） | ✅ 可用 | dispatch-agent 队列拉取（202 语义）随每次派发实证 | 无 |

## 三、待用户配合项（做完即通，无需再改代码）

1. **codex**：把代理 127.0.0.1:57321 起起来（或给替代联网方案）
2. **claude**：终端执行 `claude /login`（一次性）
3. **dsh**：dsh web → Models 页填 DEEPSEEK_API_KEY（或设环境变量后重启 dashboard）
4. **CDP 系（VS Code/ZCode/Trae/MiniMax Code/WorkBuddy）**：告诉我先配哪一个，该 App 以登录态开着，我现场探选择器写进档案；每个约 5 分钟

## 四、本批提交

| 提交 | 内容 |
|---|---|
| c4b2ea6 | 看板第①批：agent 选择根因修复 + 建卡点选 |
| bb98f9d | 第②批：节点画布并入任务地图、连线全通、布局重做、废双画布 |
| d082129 | 第③批：小白化（去黑话/使用指引/空状态） |
| 566bd2b | P4：CLI_PRESETS 补 mimocode + e2e 脚本 |
| f977657 | P4：dsh 预设 + 执行器 promptAsArg 开关（旧误判注释修正） |
| 98e1a13 | P4：opencode 预设 + promptAsArg 与 launch_overrides.args 共存语义修复 |
