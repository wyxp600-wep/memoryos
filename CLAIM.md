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
| `npm test` | 聚合冒烟（21 项：含 exec / t12 / macp / p26-lifecycle / p26-reconcile） |
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
