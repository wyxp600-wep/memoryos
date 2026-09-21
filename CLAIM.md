# CLAIM.md — 工作分区与文件归属（真相源）

> 用途：多 AI / 多会话并行时的**单一归属事实源**。开工前先读本文件；改动前确认目标文件在本分区内；
> 越界或需要跨分区改动 → 先在对话里报备并在此登记，再动手。
> 建立依据：2026-09-16 实测两次撞车（`server.js` 被两方交替改坏、`snapshot-routes.js` 注释被接错行）。
> 维护：由**验收/门禁分区（A）**负责更新；每次归属变化追加到 §4 变更记录。

---

## 1. 分区定义

| 分区 | 职责 | 归属文件（glob） |
|---|---|---|
| **A｜验收与门禁**（当前：本会话 `workbuddy`） | 冒烟、静态体检、路由快照基线、审计探针、验收文档、任务池收口 | `resources/memoryos/dist/lint-*.js`、`resources/memoryos/dist/smoke-*.js`、`resources/memoryos/dist/snapshot-routes.js`、`resources/memoryos/dist/audit-probe.js`、`outputs/route-snapshot.json`、`CLAIM.md`、`.workbuddy/**` |
| **B｜生产实现**（当前：并行会话 `wyxp600`） | 内核与看板实现：MCP 工具、DB/迁移、dashboard 路由模块、守护进程、Electron 壳与前端 | `resources/memoryos/dist/server.js`、`resources/memoryos/dist/db.js`、`resources/memoryos/dist/dashboard*.js`、`resources/memoryos/dist/daemon.js`、`resources/memoryos/dist/reconcile.js`、`resources/memoryos/dist/exec-tools.js`、`resources/memoryos/dist/agent*.js`、`resources/memoryos/dist/obsidian-sync.js`、`resources/memoryos/dist/ingest.js`、`services/**`、`memoryos-dashboard-redesign/**`、`pack-asar.js`、`main.js` |
| **C｜文档与规则**（共写） | 规则手册、方案/审查/实施记录 | `docs/**`、`*.md`（根目录方案与记录） |
| **D｜运行时数据**（只读，除显式授权） | 生产库、快照、artifact | `%APPDATA%/MemoryOS/data/**` |

---

## 2. 协作规则（硬性）

1. **改前重读**：编辑任何文件前先 `Read` 当前内容；目标区域已被他人改动 → **停手并在对话里报告**，不要硬合。
2. **短提交、单一主题**：每次改动立即 commit（信息含"为什么"）；不允许把多个主题堆在一个提交里。
3. **跨分区修复例外**：发现他分区文件的缺陷时，允许**最小修复 + 立即提交**，但必须：① 在提交信息里写明"由 A 分区验收发现"；② 同步在 §4 登记；③ 修复范围仅限该缺陷本身，不顺手重构。
4. **验收门禁只认 A 分区的脚本**：`npm test` / `lint` / `lint:sql` / `lint:silent` / `snapshot:check`。B 分区自述的"已通过"必须能被这些脚本复现。
5. **基线重定须自证**：重定 `outputs/route-snapshot.json` 时，提交信息必须写明重定理由（环境漂移 / 迁移影响），否则视为掩盖变更。
6. **tag 由 A 分区在验收通过后打**（如 `p0-exec-face`、`p2-macp-20260916`），避免多方各打各的。
7. **生产库写操作**：仅限显式授权 + 先按 B2 建 `VACUUM INTO` 快照（严禁复制 `.db`）。

---

## 3. 当前门禁入口（A 分区维护）

| 命令 | 作用 |
|---|---|
| `npm test` | 聚合冒烟（**自动发现** `dist/smoke-*.js`，当前 24 项：含 exec / t12 / macp / p26-lifecycle / p26-reconcile / wysiwyg / agent-runs；缺环境项记 SKIP 不记 FAIL） |
| `npm run lint` | 语法检查（含 dashboard 模块与 reconcile） |
| `npm run lint:sql` | SQL 占位符/实参数量体检（含自测） |
| `npm run lint:silent` | 静默 catch 体检（含自测） |
| `npm run snapshot:check` | 路由快照逐项比对（结构契约 145 + 无参 GET 40 + 动态探针 5 + 鉴权） |
| `npm run audit` | 执行面审计探针（临时库真跑，验证 exec_audit 落行） |

---

## 4. 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-09-16 | 建立 CLAIM.md | 依据两次实测撞车：`server.js` 语法错误被两方交替引入；`snapshot-routes.js` 注释被接错行 |
| 2026-09-16 | A 分区跨区修复 3 处（均已提交） | `server.js` task_release 卡侧静默失效（`1f48875`）、`reconcile.js` 补建卡非法状态（本次）、`snapshot-routes.js` 注释接错行（`1f48875`） |
| 2026-09-18 | **停手报告：任务 #4304/#4305 越界冲突（A 分区未改任何文件）** | 起因：用户令 A 分区会话（`workbuddy`）领取 #4304（流式 LLM）/ #4305（inject steer-lite）。实证：两任务目标文件 `dist/agent-core.js`、`dist/agent-runs.js`、`dist/agent-stream.js`、`dist/dashboard-reg-knowledge.js` **全部落在 §1 的 B 分区**（并行会话 `wyxp600`），且 B 分区当晚持续活跃：`agent-core.js` 18:11 → `db.js` 19:11 → `agent-stream.js` 19:27 → `dashboard-reg-cards.js` 21:54。`agent-stream.js` 系 untracked 半成品（2235B，第 43 行 `if (!line.startsWith("data:")) continue;` 处截断，`node --check` = `SyntaxError: Unexpected end of input`，全仓 `grep agent-stream` **零 import** → 孤儿）。按 §2-1「目标区域已被他人改动 → 停手报告，不要硬合」，A 分区**未编辑任何 dist 文件**；#4304/#4305 已 `task_release` 退回 `pending`，待 B 分区交付后由 A 分区验收。另注：工作区另有 12 文件 modified + 2 untracked、diff `+1725/-320` 未提交，与 §2-2「短提交」相悖 |
| 2026-09-18 | 门禁盲区发现（A 分区，待决） | `npm run lint` 为**白名单式**逐文件 `node --check`（显式列举 23 个文件），**不含** `agent-stream.js` → 新文件不入白名单即**不受语法门禁覆盖**，坏文件可长期潜伏且 `lint` 仍全绿。建议 §3 增补「门禁覆盖 = 白名单 ∪ 显式 ignored 清单」，或让 lint 先枚举 `dist/*.js` 再排除，避免同类盲区 |
| 2026-09-21 | **A 分区执行 P0 仓库卫生（仅无归属物）** | 归档 26 个无归属物至 `archive/20260921-仓库卫生/`（14 个 `tmp-*` + 12 个 `resources/app.asar.bak-*`），按原相对路径保存、可原路还原；**未触碰 B 分区任何文件**。实测 B 分区（`wyxp600`）9-21 21:19/21:26 仍在写入 `daemon.js`/`PROJECT_MEMORY.md`；其 **18 文件 +845/-415 跨 09-19→09-21 未提交**（与 §2-2「短提交」相悖），A 分区停手报告，待 B 分区自行收口 |
| 2026-09-21 | A 分区跨区最小修复：`services/sign-manifest.js`（P0-4 私钥隔离配套） | 起因：密钥目录 `security/update-signing/`（私钥明文，虽不入 git 但存于仓库内）已移出至 `~/Desktop/_memoryos-signing-keys/`，原 `KEY_DIR` 硬编码会使签名 CLI 断链。修复范围**仅限** `KEY_DIR`（改为 `MEMORYOS_SIGN_KEY_DIR` env 优先 + 新默认位置）与 2 处注释，不涉其他逻辑。实证：`node --check` exit=0；`keygen` 返回拒绝覆盖（证明新路径可读）；`sign`+`verify` 端到端 ✅ 验签通过 |
| 2026-09-21 | A 分区跨区最小修复：`pack-asar.js` SYNC_FILES 补 7 项（P0 打包盲区） | 实证：壳层 16 个文件中 7 个（window/main-window、welcome-window、services/scheduler、port、security/token、ipc、app/lifecycle）**在 asar 内但不在 SYNC_FILES** → 改动重打包后静默丢失（与 09-18 lint 白名单盲区同类）。修复仅限 SYNC_FILES 清单追加。顺带用 P0 的 webPreferences 改动走全链路验证：`node pack-asar.js` 18 文件 0 不一致 → MemoryOS 重启 → 4 进程 + 8787 LISTENING + 仪表盘 200 且响应体含标题与挂载点。另发现并顺带修复欠账：main.js/scheduler.js/core-process.js 上次打包后已提交新版未入 asar。注：本次重打包产生的新 `app.asar.bak-*` 已按当日卫生约定移入 `archive/20260921-仓库卫生/`（git 中的旧 asar 即回滚点） |
| 2026-09-21 | **更正：原评估「令牌走 URL query 明文」「CSP 未设置」两条判断有误**（A 分区自查） | 起因：原评估只 grep 了 `dist/server.js` 就下结论，但**鉴权与安全头实际在 `dist/dashboard.js`**（8787 的 HTTP 面），grep 错了文件。实测内核早已实现：① 常数时间令牌比较（sha256 + timingSafeEqual，`dashboard.js:114-118`）；② 令牌四通道（query / x-memory-token / cookie / Bearer，`:141`）；③ 首次带 `?token=` 自动种 HttpOnly+SameSite=Strict cookie 并 **302 剥离 URL 令牌**（仅浏览器导航生效，API 调用行为不变，`:145-158`）；④ 令牌缺失 fail-closed 503（`:127-131`）；⑤ **CSP 已设置**（`:100-103` 定义、`:161-166` onSend 下发，含 `object-src 'none'`、`frame-ancestors 'none'`）+ nosniff + no-referrer。教训：**评估安全项必须 grep 到实际 HTTP 面文件，不能只查主进程文件名** |
| 2026-09-21 | A 分区跨区最小修复：`dist/restart-core.js` 令牌去 URL（P0 收尾，`ed4308f`） | 3 处自检 fetch 由 `?token=` 改为 `x-memory-token` 头（内核 `dashboard.js:141` 已原生支持）。配套 `window/main-window.js` 改走 `session.defaultSession` 种 cookie 后加载裸 URL，消除内核 302 之前的窗口期，失败回退旧方式。实证三通道：裸请求 401 / 仅 cookie 200(240KB 含标题) / 仅头 200 返真实数据；asar 重打包 18 文件 0 不一致；主窗口标题「Agent - MemoryOS」证明 cookie 鉴权在真实 Electron 会话生效。注：`window/tray.js` 外部浏览器打开仍用 `?token=`，因无法注入 cookie，属预期设计 |
| 2026-09-21 | **P1 文档补齐：新增 `README.md` 仓库入口 + 修正两处过期计数**（A 分区，C 分区文档） | 起因：仓库根无 README，40+ 份 `*.md` 散落无入口。新增 `README.md`（形态/架构/进程/鉴权/工具面/命令/回滚/协作约定 + 深入文档索引）。**实证发现两处过期计数**：① `docs/agent-使用说明.md` 5 处写「18 工具」，实测 `node dist/server.js --list-tools` = **26 个常驻工具**（+3 执行面，默认关闭），已改并加「以 --list-tools 为准」提示；② 本文件 §3 与说明文档写「21 项冒烟」，实测 `node dist/smoke-all.js --list` = **24 项**，已改。README 中所有引用路径逐个 `Test-Path` 校验通过；`npm run lint` exit=0。另核实：`smoke-all.js` 为**自动发现** `dist/smoke-*.js`（优于 `lint` 的白名单式），09-18 记录的 `agent-stream.js` lint 盲区已被 B 分区关闭（该文件现已入列且 `node --check` 通过） |
