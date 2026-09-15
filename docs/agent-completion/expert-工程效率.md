# 工程效率 · MemoryOS 完整 agent 补全：执行工具面上手 / 工作流 / 分批实施路线

> 专家：工程效率工程师 ｜ 目标：把 MemoryOS 从「记忆中枢 + 任务队列」补成「完整 agent」（shell/文件/测试/git/网络/DB/浏览器执行 + 审批 + 审计）。
> 所有事实引用 `docs/agent-completion/FACTS-PACK.md` 的 F/B 编号；行号均为 2026-09-15 核实值。
> 全部命令按 Windows PowerShell 可直接粘贴书写。

## 0. TL;DR（结论先行）

1. **加执行工具不是架构重写**：agent 循环完全工具无关（A1，`agent-core.js:174-247` `runAgent()` 只认 `tools/list` + `callTool`），加执行工具 = 让 `dist/server.js` 多注册工具 + 修 5 个耦合缺陷（F1/F2/F3/F4/F7），改动集中在 4 个内核文件 + 1 个新文件。
2. **P0 阻断项是审批门禁而非工具**：`agent.js:118-121` 的 `--work/--auto-write` 默认 `gate=null` = 写操作零审批（F7），直接违反硬约束 B1；P0 = 最小执行面（`file_read`/`file_write`/`exec_run`）+ 门禁修复 + `exec_audit` 审计表，验收全部用现有 `.workbuddy` 风格冒烟脚本 + `agent.js -m` 一条命令闭环。
3. **验证基建已齐**：`dist/smoke-mcp.js`（协议级冒烟、临时 DB 自清理）与 `.workbuddy/tmp/list-tools.mjs`（工具清单探测）可直接复用；新工具按同一模板写 `smoke-exec.mjs`，30 分钟内完成「本地起 MCP → 单工具冒烟 → agent 端到端 → 看审计」全链路。
4. **回滚双轨**（符合 B2）：代码走 git tag（仓库已有基线 tag `baseline-20260914-pre-fullopt`，但工作树有 22 个未提交改动，**开工前先补一次 checkpoint commit + tag**）；数据走 `VACUUM INTO` 快照（命名 `memory.db.pre-<feature>-<yyyyMMdd-HHmmss>`，沿用 `data\backup\` 既有惯例，禁止直接复制 WAL 态 `.db`）。
5. **降级开关三层**：env `MEMORYOS_EXEC_OFF=1`（执行面整体熔断）→ 工具级 `MEMORYOS_EXEC_DISABLE`（按工具摘除）→ dashboard config 表开关（热更）；执行面异常天然被 `server.js:49-63` 的 addTool 兜底隔离，记忆面 18 工具不受影响。

---

## 1. 「新同事 30 分钟上手」执行工具面说明

### 1.1 项目结构图（Electron 壳 / 内核 dist / 数据目录 三层）

```
C:\Users\WYX\Desktop\MemoryOS                     ← 仓库根（git，真源 = dist 内 ESM 文件，无 src/ 编译链）
├─ main.js / app/ / services/ / window/ / security/ / preload.js
│  └─ Electron 壳（CommonJS）：UI 与生命周期
│     └─ services/core-process.js:15-46  spawn 内核并注入 env（MEMORY_DB/MEMORY_PORT/MEMORY_TOKEN）← F9
│        （重启走 taskkill /PID /T /F，意外退出不自动拉起 ← F13）
├─ resources\memoryos\dist\                       ← Node 内核（ESM，MCP 真相源，42 个文件已入 git）
│  ├─ server.js        59KB  MCP stdio 服务端，恰好 18 工具（memory×10 / obsidian×3 / task×5）
│  │                  :49-63 addTool 统一 try/catch 兜底（执行面隔离的天然基座）
│  ├─ agent-core.js   13.6KB runAgent() 工具无关循环（:174-247）＋ writeGate（:215-224）
│  ├─ agent.js        13KB  CLI：REPL / -m 单问 / --work 任务队列 / --loop
│  ├─ dashboard.js    146KB HTTP 看板 127.0.0.1:8787（/api/audit 在 :1085-1090）
│  ├─ db.js           67KB  SQLite（WAL）：daemon_log(:60) / memory_events(:72) / memory_usage
│  ├─ daemon.js / obsidian-sync.js / embed.js(Xenova bge-m3) / search.js / llm.js …
│  └─ smoke-*.js      既有协议级冒烟（smoke-mcp.js：临时 DB + 自清理 + PASS/FAIL 退出码）
├─ .workbuddy\tmp\*.mjs                            ← 团队验证脚本池（smoke/verify/audit 探针，.mjs 直接 node 跑）
├─ .dsh\mcp.json                                    ← DSH 侧 MCP 注册（server.js，toolCallTimeoutMs:15000）
└─ resources\memoryos\data\…（开发期数据）          生产数据在 ↓

C:\Users\WYX\AppData\Roaming\MemoryOS\data\         ← 数据层（WAL 三件套，严禁直接复制 .db ← B2）
├─ memory.db / memory.db-wal / memory.db-shm / token
└─ backup\  memory.db.pre-cardfix-20260914-214820 等 VACUUM INTO 快照（B2 命名惯例 pre-*）
```

执行链路（补全后的目标形态）：

```
LLM（Ollama qwen3:8b @127.0.0.1:11434，B3）
  ⇄ agent-core runAgent()  〔M1〕
  ⇄ StdioClientTransport 拉起 dist/server.js  〔M2 单进程 stdio JSON-RPC〕
  ⇄ tools/call：memory×18（现状） + exec_run / file_*（P0 新增）
       │ 每次调用 → exec_audit 落库（P0）
       └ 高风险调用 → writeGate 审批（P0 修复 F7）
```

### 1.2 本地起 MCP + 单工具冒烟（约 5 分钟）

**方式 A：30 秒手工探活**（PowerShell here-string 直接喂 stdio，EOF 自动退出）：

```powershell
cd C:\Users\WYX\Desktop\MemoryOS
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ps","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
'@ | node resources\memoryos\dist\server.js
```

看到 `tools/list` 返回 18 个工具即服务端存活。注意：这条命令连的是**默认库**（`server.js:17` `MEMORY_DB` 缺省 = 内核旁 `../data/memory.db`），`tools/list` 只读安全；**一旦要 `tools/call` 写工具，必须用方式 B**。

**方式 B：探测脚本（团队惯例，推荐）**——直接跑现成探针：

```powershell
cd C:\Users\WYX\Desktop\MemoryOS
node .workbuddy\tmp\list-tools.mjs        # 打印 18 工具 + 必填参数清单（连的是生产库，只读 tools/list，安全）
```

脚本要点（`list-tools.mjs:5-9`）：`spawn(node, [dist/server.js])` + `env` 注入 `MEMORY_AGENT/MEMORY_DB/MEMORY_PORT/EMBED_MODE`，stdin/stdout 走换行分帧 JSON-RPC。单工具冒烟（真调 `tools/call`）一律按 `dist/smoke-mcp.js` 的做法：**指向临时库** `data\memory-mcp-smoke.db`，结束自清理（`smoke-mcp.js:11-17,174-182`），失败 `exit 1`。

**方式 C：常驻跑法（多轮交互 / 给其他客户端）**：

```powershell
cd C:\Users\WYX\Desktop\MemoryOS\resources\memoryos
$env:MEMORY_AGENT='probe'; $env:EMBED_MODE='local'
node dist\server.js        # 进程常驻，另一个终端按方式 A 喂帧；Ctrl+C 退出
```

### 1.3 用 agent.js -m 端到端验证一个执行工具（约 10 分钟）

P0 之后（`file_read`/`file_write`/`exec_run` 已注册）的端到端验证命令：

```powershell
cd C:\Users\WYX\Desktop\MemoryOS
# 只读工具：应自动放行（无 ✍ 提示），stderr 出现 "⚙ file_read {...}" + "✓ file_read"
node resources\memoryos\dist\agent.js -m "用 file_read 读 C:\Users\WYX\Desktop\MemoryOS\resources\memoryos\package.json，告诉我它有几个 dependencies"

# 写工具：P0 修复后应出现 "✍ 写操作 file_write ... 执行？(y/N)" 门禁（agent.js:64-74 交互门禁）；
#   按 n 拒绝后应看到 "✋ file_write 已拒绝"（agent-core.js:220），且 LLM 不重试（agent-core.js:221 提示语约束）
node resources\memoryos\dist\agent.js -m "用 file_write 在 .workbuddy\tmp 下建一个 p0-exec-check.txt，内容写 OK"
```

验证点清单（5 项全绿才算通过）：

| # | 观察点 | 期望 | 依据 |
|---|--------|------|------|
| 1 | `node resources\memoryos\dist\agent.js --tools` | 输出 21 行（18+3） | `agent.js:110-114` |
| 2 | 只读调用无门禁 | stderr 无 `✍` | `agent-core.js:215` 判 `WRITE_TOOLS.has(name)` |
| 3 | 写调用有门禁 | stderr 出现 `✍` + y/N | `agent.js:61-75` |
| 4 | 拒绝后不重试 | 出现 `✋` 后同工具同参不再真跑 | `agent-core.js:208-212,221` |
| 1 | 审计有痕 | `exec_audit` 表新增行（见 1.4） | P0 交付物 |

**LLM 前置条件**（B3）：本地 Ollama `qwen3:8b` 就绪（`qwen2.5-coder:7b` 不支持结构化 tool_calls，勿用）；切端点用 `--llm-url/--llm-model/--llm-key`（`agent.js:47-50`），端点解析链 `agent-core.js:43-46`（`LLM_BASE_URL → MIMOS_URL → Ollama 默认`）。**注意 F4**：Ollama 默认 `num_ctx=8192`（`agent-core.js:49`），21 工具 schema 后上下文更紧；若出现 LLM 漏调/截断，先 `--llm-num-ctx 16384` 排除上下文因素再谈工具问题。

### 1.4 如何看审计表（约 5 分钟）

三层审计通道（现状 + P0 新增）：

| 表 | 位置 | 看什么 | 查询入口 |
|----|------|--------|----------|
| `daemon_log` | `db.js:60`（现有 19 万行） | 通用审计通道：task/op/memory_id/operator/detail | dashboard `GET http://127.0.0.1:8787/api/audit`（`dashboard.js:1085-1090`，最近 20 条） |
| `memory_events` | `db.js:72` | 记忆级操作 + before 快照（可 undo，`db.js:1261`） | dashboard 仲裁页 |
| `memory_usage` | — | 价值漏斗（search/cited 曝光计数） | `dashboard.js:1093` /api/write-health |
| `exec_audit`（P0 新增） | `db.js` schema 区 | **执行面专用**：tool/agent/args 摘要/审批判定(exit码/duration/approval=pending\|approved\|denied\|auto) | PowerShell 直查（下） |

PowerShell 直查（`node:sqlite` 只读打开，WAL 安全）：

```powershell
cd C:\Users\WYX\Desktop\MemoryOS
node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.APPDATA+"\\MemoryOS\\data\\memory.db",{readOnly:true});for(const r of db.prepare("select id,tool,agent,approval,detail,created_at from exec_audit order by id desc limit 10").all())console.log(r.id,r.tool,r.agent,r.approval,r.created_at,(r.detail||"").slice(0,80));db.close()'
# P0 未交付前，先看现有通道：
node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.APPDATA+"\\MemoryOS\\data\\memory.db",{readOnly:true});for(const r of db.prepare("select id,task,op,operator,detail,created_at from daemon_log order by id desc limit 10").all())console.log(r.id,r.task,r.op,r.operator,r.created_at,(r.detail||"").slice(0,80));db.close()'
```

> 纪律：所有对生产 `memory.db` 的查询脚本一律 `readOnly:true`（WAL 下只读连接不写 shm，`tables-probe.mjs` 已示范）；要写就临时库。

---

## 2. 开发 / 调试工作流

### 2.1 单工具冒烟脚本模板（沿用 .workbuddy 风格，直接改参数用）

落盘为 `.workbuddy\tmp\smoke-exec.mjs`（团队既有风格：spawn + 换行帧 JSON-RPC + `check()` 打 ✅/❌ + `process.exit(fail?1:0)`）：

```js
// .workbuddy/tmp/smoke-exec.mjs — 执行面单工具冒烟（P0 模板，改 TOOL_NAME/断言后直接跑）
// 用法：node .workbuddy/tmp/smoke-exec.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ROOT = 'C:/Users/WYX/Desktop/MemoryOS';
const SERVER = ROOT + '/resources/memoryos/dist/server.js';
// 临时库：绝不碰生产 memory.db（B2）
const TMP_DB = ROOT + '/resources/memoryos/data/memory-exec-smoke.db';
for (const p of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) fs.rmSync(p, { force: true });

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, MEMORY_AGENT: 'smoke-exec', MEMORY_DB: TMP_DB, EMBED_MODE: 'local' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '', idc = 0; const pend = new Map();
child.stdout.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
const rpc = (method, params) => new Promise(r => {
  const id = ++idc; pend.set(id, r);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fail = 0;
const check = (n, c, extra = '') => { if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${!c && extra ? ' → ' + extra : ''}`); };
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = (r.result?.content ?? []).map(c => c.text ?? JSON.stringify(c)).join('\n');
  return { text, isError: r.result?.isError === true };
};

(async () => {
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-exec', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await sleep(300);

  // 1) 工具面：新增 3 个执行工具在册
  const list = await rpc('tools/list', {});
  const names = (list.result?.tools ?? []).map(t => t.name);
  check('exec_run 在册', names.includes('exec_run'), names.join(','));
  check('file_read 在册', names.includes('file_read'));
  check('file_write 在册', names.includes('file_write'));

  // 2) 只读工具：自动放行
  const f = await call('file_read', { path: SERVER });
  check('file_read 返回 server.js 头部', f.text.includes('FastMCP') && !f.isError, f.text.slice(0, 60));

  // 3) 写工具无审批：必须被拒（P0 门禁验证核心断言，B1）
  const w = await call('file_write', { path: ROOT + '/.workbuddy/tmp/exec-smoke-out.txt', content: 'x' });
  check('file_write 无审批 → 拒绝（denied 且未落盘）', w.isError || /拒绝|denied/i.test(w.text), w.text.slice(0, 80));
  check('file_write 拒绝后目标文件不存在', !fs.existsSync(ROOT + '/.workbuddy/tmp/exec-smoke-out.txt'));

  // 4) shell 工具：allow-list 外命令必须被拒
  const s = await call('exec_run', { command: 'format C:' });
  check('exec_run 危险命令 → 拒绝', s.isError || /拒绝|denied|allow-list/i.test(s.text), s.text.slice(0, 80));

  // 5) 审计：exec_audit 有留痕
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(TMP_DB, { readOnly: true });
  const n = db.prepare("select count(*) c from exec_audit").get().c;
  check('exec_audit 有留痕（≥3 行）', n >= 3, 'n=' + n);
  db.close();

  child.kill();
  for (const p of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) fs.rmSync(p, { force: true });
  console.log(fail ? `\n❌ 共 ${fail} 项未通过` : '\n✅ 执行面冒烟全部通过');
  process.exit(fail ? 1 : 0);
})();
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 30000);
```

> 模板约定（与 `smoke-mcp.js` / `list-tools.mjs` 一致）：临时 DB 自清理、30s 总超时兜底、`fail` 计数决定退出码——CI/手动都能当 gate 用。

### 2.2 执行面改动的回归验收命令清单

执行面改动后按序全跑（全绿才允许提交）：

```powershell
cd C:\Users\WYX\Desktop\MemoryOS

# ① 语法自检（改动文件逐个）
node --check resources\memoryos\dist\agent-core.js
node --check resources\memoryos\dist\agent.js
node --check resources\memoryos\dist\server.js
node --check resources\memoryos\dist\exec-tools.js

# ② 既有 18 工具协议回归（临时库，不影响生产数据）
node resources\memoryos\dist\smoke-mcp.js

# ③ 工具清单（18 → 21 数量 + 名称核对）
node .workbuddy\tmp\list-tools.mjs

# ④ 执行面专项冒烟（P0 起）
node .workbuddy\tmp\smoke-exec.mjs

# ⑤ 端到端：agent -m 只读 + 门禁（见 1.3 两条命令；交互门禁按 n 走拒绝分支）
node resources\memoryos\dist\agent.js --tools
node resources\memoryos\dist\agent.js -m "用 file_read 读 resources\memoryos\package.json，报 dependencies 数量"

# ⑥ 无头门禁回归（F7 修复验证）：--work 默认必须不再全放行
node resources\memoryos\dist\agent.js --work

# ⑦ 看板 / 壳侧回归（静态 + 页面冒烟，沿用团队既有 verify 脚本风格）
node .workbuddy\tmp\verify.mjs

# ⑧ 审计面抽查（1.4 的只读查询命令）
node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.APPDATA+"\\MemoryOS\\data\\memory.db",{readOnly:true});console.log("exec_audit 行数",db.prepare("select count(*) c from exec_audit").get().c);db.close()'
```

调试回路：`smoke-exec.mjs` 失败 → 读 `exec_audit` 的 `detail`（拒绝原因）→ 需要真实 stderr 时把冒烟脚本 `stdio` 第三路接 `child.stderr.on('data', d => console.error('[kernel]', d))`（现模板默认吞 stderr，与 `list-tools.mjs:8` 同风格，排障时临时打开）。

### 2.3 备份 SOP（B2 合规，改代码/改数据前各一步）

**SOP-A 代码变更前**（git 双保险）：

```powershell
cd C:\Users\WYX\Desktop\MemoryOS
git status --porcelain            # 看清未提交面（当前 22 个改动，先 checkpoint 再开工）
git add -A
git commit -m "checkpoint: pre-P0-exec baseline (工程效率)"
git tag pre-P0-exec-<yyyyMMdd>
```

**SOP-B 数据变更前**（VACUUM INTO，命名沿用 `data\backup\memory.db.pre-*` 既有惯例）：

```powershell
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$dst = "$env:APPDATA\MemoryOS\data\backup\memory.db.pre-exec-$ts"
node -e 'const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.APPDATA+"\\MemoryOS\\data\\memory.db");db.exec("VACUUM INTO "+process.argv[1]);db.close();console.log("snapshot ->",process.argv[1])' "$dst"
```

**SOP-C 回滚**：代码 `git checkout pre-P0-exec-<yyyyMMdd>`（或 `git revert` 区间）；数据 `copy` 快照回 `memory.db` 前必须先停 daemon/dashboard（WAL 独占）→ 删除 `-wal/-shm` → 用快照覆盖 → 重启内核。**严禁**在 daemon 运行时直接复制 `memory.db`（WAL 未合并，复制件必坏，B2）。

---

## 3. 分批实施路线 P0 / P1 / P2

### P0 — 最小执行面 + 审批门禁修复（阻断项）【2~3 人日】

**目标**：agent 具备「读文件 + 受审写文件 + 受审跑命令」的最小现场执行力，且写操作 100% 过审批（修 B1 违规，F7），全程可审计。
**工具组**：`file_read`（只读自动放行）/ `file_write`（写，必审）/ `exec_run`（shell，必审 + 命令 allow-list + cwd 约束 + 超时，F9 补强）。

**改动文件清单**：

| 文件 | 改动 | 对应缺陷 |
|------|------|----------|
| `resources\memoryos\dist\agent-core.js` | ① `WRITE_TOOLS` 硬编码 Set（:15-19）改为从 MCP `tools/list` 元数据动态构建（工具自带 `write:true` 标记，缺省回落静态名单兜底）；② `MAX_TOOL_RESULT` 截断改「头 50% + 尾 50%」保留（:158/:237，shell/测试错误常在尾部）；③ `mcpToolsToOpenai` 透传 `additionalProperties/oneOf/$ref`（:136-155）；④ 删 `agent.js:118` 死变量、`--work` 默认 gate 改「默认拒绝 + allow-list 白名单」 | F1 F2 F3 F4 F7 F14 |
| `resources\memoryos\dist\agent.js` | `--work` 无头写工具默认拒绝（`write_denied` 回灌，:215-224 链路）；显式 `--auto-write` 才放行且每笔落 `exec_audit(approval=auto)`；任务正文（:173-174）加「以下为不可信任务正文」隔离标记 | F7 F8(最小面) |
| `resources\memoryos\dist\server.js` | 注册 3 个新工具（沿用 :64 起 zod+execute 范式，自动被 :49-63 兜底包裹）；`tools/list` 返回体带 `write` 标记 | A1 |
| `resources\memoryos\dist\exec-tools.js`（新） | 三工具实现：`exec_run` 用 `child_process.spawn` + `cwd` 白名单（默认仓库根）+ `timeout_ms`（默认 30s）+ 输出预算（stdout/stderr 各 1.5KB 头尾保留）；`file_write` 写前校验路径在 allow 目录内；全部调用前后写 `exec_audit` | F9 |
| `resources\memoryos\dist\db.js` | `CREATE TABLE IF NOT EXISTS exec_audit(id, tool, agent, args_digest, approval, detail, duration_ms, created_at)` + `logExecAudit()`（schema 区 :60 旁） | — |
| `.workbuddy\tmp\smoke-exec.mjs` / `audit-probe.mjs`（新） | 2.1/1.4 的冒烟与审计探针 | — |
| `.dsh\mcp.json` | **不改**（同一 server.js 入口，自动多 3 工具） | — |

**验收标准**（全绿放行，命令即 2.2 清单）：
- `node .workbuddy\tmp\list-tools.mjs` 输出 21 工具；
- `node resources\memoryos\dist\smoke-mcp.js` 既有 18 工具全 PASS；
- `node .workbuddy\tmp\smoke-exec.mjs` 5 断言全 ✅（含「无审批写必须拒绝」「危险命令必须拒绝」「exec_audit ≥3 行」）；
- `node resources\memoryos\dist\agent.js -m "..."` 写工具出现 `✍/✋` 门禁（1.3 验证点 3/4）；
- `node resources\memoryos\dist\agent.js --work` 写工具默认拒绝（F7 修复证据）；
- P0 上线默认 `MEMORYOS_EXEC_OFF` 开关处于**关闭执行面**状态（5.2），人工 opt-in。

**预计工作量**：2~3 人日（门禁+审计 1 天，3 工具+allow-list 0.5~1 天，冒烟/文档 0.5 天）。

### P1 — 工具组扩展【3~5 人日】

**目标**：覆盖测试/git/网络/DB 四个执行域，执行面从「能跑命令」升级为「能干活不翻车」。
**工具组**：

| 工具 | 入参（摘要） | 审批 | 说明 |
|------|-------------|------|------|
| `test_run` | `{cmd, cwd?, timeout_ms?}` | 自动（只读语义） | 输出走 F3 头尾保留；失败返回尾 80 行（错误在尾部） |
| `git_status` / `git_diff` | `{cwd?}` | 自动 | 只读 |
| `git_commit` / `git_tag` | `{cwd?, message?, tag?}` | 必审 | 提交前自动触发 SOP-B（VACUUM 快照挂到 tag 名） |
| `git_rollback` | `{tag}` | 必审（双人确认） | 代码回滚唯一入口 |
| `http_get` | `{url, timeout_ms?}` | 白名单（`MEMORYOS_HTTP_ALLOW`，默认空=全拒） | 网络面默认关闭，防 SSRF/数据外泄 |
| `db_query` | `{sql, db?}` | 自动（仅 `SELECT`，SQL 前缀校验） | 对目标库只读 |
| `db_backup` | `{feature}` | 必审 | `VACUUM INTO` 快照（B2 唯一合规备份） |
| `file_patch` / `file_glob` / `file_grep` | 按工具名 | 写审/自动/自动 | 文件域扩展 |

**改动文件**：`exec-tools.js` 扩展（每域一个区块）；新增 `dist\exec-config.js`（allow-list/白名单/config 表读取）；`db.js` 增加 `exec_config` 配置表读写；`dashboard.js` 增加「执行审计」页签（`/api/exec-audit`，复用 :1085 `/api/audit` 范式）+ 审批队列 UI（`exec_audit.status=pending` 人工批 → 写回 approved/denied 留痕）；`docs\agent-completion\capability-matrix.md` 补全第 4 节矩阵全部行。
**验收**：2.2 清单 + 每工具一条冒烟断言（模板复制改参）+ `http_get` 白名单外 URL 必拒 + `db_query` `DELETE` 必拒。
**工作量**：3~5 人日。

### P2 — 浏览器 / 编排 / 评估闭环【5~10 人日】

**目标**：补浏览器现场力 + 双路径编排协同（#4073/#4129）+ 执行结果回流价值度量。
- **浏览器面**：`browser_open/browser_click/browser_snapshot/browser_screenshot`（CDP 对接 dashboard 8787 或独立 headless；高风险域，全部必审 + 输出预算 2KB/图 1 张）。实现落 `dist\browser-tools.js`，依赖选型（Playwright vs 裸 CDP）在 P2 启动时单独立项评审。
- **编排面**：`agent.js --loop` 与 MCP 任务队列双路径协同（#4073/#4129 即此项）；`toolsFilter`（`agent-core.js:170,179`）升级为「阶段化工具面」——探索期全量、执行期收窄到执行域、收尾期只给 `task_done`+`memory_write`（治 F4 上下文挤压）。
- **评估闭环**：执行结果 → `task_done` 结论 → `memory_write`（复用 :77 起的写前检索门禁）→ `baseline.js`/`golden-regress.js` 定期回归（执行工具调用成功率、误调率、审批通过率三指标进 `memory_health`）。
**验收**：浏览器工具冒烟（对 127.0.0.1:8787 自点）；双路径一条任务在 DSH subagent 与 `--work` 队列各跑一遍互不串台；回归三指标连续 7 天可查。
**工作量**：5~10 人日（浏览器面 2~4 天、编排 1~2 天、评估闭环 2 天）。

---

## 4. 可直接粘贴的最终交付模板：完整 agent 能力矩阵

> 交付物 = `docs\agent-completion\capability-matrix.md`。P0 批次先贴本表头 + 3 行示例；**其余行（测试/git/网络/DB/浏览器/编排各域）由 P1/P2 批次文档填充**，逐行状态推进。

```markdown
| 层级 | 工具域 | 工具名 | 入参 | 返回契约 | 风险级 | 审批策略 | 超时 | 输出预算 | 记忆钩子 | 状态 |
|------|--------|--------|------|----------|--------|----------|------|----------|----------|------|
| shell | 命令执行 | exec_run | {command, cwd?, timeout_ms?} | {exit_code, stdout_head, stdout_tail, stderr_tail, duration_ms, audit_id} | 高 | 无头默认拒绝 + allow-list 白名单；交互 y/N（B1） | 30s（默认，可传） | stdout/stderr 各 1.5KB 头尾保留 | 结果进 task_done 结论 → memory_write | P0 |
| 文件 | 只读 | file_read | {path, offset?, limit?} | {text, size_bytes, lines, truncated} | 低（限 allow 目录） | 自动放行 | 10s | 3000 字符 | 命中既有记忆路径时 memory_cite | P0 |
| 文件 | 写 | file_write | {path, content, backup?} | {written_bytes, pre_snapshot?, audit_id} 或 {denied, reason} | 高 | 必审（B1）；DB 类目标先 VACUUM 快照（B2） | 30s | 500 字符回执 | 写后 memory_write 沉淀结论 | P0 |

<!-- 其余行：test_run / git_* / http_get / db_query / db_backup / file_patch / browser_* / 编排与评估钩子 —— 由 P1、P2 批次文档填充，状态列取值：现状 | P0 | P1 | P2 | 不做 -->
```

状态列约定：`现状`（18 个记忆/任务/obsidian 工具，已在册）→ 由矩阵首版一次性回填；`P0/P1/P2` 随批次打勾；`不做` 须写明理由（例：远程部署类工具，本地隐私优先 B3 生态，不做）。

---

## 5. 风险与止损

### 5.1 每批回滚方式（B2 双轨）

| 批次 | 代码回滚 | 数据回滚 | 前置动作 |
|------|----------|----------|----------|
| P0 | `git tag pre-P0-exec-*`（开工前 SOP-A 建）；出问题 `git checkout` 该 tag | `data\backup\memory.db.pre-exec-*` VACUUM 快照（SOP-B）；停 daemon 后覆盖 + 清 `-wal/-shm` | 开工先 `git status` 清干净 22 个未提交改动并 checkpoint（现 tag `baseline-20260914-pre-fullopt` 已过期，不能作为回滚点） |
| P1 | 每工具组一个 tag（`pre-P1-<domain>`） | 每批一次 VACUUM 快照（`pre-P1-*`） | 同 SOP-A/B；`exec_config` 表改动与工具代码同 tag 回滚 |
| P2 | tag `pre-P2-*` | 快照 `pre-P2-*` | 浏览器依赖（若引入 Playwright）单独锁版本；回滚代码即摘除依赖 |

**不可回滚面提示**：`exec_audit` 历史行与已写的 `memory_events` 属审计证据，回滚代码/数据时**保留**（append-only，删行=毁审计，禁止）。

### 5.2 执行面降级开关（feature flag 设计，三层）

| 层 | 开关 | 语义 | 生效路径 |
|----|------|------|----------|
| 1 熔断 | `MEMORYOS_EXEC_OFF=1`（env，启动时） | 执行面工具从 `tools/list` 整体摘除，LLM 只看得见 18 记忆工具 | `server.js` 启动读取 → 注册循环跳过 exec 域（:64 起注册点加 `if (execEnabled())`） |
| 2 工具级 | `MEMORYOS_EXEC_DISABLE=exec_run,http_get`（env） | 按工具摘除 | 同上，注册循环按名跳过 |
| 3 热更 | `memory.db` `config` 表键 `exec.flags` + dashboard 开关页 | 免重启改单个工具状态；每次变更写 `daemon_log`（operator=`human:dashboard`，复用 :1078 通道） | `server.js` 每轮 `tools/list` 读表（表小，无性能问题） |

**默认姿态（P0 上线日）**：`exec.flags` 默认全关（执行面整体 off），每工具独立 opt-in——符合「最小改动 + 写操作先获同意」（B1）：先让记忆面回归验证 2.2 清单全绿，再逐工具开闸。
**失败降级路径**：执行工具异常 → `server.js:49-63` addTool 兜底已保证单工具炸不连累进程（返回结构化 ⚠ 文本，:58-59）→ 上下文被 F4 挤爆时临时 `toolsFilter` 收窄到只读集（`agent-core.js:170,179` 现成钩子）→ 仍不稳则拉 1 层熔断（`MEMORYOS_EXEC_OFF=1` 重启内核，`taskkill /IM node.exe` 精准杀内核进程名+PID，勿误杀 Electron 壳，F13 现状是手动 taskkill，P1 可顺手加自动重启）。
**审计不可降级**：任何开关状态下，执行工具的每次调用/拒绝都必须落 `exec_audit`（含 `approval=denied_by_flag`）——关的是能力，不是留痕。

---

## 附：事实与行号速查

- F1 `agent-core.js:15-19`（WRITE_TOOLS 硬编码 11 名）｜F2 :136-155（schema 降级透传）｜F3 :158/:237（3000 字符头保留截断）｜F4 :49（num_ctx=8192）+ :170/:179（toolsFilter 钩子）｜F5 :159/:180/:205-211（MAX_SAME_CALL=2 跨轮持久）｜F6 :200-203（坏 JSON 静默空参）｜F7 :215-224 + `agent.js:118-121`（--work gate=null 全放行）｜F8 `agent.js:173-174` + `agent-core.js:236-238`（任务正文/工具结果注入面）｜F9 `services/core-process.js:15-46`（shell spawn 无沙箱/无超时）｜F13 `core-process.js:34-43`（退出不自动重启）｜F14 `agent.js:118`（死变量 writeGate）＋:209（正常 setTimeout 用法，非缺陷）｜F15 `agent-core.js:230`（onStep 摘要 500 字符）
- B1 写先获同意｜B2 WAL 禁直拷、VACUUM INTO 快照 `pre-*`、保留 7 份｜B3 本地 Ollama qwen3:8b
- 审计表：`daemon_log`（`db.js:60`，`/api/audit` 在 `dashboard.js:1085-1090`）、`memory_events`（:72）、`memory_usage`、`exec_audit`（P0 新增）
- 冒烟范式：`dist/smoke-mcp.js`（临时库+自清理+退出码）、`.workbuddy/tmp/list-tools.mjs`（stdio 帧探测）、`.workbuddy/tmp/verify.mjs`（语法+正则自检）
- git 现状：仓库有 tag `baseline-20260914-pre-fullopt`，工作树 22 个未提交改动，`resources/memoryos/dist` 42 文件已入 git（改动走 git 即合规回滚轨）
