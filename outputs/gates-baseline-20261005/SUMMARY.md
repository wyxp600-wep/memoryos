# 门禁基线（改前状态）· 2026-10-05 · P0 起点取证

> 锚点：HEAD `68757ee`（节点画布交接详版化），工作树零 M 文件（10-04 遗留 4 M 已由 68757ee 收口），
> 生产 dashboard PID 26700（跑 68757ee 之前的 dist，P1 重启后生效新代码）。
> 实证：`/api/summary` → `restricted.enabled=false`（cardCreate/cardDispatch 全开，非受限模式）。

## 门禁结果（9 项，日志 01-09 同目录）

| # | 门禁 | 结果 | exit | 备注 |
|---|---|---|---|---|
| 01 | lint（87 文件语法） | 87 PASS / 0 FAIL | 0 | 绿 |
| 02 | lint:sql | 515 处调用 0 不匹配 | 0 | 绿 |
| 03 | lint:silent | **❌ 11 HIGH / 68 MED** | 1 | **存量**（未改任何代码即红）；pre-commit 不强制（只跑 3/3：npm test/lint/shell.test） |
| 04 | npm test（聚合冒烟） | 23 PASS / 0 FAIL / 2 SKIP（25 项） | 0 | 绿 |
| 05 | snapshot:check | **❌ 18 硬差异**（改前） | 1 | **存量**：基线旧版（见下） |
| 05b | snapshot 重定基线 | 257 路由重新烘焙 → check ✅ | 0 | 理由入提交信息 |
| 06 | nodeboard e2e（隔离库） | 39 / 0 | 0 | 绿 |
| 07 | a11y-ui-walk（Chrome 实走） | 12 / 12 | 0 | 绿，基线 json 已刷新 |
| 08 | workbench-ui-walk（66 项） | 66 / 66 | 0 | 绿（W30 派发提升 202 实证） |
| 09 | shell.test（仓根） | 25 pass / 0 fail | 0 | 绿 |

## 红项分诊（全部存量，非本批引入）

### R1 · snapshot 18 处硬差异 = 基线旧版（已重定关闭）
差异明细（05-snapshot.log）：新增路由 agent-cards exec/stream/live/live-status（GET/HEAD/POST stop，节点画布 P2/P3 批次产物）、
`/canvas-editor.js` 静态路由、`/` 与 `/app.js` 响应体漂移（中文化 4aa668c 及后续）——均**已提交代码**未重新烘焙基线。
处置：`npm run snapshot` 重定（257 路由），check 转绿；随第 3 步提交①入库，理由写入提交信息（CLAIM §2-5）。

### R2 · lint:silent 11 HIGH（9 个在本批目标文件内 → 随提交修；2 个越界 → 只列报）
| 位置 | 处置 |
|---|---|
| dist/dashboard-reg-cards.js: 253/261/270/746/832/1805/1899（7 处） | 本批目标文件 → 随第 3 步提交补日志/显式处理 |
| dist/dashboard-reg-cliexec.js: 187/209（2 处） | 同上 |
| dist/dashboard-reg-design.js:206 | **越界，只列报不修**（另批） |
| dist/server-reg-memory.js:268 | **越界，只列报不修**（另批） |

### R3 · 4 个 M 文件（10-04 遗留）
已由 68757ee（15:32 他会话）收口提交，工作树干净，**本批无需再收口**。
