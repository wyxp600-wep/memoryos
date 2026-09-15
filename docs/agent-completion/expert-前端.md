# 前端专家文档：Agent 执行过程可视化 + 审批 UI（MemoryOS Dashboard）

> 专家角色：前端开发者 ｜ 产出日期：2026-09-15 ｜ 引用事实包：`docs/agent-completion/FACTS-PACK.md`（F1–F15、B1–B3）
> 技术栈约束：**无构建工具、无框架、原生 JS + echarts**；Electron 内嵌页（Chromium）；CSP `script-src 'self'` 禁止内联脚本与 CDN（`resources/memoryos/dist/dashboard.js:81-83`）。

---

## 结论先行（TL;DR）

1. **呈现层真实位置不在 dashboard.js 里**：`dashboard.js`（146KB）是 **Fastify 服务端**，UI 是独立文件 `resources/memoryos/memoryos-dashboard-redesign/{index.html, app.js}`，经 `resolveUiDir()`（`dashboard.js:52-64`）+ `/`、`/app.js`、`/echarts.min.js` 三个只读路由（`dashboard.js:1229-1231`）伺服。所谓"内嵌 UI"指 UI 是原生内嵌 HTML/JS、不引框架——**改呈现 = 改 index.html + app.js，不动 dashboard.js 的既有行为**。
2. **推荐增量方案**：新增独立路由页 `#/runs`（执行中心）+ 在现有 `#/agent` 页内嵌"执行中任务卡片"条带；推送通道用 **SSE（EventSource）**，带 Cookie 令牌即可（首访 `?token=` 自动种 cookie，`dashboard.js:99-119`，EventSource 原生支持），轮询 `/api/agent/runs/:id?since=seq` 做降级。
3. **B1 合规切分**：展示类路由（读 runs/output/artifacts/diff）= 纯呈现，允许；**审批三键端点会改变 writeGate 行为（修 F7，`agent-core.js:215-224` 二值布尔 + `agent.js:118-121` gate=null 全放行），属于"改功能"，须单独获得用户同意**，不与呈现改动混入同一提交。
4. **大输出**：默认 head/tail 各 50 行折叠展示 + 行级虚拟滚动（DOM 可见行 ≤ ~60 行），输出全文落盘为 artifact，前端按 chunk 拉取（单请求 ≤ 256KB），全程内存驻留 ≤ ~2MB。
5. **审批 UI**：L0–L4 风险徽标 + 将执行命令/文件路径/网络目标 + 折叠参数 JSON，三键「本次允许 / 本会话允许 / 拒绝」；被拒后时间线该步标 ✋ + 内联反馈条（复用 `app.js:4701-4704` 的 denied 展示先例）。

---

## 0. 事实基础（引用，不复述）

| 编号 | 事实 | 位置 |
|---|---|---|
| F3 | `MAX_TOOL_RESULT=3000` 头部截断，shell 尾部错误被腰斩 | `agent-core.js:158` |
| F7 | writeGate 二值；`--work` 默认 gate=null 零审批（P0） | `agent-core.js:215-224`, `agent.js:118-121` |
| F15 | onStep 外抛 `result.slice(0,500)`，dashboard 侧可能二次泄漏 | `agent-core.js:230` |
| onStep 事件 | `llm/tool_call/tool_result/tool_repeat/answer/write_denied/max_steps` | `agent-core.js:168,192,194,209,220,225,230,234,242` |
| 现有 agent 页 | 页 `#/agent`（`index.html:4116-4143`），一次性 POST `/api/agent/chat` 阻塞等待（`dashboard.js:2562-2623`），工具日志用 `<details>` 折叠（`app.js:4696-4700`） | — |
| 轮询先例 | `loadDaemonHealth` 5min（`app.js:248`）、`_cardPollTimer`（`app.js:4424`） | — |
| 任务 API | `/api/tasks` 返回 buckets，字段 `id/status/assignee/deps/blocked/body/conclusion/confidence/created_at` | `dashboard.js:554-584` |
| CSP | `script-src 'self'; connect-src 'self'`；样式允许 inline | `dashboard.js:81-83` |
| B1 | 写操作先获同意；改版只改呈现不改功能 | FACTS-PACK |

**关键推论**：现有 `/api/agent/chat` 是**单次阻塞 POST**（`dashboard.js:2594` `await runAgent(...)`），响应到达前前端对执行过程零感知。要"展示 agent 执行工具调用的过程"，呈现层可以零改动做到"事后回放"（响应里已有 `toolLog`/`elapsedMs`，`dashboard.js:2610-2621`），但**过程实时性必须新增一条流式通道**——这是本文新增路由的唯一动机。

---

## ① 执行可视化组件清单

| # | 组件 | 职责 | 数据源 |
|---|---|---|---|
| V1 | **RunCard（执行中任务卡片）** | 页头横排卡片：每个 agent 运行一个卡，状态四态 `running（运行中）/ awaiting_approval（等待审批）/ failed（失败）/ aborted（已中止）`，附工具调用计数、已耗时、风险徽标 | `GET /api/agent/runs` |
| V2 | **Timeline（工具调用时间线/步骤流）** | 垂直步骤流，每步：工具名、参数摘要（≤120 字，防 F15 泄漏面扩大，摘要经脱敏白名单）、状态图标（✓/✗/✋/◌ 运行中/⏭ 重复被拦）、耗时、结果预览（≤3 行）；可展开完整参数 JSON | run 的步骤数组 |
| V3 | **TerminalView（终端输出查看器）** | 步骤输出面板：ANSI 颜色渲染、等宽字体、长输出折叠（head/tail）、虚拟滚动、复制 | `GET /api/agent/runs/:id/steps/:sid/output?chunk=0` |
| V4 | **DiffView（diff 查看器）** | 写文件类工具（patch/file_write）的前后对比：unified / split 双模式，行级高亮（+/-/context） | `GET /api/agent/runs/:id/steps/:sid/diff` |
| V5 | **ArtifactList（artifact 浏览与下载）** | 运行产物列表（测试报告、构建输出、生成文件）：名称/大小/类型/时间 + 「查看」(接 V3/V4) + 「下载」 | `GET /api/agent/runs/:id/artifacts` + `GET /api/artifacts/:id` |
| V6 | **StepDetail（步骤抽屉）** | 点时间线某步滑出右侧抽屉：聚合 V3+V4+参数 JSON+审批记录；与现有关卡右键抽屉同源交互（`app.js:3003-3031` drawer 先例） | V2 选中项 |

**B1 判定**：V1–V6 全部是"读现有/新增运行数据并呈现"，属于**只改呈现**，允许。其中 V5 的"下载"端点是新增只读能力（把 artifact 文件回传浏览器），判定为呈现层（不写库、不执行副作用），允许；若 artifact 含代码文件，下载前由后端统一打脱敏标记即可。

---

## ② 审批 UI

### 2.1 风险分级确认弹窗（ApprovalModal）

| 风险级 | 语义 | 触发工具面（对应待加执行工具） | 徽标配色（复用主题变量） |
|---|---|---|---|
| L0 | 纯只读 | search/read/ls/grep | `--success` #34d399 / #22c55e（暗） |
| L1 | 工作区写 | file_write/patch（项目内） | `--warning` |
| L2 | 破坏性写 / 库外写 | 删除、越出工作区的写 | `--danger` 浅档 |
| L3 | 命令执行 / 网络 | shell、curl/浏览器导航 | `--danger` |
| L4 | 不可逆 / 凭据 | 删除数据、DB 写、密钥操作 | `--danger` 实底白字 |

（配色取自 `index.html:24-61` 主题变量，明暗双主题自动适配。）

**弹窗内容契约**（后端在 SSE `approval_required` 事件里下发）：

```
{
  "runId","stepId","tool","risk":"L2",
  "command": "将执行的命令（shell 类才有，转义后原文展示）",
  "paths": ["将写入/删除的文件路径数组"],
  "network": ["网络目标 host:port（网络类才有）"],
  "argsJson": { …完整参数，前端折叠展示… },
  "expireMs": 120000   // 审批超时自动按拒绝处理（超时策略由后端定，前端只倒计时）
}
```

**三键**：

```
┌─────────────────────────────────────────────┐
│  [L2 徽标] 工具 file_write · 步骤 3/7        │
│  将写入：C:\...\memoryos\src\agent-core.js    │
│  命令：npx vitest run agent-core（若有）       │
│  参数（折叠）{…}  复制JSON                     │
│  倒计时 01:23                                  │
│ [本次允许] [本会话允许] [拒绝]                  │
└─────────────────────────────────────────────┘
```

- **本次允许**：`POST /api/agent/runs/:id/steps/:sid/approval {decision:"allow"}`，仅本步放行。
- **本会话允许**：`{decision:"allow_session", scope:{tool, risk}}`，同 run 内同工具同级后续步骤免弹窗（会话粒度，进程退出即失效——不落地策略，避免新增持久面）。
- **拒绝**：`{decision:"deny"}`；agent 收到拒绝后转入只读收尾（复用 `agent-core.js:221` 既有"用户拒绝写操作"回灌语）。

**被拒后的反馈展示**（前端即时，不等后端）：
1. 该步时间线节点变 ✋ 橙色（`--warning`），卡片状态回到 `running`；
2. 弹窗位置内联退化为反馈条：「已拒绝 `file_write`（L2）· agent 将基于只读信息收尾」（先例：`app.js:4701-4704` denied 条）；
3. 若用户 30s 内反悔，反馈条上提供「撤销并重新确认」一次（发 `decision:"rescind_last_deny"`，后端仅当该步尚未回灌时才接受——前端不确定时按后端 409 提示"该步已生效，无法撤销"）。

**B1 判定**：审批端点 + writeGate 从二值升级为 `(tool,risk,decision)` 判定，是**功能变更**（直接对应修 F7 的 P0 项），必须独立立项、独立备份（git tag）、经用户同意后实施；弹窗 UI 本身是呈现，可先行落位但按钮接 501 占位，不得在同意前默认为"放行"。

---

## ③ 与现有 dashboard.js 内嵌 UI 的集成方式

### 3.1 独立路由页 vs 嵌入：双轨增量

| 改动 | 形式 | B1 归属 | 落点 |
|---|---|---|---|
| `#/runs` 执行中心页 | **新独立路由页**：`PAGE_TITLES` 增 `runs:['执行中心','Agent 工具调用过程 · 审批 · 产物']`（`app.js:1080`），`index.html` 增 `<section class="page" id="page-runs">` + sidebar 一个 `.nav-item`（`index.html:3099-3177` 模式），哈希路由 `hashchange`（`app.js:1104`）自动接管 | 呈现（新增页面 = 纯呈现增量，不改既有页行为） | index.html + app.js |
| agent 页内嵌卡片条带 | `#/agent` 页 `agentStatusLine`（`index.html:4131`）下方插一行 RunCard 条带（只列 running/awaiting_approval 两态）；点击卡 → `navigate('runs')` 并定位 | 呈现 | index.html + app.js |
| `#/agent` 聊天页改造 | **不改**：现有 `<details>` 工具日志（`app.js:4696-4700`）保留，只在无运行中的卡时显示（避免两套渲染同一数据） | 呈现（无操作） | — |
| 新增只读 API：`GET /api/agent/runs`、`/runs/:id`、`/steps/:sid/output`、`/diff`、`/artifacts`、`/api/artifacts/:id` | dashboard.js 内**追加路由**（Fastify `app.get` 追加，不动既有路由） | 呈现（只读增量） | dashboard.js 追加块 |
| SSE 通道 `GET /api/agent/runs/:id/stream` | dashboard.js 追加 | 呈现（只读流） | dashboard.js 追加块 |
| 审批 POST 端点 + writeGate 升级 | dashboard.js + agent-core.js | **功能变更，须单独同意** | 单独提交 |

**增量原则（写进验收标准）**：① 全部改动是"追加"，不修改既有路由行为与既有页面 DOM（既有 16 个 `data-route` 页原样）；② 新页在 `RESTRICTED` 模式（`app.js:142-152`、`dashboard.js:33-51`）下：读端点正常、审批三键与下载置灰并挂 `restricted()` 同款 403 文案（"由系统统一派发"体例）；③ 改前按纪律建 `data/memory.db.pre-*` 快照与 git tag（B1 第三句）。

### 3.2 推送通道：SSE 为主，轮询降级

**推荐 SSE（EventSource）**，理由：

1. **现有阻塞 POST 无法中途出数据**（`dashboard.js:2594`）：把 `runAgent` 的 `onStep`（`agent-core.js:168` 回调，现有类型 8 种）改为写进 per-run 环形事件队列，SSE 路由从队列 tail 读出即可；onStep 事件字段已含 `tool/args/ok/result`，前端零协议发明。
2. **CSP 允许**：`connect-src 'self'`（`dashboard.js:81-83`）同源 SSE 合法；Electron Chromium 对 127.0.0.1 SSE 无 CORS/Origin 问题。
3. **令牌**：EventSource 不能带自定义头，但首访 `?token=` 已自动种 `memoryos_token` cookie（`dashboard.js:99-119`），同源请求自动携带，鉴权面不变。
4. 对比轮询：daemon-health 5min 轮询（`app.js:248`）粒度太粗；工具步耗时在秒级，轮询 1–2s 意味着每开一个 run 页就是 60+ 次/分 的 DB 读，而运行通常 <16 步（`maxSteps` 上限，`dashboard.js:2592`），**SSE 事件数 ≪ 轮询请求数，且零惊群**。

**SSE 事件契约**（每行 `event: <type>\ndata: <json>\n\n`）：

```
event: step        data: {seq, type:"tool_call", tool, argsPreview, risk, t}
event: step_end     data: {seq, stepId, ok, elapsedMs, outChars, artifactId?}
event: approval_req data: {stepId, risk, command, paths, network, argsJson, expireMs}
event: approval_ack data: {stepId, decision:"allow|allow_session|deny|timeout"}
event: answer       data: {seq, preview}      // 摘要 ≤300 字，规避 F15
event: done         data: {seq, status:"ok|error|aborted", toolCalls, elapsedMs}
```

**降级**：`EventSource` onerror → 自动切 2s 轮询 `GET /runs/:id?since=<lastSeq>` 补事件；页面 `hashchange` 离开 runs 页时 `es.close()`（防多页同连）。断线重连浏览器原生完成，服务端按 `Last-Event-ID` 语义回补。

**F15 联动**：SSE 的 `answer`/`step` 只发 ≤300 字预览 + `outChars` 计数，全文走 V3 按 chunk 拉取——顺带把"二次泄漏敏感内容"的事实包 F15 在呈现层收敛（后端 `result.slice(0,500)` 原文不再直接进前端）。

---

## ④ 大输出性能

### 4.1 与后端 artifact 契约配合（前端假设，需后端专家确认）

- 输出/日志 > 4KB 不落事件，落盘为 artifact：`data/artifacts/<runId>/<stepId>.log`；事件只带 `artifactId + outChars`。
- **chunk API**：`GET /runs/:id/steps/:sid/output?chunk=0&max=256`（256KB/块，默认 head/tail 块）；`?range=a-b` 取行区间。
- **默认折叠 head/tail**：首屏只拉 head 50 行 + tail 50 行（两次小请求），中间显示「…跳过 N 行 [查看中段]」；点中段再按需 chunk 拉取。

### 4.2 前端内存与渲染预算

| 项 | 预算 | 机制 |
|---|---|---|
| DOM 行数 | 可见 + 缓冲 ≤ 60 行节点 | **虚拟滚动**：外层 `.term-scroll`(overflow:auto, 固定高) + 内层 `.term-spacer`(height=总行数×行高, position:relative) + 绝对定位 `.term-viewport`(transform:translateY(scrollTop))；`scroll` 事件 rAF 节流（先例：`app.js:4266-4297` 已含同款 wheel/pointer 虚拟渲染先例，图谱页同款手法可抄） |
| 驻留文本 | ≤ 2MB/run | 只驻留"已拉取的 chunk + head/tail 行数组"；行数组存 `Array<string[]>`（已解析 ANSI token），原始文本拉完即释放 |
| ANSI 解析 | 惰性 | 只对"进入视口的行"解析为 `<span>`；缓存 key=行内容 hash，切主题时按 class 重着色不重解析 |
| 事件流 | 环形缓冲 | run 事件队列前端侧 `RingBuf(500)`，done 后保留最近 200 条供回放；长 run 不无限 append |
| 多页连接 | 1 条 SSE/run | 路由切换 `es.close()` + 轮询 timer `clearInterval`（对齐 `app.js:4424` _cardPollTimer 管理纪律） |

### 4.3 阈值

- `outChars < 4096`：事件内联全文，V3 直接渲染，无 chunk 请求。
- `4096 ≤ outChars < 512KB`：head/tail 默认 + chunk 翻页。
- `outChars ≥ 512KB`：V3 首屏只显示 head 30 + tail 30 + 「过大输出：下载全文」（接 V5 下载），chunk 翻页仍可用但默认步长 ×4。

---

## ⑤ 组件级实现要点（原生 JS，与现有风格一致）

风格对齐既有代码：**IIFE 模块 + `$('#id')` 工具 + 事件委托 + CSS 变量 + 内联样式为主/`index.html` 已有 class 复用**（先例：`app.js:4680-4745` agent 模块整段就是这种写法）。不引任何库（CSP `script-src 'self'` 下也不引本地新 .js 除非放 UI_DIR——如需 diff/ANSI 工具函数，**加在 app.js 尾部新模块段**，不新增文件，保证 `dashboard.js:1229-1231` 三路由不动）。

### 5.1 RunCard（V1）

**DOM**（`index.html` page-runs 内）：

```html
<div class="run-board" id="runBoard">            <!-- 横排 flex wrap -->
  <div class="glass-card run-card" data-run="r_123">
    <div class="run-card-head">
      <span class="run-status-dot running"></span>
      <span class="run-title">memoryos · 修复 F3 截断</span>
      <span class="run-risk-badge" data-risk="L2">L2</span>
    </div>
    <div class="run-meta mono">7/16 步 · 已用工具 5 · 42.3s</div>
    <div class="run-status-line">◌ 运行中 · shell(test)</div>
  </div>
</div>
```

**事件**：`#runBoard` 点击委托（`document.addEventListener('click', e => e.target.closest('.run-card'))`，先例 `app.js:2675`）→ `navigateDetail('runs', runId)`；`data-status` 四态 `running/awaiting_approval/failed/aborted`，dot 色：`--success / --warning / --danger / --archived`；`awaiting_approval` 时整卡加 `outline: 2px solid var(--warning)` 呼吸动画（复用 daemon dot 的 `pulse` keyframes，`app.js:219`）。

**数据字段**（`GET /api/agent/runs` → `{runs:[…], total}`）：
```
{runId, title, status, stepIndex, maxSteps, tool, toolCalls, risk, elapsedMs, startedAt, error?}
```
轮询：页面停留时 3s 一次（仅 running/awaiting 卡存在时开 timer，全终态自动停——省 DB 读）。

### 5.2 Timeline（V2）

**DOM**：

```html
<ol class="timeline" id="runTimeline">
  <li class="tl-step" data-step="3">
    <div class="tl-node ok"></div>
    <div class="tl-body">
      <div class="tl-line1"><span class="tl-tool mono">shell</span>
        <span class="tl-args text-muted">test src/agent-core.test.js</span>   <!-- ≤120 字摘要 -->
        <span class="tl-state">✓ 0.8s</span></div>
      <div class="tl-preview mono text-muted">…最后 2 行结果预览（≤3 行，CSS line-clamp）</div>
      <details class="tl-args"><summary>参数 JSON</summary><pre>…</pre></details>
      <button class="tl-open-diff">查看 diff</button>  <!-- 仅写文件类步骤 -->
    </div>
  </li>
</ol>
```

**事件**：`click .tl-step` → 打开 StepDetail 抽屉（V6，先例 `app.js:3019-3031` drawer/backdrop 手法）；`click .tl-open-diff` → 抽屉切 Diff 标签；SSE `step/step_end` 到达时 **append 新 `<li>` 并 `scrollIntoView({block:'nearest'})`**（仅当用户在 2s 内滚过才不打断，跟随式）。

**数据字段**：`{stepId, tool, argsPreview(≤120), state:'pending|ok|error|denied|skipped_dup', ok?, elapsedMs?, preview?(≤3行), risk, hasDiff?, artifactId?}`。`skipped_dup` 对应 `tool_repeat` 事件（`agent-core.js:209`）。

### 5.3 TerminalView（V3）

**DOM**：

```html
<div class="term-view" id="termView">
  <div class="term-bar"><span class="mono term-title">shell · step 3</span>
    <span class="term-count">共 4821 行 · 231KB</span>
    <button class="term-copy" data-copy>复制</button>
    <button class="term-toggle-head">head 50</button>
    <button class="term-toggle-tail">tail 50</button></div>
  <div class="term-scroll">
    <div class="term-spacer" style="height:144630px">
      <div class="term-viewport"><!-- 虚拟窗口内 ~60 行 --></div>
    </div>
  </div>
</div>
```

**ANSI 渲染（纯函数，约 40 行）**：

```js
// 只处理 SGR（30-37/39/40-47/49/90-97/99/0/1/3/4）+ 256 色(38;5;n/48;5;n) + truecolor(38;2;r;g;b)
function ansiToHtml(line){
  let html='', cur={};
  const re=/\u001b\[([0-9;]*)m/g; let m, i=0;
  while(m=re.exec(line)){
    html+=wrapSeg(line.slice(i, m.index)); i=re.lastIndex;
    m[1].split(';').filter(Boolean).forEach(c=>{ /* 更新 cur，未知码忽略 */ });
  }
  html+=wrapSeg(line.slice(i));
  return html.replace(/\u001b\[[0-9;]*m/g,''); // 先剥残留再 wrap
}
// wrapSeg: esc() 后按 cur 拼 class：term-t-red / term-b-green / term-br-12 等
// 256 色表：module 级 const PALETTE256=['#000','#c00',…]，class 用 inline style color（style-src 'unsafe-inline' 已放行，dashboard.js:81）
```

**虚拟滚动**（rAF 节流，行高固定 19px）：

```js
sc.addEventListener('scroll', ()=>{ if(rAF) return; rAF=requestAnimationFrame(()=>{
  const top=Math.floor(sc.scrollTop/19)-2, n=Math.ceil(sc.clientHeight/19)+4;
  paint(top, Math.min(top+n, lines.length));
  vp.style.transform=`translateY(${top*19}px)`; rAF=0; }); });
// paint：viewport.innerHTML = rows.slice(top, top+n).map(ansiCache).join('')
```

**head/tail 折叠**：`outChars>4096` 时初始 `lines=head50.concat([…跳过N行…placeholder行]).concat(tail50)`；placeholder 行点击 → 按 200 行/chunk 拉 `?range=` 插入数组并补 spacer 高度；「展开全部」仅在 `outChars<512KB` 时可见。

**复制**：`navigator.clipboard.writeText(原始行)`（不复制 HTML，避免颜色码）；抽屉关闭时 `sp.innerHTML=''` 释放。

### 5.4 DiffView（V4）

**DOM**：

```html
<div class="diff-view">
  <div class="diff-bar">
    <label><input type="radio" name="diffMode" value="unified" checked> unified</label>
    <label><input type="radio" name="diffMode" value="split"> split</label>
    <span class="diff-stat">+14 −3 · 2 文件</span></div>
  <div class="diff-hunk" data-hunk="0">
    <div class="diff-file mono">src/agent-core.js</div>
    <!-- unified: <ol class="diff-rows"><li class="dl-add">+…</li><li class="dl-del">−…</li><li class="dl-ctx">…</li>
         split:   两列 <div class="diff-side"><ol>…</ol></div>×2，行号对齐空占位 -- -->
  </div>
</div>
```

**行级高亮类**：`.dl-add{background:rgba(52,211,153,.12);color:var(--success)}`、`.dl-del{…danger…}`、`.dl-mod{…warning…}`（明暗双主题各一套，照抄 `index.html:43-61` 变量）。

**diff 算法**：写文件类工具由后端下发**前后快照的 unified diff 文本**（后端专家产出，见契约），前端只做 `parseUnifiedDiff(text)→hunks` 渲染，**不在前端跑 LCS**（146KB 级文件比对在 Chromium 主线程 >2s，且呈现层不做计算）；若后端只给 old/new 全文，则前端用约 100 行 Myers-LCS（O(ND)，N 行阈值 2000，超过提示"用后端 diff"）。行号：unified 模式每行前缀 `@@ oldLine` 列（CSS `grid-template-columns:5em 1fr` 两列：旧号+新号对齐显示）。

**数据字段**（`GET …/diff` → `{file, hunks:[{oldStart,oldCount,newStart,newCount,lines:[{type:'add|del|ctx',no_old,no_new,text}]}], truncated}`）。

### 5.5 ArtifactList（V5）

**DOM**：复用 `data-table` 样式（`index.html` 已有表格 class，先例 `page-all` 表格 `index.html:3425-3507`）：

```html
<table class="data-table artifact-table">
  <thead><tr><th>产物</th><th>类型</th><th>大小</th><th>时间</th><th>操作</th></tr></thead>
  <tbody><tr data-aid="a_12">
    <td class="mono">agent-core.test.log</td><td>测试日志</td><td>231KB</td><td>42s</td>
    <td><button data-open>查看</button><a data-dl href="/api/artifacts/a_12">下载</a></td></tr></tbody>
</table>
```

**事件**：`data-open` → 抽屉内 V3/V4（按 artifact.kind 切）；`data-dl` 走 `/api/artifacts/:id`（后端 `Content-Disposition: attachment`）；restricted 模式下 `data-dl` 置灰 + title（`index.html:4131` 同款处理）。**数据字段**：`{artifactId,name,kind:'log|diff|report|file',sizeBytes,mtime,runId,stepId}`。

### 5.6 ApprovalModal（§2 弹窗，实现要点）

```html
<div class="modal approval-modal" id="approvalModal">   <!-- 复用 .modal + backdrop 点击关闭（app.js:1574 先例） -->
  <div class="approval-risk" data-risk="L2">L2</div>
  <div class="approval-tool mono">file_write · step 3/7</div>
  <div class="approval-targets">
    <div class="a-row"><span class="text-muted">写入：</span><span class="mono">C:\…\agent-core.js</span></div>
    <div class="a-row"><span class="text-muted">命令：</span><span class="mono">npx vitest …</span></div>  <!-- 有则显示 -->
  </div>
  <details class="approval-args"><summary>参数 JSON（折叠）</summary><pre>…</pre></details>
  <div class="approval-countdown mono">01:23</div>
  <div class="approval-actions">
    <button class="btn-primary" data-dec="allow">本次允许</button>
    <button class="btn-ghost" data-dec="allow_session">本会话允许</button>
    <button class="btn-ghost danger" data-dec="deny">拒绝</button>
  </div>
</div>
```

**事件**：`data-dec` 点击 → POST §2 端点 + 关弹窗 + 本地即时反馈（§2.1 三态）；**Esc = 拒绝**（键盘先例 `app.js:2675-2707` command-palette Esc 处理，但审批弹窗 Esc 语义为"不做无决策默认"，须确认产品意图后定，保守实现：Esc 不提交仅收起）；倒计时归零 → 显示"已超时，按拒绝处理"反馈条（decision 由后端 `timeout` 事件回填，前端不自行落决策）；`argsJson` 展示前 `esc()` 转义 + 语法高亮用现成 `pre.mono` 配色，**禁止 innerHTML 注入未转义内容**（F8 工具结果注入面在呈现层的对偶约束）。

---

## 验收清单（B1 自查）

- [ ] 既有 16 个路由页 DOM 零改动；改动仅"追加"（新 section、新 nav-item、app.js 尾部新模块段）
- [ ] 所有新 API 只读端点不触发 `restricted()`；写/审批/下载端点在受限模式挂 403（`dashboard.js:33-51` 同款文案体例）
- [ ] 审批三键在功能未获批前接占位 501，不静默放行（B1/F7）
- [ ] 改前：git tag + `data/memory.db.pre-<ts>` 快照（B1/B2）
- [ ] 内存预算：单 run 驻留 ≤2MB、DOM 行节点 ≤60、SSE 1 连接/run、离开页面全清
- [ ] 大输出首屏请求数 ≤ 2（head+tail），中段按需
- [ ] F15：SSE/预览全部 ≤300 字，敏感全文只走 artifact chunk
