# MemoryOS 数据库可靠性专家意见 · 工具调用审计 / 审批记录 / 执行产物落库

> 专家角色：数据库可靠性工程师（SQLite / WAL / VACUUM INTO 备份纪律）
> 事实依据：`docs/agent-completion/FACTS-PACK.md`（B1-B3、F9 等编号）、`resources/memoryos/dist/db.js`（行号已核实，2026-09-15 基线）。
> 纪律约束（全文遵守）：WAL 模式严禁直接复制 .db（B2）；备份只走 VACUUM INTO 自包含快照 + 7 份轮转（B2，db.js:694-735、daemon.js:572）；代码回滚走 git、数据回滚走快照（FACTS-PACK §备份纪律）；写操作先获同意（B1，对应 F7 待修）。

---

## 0. 结论先行（TL;DR）

1. **新增 3 张表：`tool_call_audit`（append-only 事件流）、`approvals`（append-only 审批事件）、`artifacts`（可重建索引表）**。全部为「附加式 DDL」（`CREATE TABLE IF NOT EXISTS`，与 db.js:358 现库模式一致），旧代码零感知、可回退。
2. **不可变性 = 三层叠加**：
   - L1 触发器 `BEFORE UPDATE/DELETE … RAISE(ABORT)`：挡住一切经 SQL 通路的改删（含外部 sqlite3 CLI、"DB 管理员"误操作）；
   - L2 应用层哈希链（`row_hash = sha256(规范化行字段 ‖ prev_hash)`，JS 端计算——node:sqlite 禁 load_extension，无 SQL 内建 sha256，db.js:5）：检测 `DROP TABLE` 重建、整库替换、页级篡改；
   - L3 链头外置锚（`data/audit-chain.log` 追加式锚点 + git tag 签名）：检测"用旧快照整库回灌"型篡改。
   - **边界（诚实声明）**：三层全部防不住「拿到 .db 文件 + 锚点 + 7 份快照的人」——那是 OS 级信任边界，与 B3 本地部署的威胁模型一致，非数据库层可解。
3. **崩溃一致性**：审计「start」事件在工具执行**前**单独提交（durable 意图锚点）；进程 kill -9 / 断电后留下「有 start 无 ok/fail」的悬空行 = "可能已执行"（因 `synchronous=NORMAL`，db.js:354，崩溃可丢最后一个未 checkpoint 事务）。恢复流程 = 悬空扫描 + `agent.js --resume`（agent.js:139-141）注入"最后工具调用结果未知、先验证副作用再重试"的上下文。
4. **产物文件与 DB 索引的两段式**：**先落文件（tmp+fsync+rename 原子写）→ 后写 DB 索引行（小事务）**；方向不可反（反向崩溃 = 悬空索引行，文件端扫描不可发现）。文件为内容真源，DB 行可由文件系统扫描幂等重建。
5. **备份零改动**：新表在同一 .db 文件内 → daemon 每日 VACUUM INTO（db.js:707）与 7 份轮转（db.js:713 正则、daemon.js:572 `keep:7`）**自动覆盖新表**；增长靠既有归档模式（db.js:287-310「只归档不删除」）加 `*_archive` 表控制快照体积。
6. **迁移可回滚**：单 `withTx`（db.js:840-866）DDL 脚本 + config 迁移标记（db.js:546-548 模式）；数据回滚 = pre-* 快照恢复（非拷贝活库），代码回滚 = git revert；DDL 撤销脚本提供但仅为"主动下线能力"路径，不是数据回滚路径。

---

## 1. 现状基线（写方案前必须钉住的事实）

| 事实 | 位置 | 对方案的影响 |
|---|---|---|
| `journal_mode=WAL`、`busy_timeout=5000` | db.js:346-347 | 所有连接 5s 等锁；写事务需保持短小 |
| `synchronous=NORMAL`（注释自证：崩溃最多丢最后一个未 checkpoint 事务） | db.js:354（注释 349-351） | 审计行"提交即 durable"不成立到 checkpoint；决定 §2 的 FULL 审计连接 |
| `cache_size/mmap_size/temp_store` 性能调优 | db.js:355-357 | 审计连接不要重复套性能调优，只做 durable 最小集 |
| 全部建表 `CREATE TABLE IF NOT EXISTS` 在 `openDb` 一次性执行 | db.js:15-311、358 | 新表走同一路径，幂等、附加式 |
| 迁移模式：单事务 + `config` 表标记防重复（`migration.vectors_split_v1`） | db.js:546-567、609-646 | DDL 迁移脚本照此写 |
| `withTx`：`BEGIN IMMEDIATE` + 锁竞争 3 次重试 | db.js:840-866 | 所有审计写入路径的唯一事务入口 |
| 归档表先例：`card_events_archive`/`memory_usage_archive`，注释"只归档不删除，对齐 v1.1 纪律" | db.js:286-310 | 审计表增长控制照抄该模式 |
| 内容哈希先例：`notes.hash` 列 | db.js:176 | `artifacts.sha256` 列设计一致 |
| BLOB 拆表先例（"行宽膨胀 + VACUUM/备份效率下降"） | db.js:132-141 | 产物正文**不入 DB**，走外部文件 |
| 现有"审计样"表 `daemon_log`：无触发器、无哈希链，可 UPDATE/DELETE | db.js:60-69 | 新审计表比它更强，但**不给** daemon_log 回溯补触发器（改动面扩大，违反 B3 只改呈现不改功能——列为可选后续） |
| 备份 = `backupDb()`：每日 VACUUM INTO `backup/memory-YYYY-MM-DD.db`，keep=7，轮转正则 `^memory-\d{4}-\d{2}-\d{2}\.db$` | db.js:694-735、daemon.js:568-577 | 新表自动入快照范围，零改动 |
| WAL 检查点：daemon 每小时 `checkpointWal(TRUNCATE)` | db.js:493-508、daemon.js:578-582 | NORMAL 下"丢失窗口"上界 ≈ 1 小时 |
| `--resume`：从 task_next 文本找"我认领的 in_progress 任务"续做；SIGINT 只打印后 130 退出 | agent.js:139-141、151-153、108 | 崩溃恢复的接点；clean-exit 与 kill -9 的区别只能靠 DB 悬空行判别 |
| 任务状态机：`in_progress → blocked/review/done/failed/cancelled`；`task_done` 仅 `in_progress/review → done`，并 `appendEvent` 到 `memory_events` | server.js:687-695、870-895 | 对账不自动改任务状态；只产出"待人工/agent 复核"上下文 |
| 卡片有租约：`claim_lock/lease_expires_at/heartbeat_at` | db.js:224-226 | 崩溃 agent 的 in_progress 任务到期后可被托管接管（server.js:800-826），接管方可见悬空审计行 |
| F9：执行工具将跑在 `core-process.js` spawn 的子进程（无沙箱、无单调用超时） | FACTS-PACK F9（services/core-process.js:15-46） | 审计行记 `exec_ctx`（进程链），崩溃归属可判 |

---

## 2. ① 新增表与写入语义

### 2.1 DDL（三张表 + 触发器 + 归档表）

```sql
-- ============================================================
-- A. 工具调用审计（append-only 事件流：一行 = 一个不可变事件）
--    设计选择：不是"一行记录 + 状态列 UPDATE"，而是事件流。
--    理由：状态列需要 UPDATE，与 append-only 直接冲突；
--    事件流下"未结项"是推导值（存在 start 无终态事件），不是存储值。
-- ============================================================
CREATE TABLE IF NOT EXISTS tool_call_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  call_key       TEXT    NOT NULL,             -- 会话内唯一：'<session_id>#<n>'，start/终态事件配对键
  task_id        INTEGER,                      -- 对应 memories 任务 id（task_done 溯源，server.js:870-895）
  card_id        INTEGER,
  session_id     TEXT,
  agent          TEXT    NOT NULL,             -- MEMORY_AGENT 身份
  exec_ctx       TEXT,                         -- 进程链/pid（F9 spawn 环境），崩溃归属判据
  tool           TEXT    NOT NULL,
  phase          TEXT    NOT NULL,             -- start / ok / fail / denied
  args_hash      TEXT,                         -- 全量 args JSON 的 sha256（可复核）
  args_excerpt   TEXT,                         -- 截断预览（≤512B，不进敏感全量）
  result_excerpt TEXT,                         -- 终态事件：结果预览（对齐 F3 截断教训，尾部摘要另存）
  error          TEXT,                         -- 终态事件：错误文本（≤2KB）
  duration_ms    INTEGER,
  prev_hash      TEXT    NOT NULL,             -- 前一行 row_hash；genesis = 64 个 '0'
  row_hash       TEXT    NOT NULL,             -- sha256(规范化字段‖prev_hash)，应用层算（§2.3）
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tca_callkey ON tool_call_audit(call_key);
CREATE INDEX IF NOT EXISTS idx_tca_task    ON tool_call_audit(task_id);
CREATE INDEX IF NOT EXISTS idx_tca_phase   ON tool_call_audit(phase, created_at);

-- B. 审批事件（B1 的持久化承载：同意/拒绝本身就是事实，必须落库才可审计）
--    同样事件流化：pending 是"存在 requested 无决定事件"的推导值，无可变状态列。
CREATE TABLE IF NOT EXISTS approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_key TEXT   NOT NULL,               -- 会话内唯一：'<session_id>#<n>-appr'
  task_id     INTEGER,
  session_id  TEXT,
  agent       TEXT    NOT NULL,
  tool        TEXT    NOT NULL,
  risk_level  TEXT    NOT NULL DEFAULT 'L1',  -- L0 只读=预授权；L1+ 须同意（B1；对应 F7 修复目标）
  event       TEXT    NOT NULL,               -- requested / granted / denied / expired / auto
  decided_by  TEXT,                           -- user:dashboard | user:cli | agent:policy
  policy_ref  TEXT,                           -- auto 时命中的预授权规则（allowlist 条目 id）
  detail      TEXT,
  prev_hash   TEXT    NOT NULL,
  row_hash    TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_appr_key   ON approvals(approval_key);
CREATE INDEX IF NOT EXISTS idx_appr_task  ON approvals(task_id);

-- C. 执行产物索引（可变索引表——它不是事实流，是文件系统内容真源的目录）
--    产物正文存 data/artifacts/<task_id>/<id>-<name>.<ext>，行只存索引+完整性锚（§4.3）
CREATE TABLE IF NOT EXISTS artifacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER,
  card_id    INTEGER,
  session_id TEXT,
  agent      TEXT    NOT NULL,
  kind       TEXT    NOT NULL,               -- test_log / build_report / patch / screenshot / data_export
  rel_path   TEXT    NOT NULL,               -- 相对 data/artifacts/
  size_bytes INTEGER NOT NULL,
  sha256     TEXT    NOT NULL,               -- 文件内容哈希（notes.hash 先例，db.js:176）
  mime       TEXT,
  source_tool TEXT,                          -- 产出工具名
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

-- D. 归档表（增长控制，db.js:287-310 先例：只归档不删除，同文件内 → 仍在 VACUUM INTO 范围）
CREATE TABLE IF NOT EXISTS tool_call_audit_archive (
  id INTEGER PRIMARY KEY, call_key TEXT NOT NULL, task_id INTEGER, card_id INTEGER,
  session_id TEXT, agent TEXT NOT NULL, exec_ctx TEXT, tool TEXT NOT NULL, phase TEXT NOT NULL,
  args_hash TEXT, args_excerpt TEXT, result_excerpt TEXT, error TEXT, duration_ms INTEGER,
  prev_hash TEXT NOT NULL, row_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals_archive (
  id INTEGER PRIMARY KEY, approval_key TEXT NOT NULL, task_id INTEGER, session_id TEXT,
  agent TEXT NOT NULL, tool TEXT NOT NULL, risk_level TEXT NOT NULL, event TEXT NOT NULL,
  decided_by TEXT, policy_ref TEXT, detail TEXT,
  prev_hash TEXT NOT NULL, row_hash TEXT NOT NULL, created_at TEXT NOT NULL
);

-- E. 不可变性触发器（L1 防线：对一切连接生效，含外部 sqlite3 CLI）
CREATE TRIGGER IF NOT EXISTS trg_tca_no_upd BEFORE UPDATE ON tool_call_audit
BEGIN SELECT RAISE(ABORT, 'tool_call_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_tca_no_del BEFORE DELETE ON tool_call_audit
BEGIN SELECT RAISE(ABORT, 'tool_call_audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_appr_no_upd BEFORE UPDATE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_appr_no_del BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approvals is append-only'); END;
-- 归档表不加触发器（归档=合法写路径）；artifacts 不加（可重建索引，损坏时重扫即可）
```

> 执行方式：全部并入 db.js 的 `SCHEMA` 字符串（db.js:15-311 模式，`openDb` 幂等执行），老库 `IF NOT EXISTS` 自动补齐——**这是"附加式 DDL"的最小落法**。若想把 DDL 与代码解耦评审，也可走 §6 的独立迁移脚本（`withTx` 单事务 + config 标记），二者选一，**不要两条路径并存**。

### 2.2 写入语义：一次工具调用的完整落库顺序

```
（全部经 withTx(db, fn)，db.js:840-866；每个方括号 = 一次独立小事务，绝不合并成长事务）

[事务1 · 审批事件]（仅 L1+ 且非预授权时）
  INSERT approvals(event='requested', …)        ← 提交。同意本身落库，B1 可审计

[等待决定]  granted → INSERT approvals(event='granted/denied/auto')
            denied  → INSERT tool_call_audit(phase='denied', …) 后流程终止
            超时    → INSERT approvals(event='expired', …)

[事务2 · 执行前锚点] ★ 关键：先于工具执行
  INSERT tool_call_audit(phase='start', call_key, args_hash, …)  ← 提交
  （此后进程随时死，DB 里必留有"调用发生过"的证据）

[执行工具]（F9 子进程环境；失败/超时都算终态）

[事务3 · 产物两段式]（见 §4.3，先文件后 DB）
  fs: data/artifacts/<task>/<id>-<name> 原子写（tmp→fsync→rename）

[事务4 · 终态]
  INSERT artifacts(…, sha256=文件实测哈希)
  INSERT tool_call_audit(phase='ok'|'fail', call_key 同事务2, …)  ← 提交
```

关键语义约定：
- **`start` 事件先于执行提交**，这是崩溃对账（§3.2）的唯一依据。执行中死亡 = 只有 start 行。
- **`call_key` 是 start/终态的配对键**：终态事件携带同一 `call_key`，悬空判定 = `存在 start 且不存在同 call_key 的 ok/fail/denied`。用自增 id 配对不可靠（中间可能插入其他会话行）。
- **同一 `withTx` 内多表同提交**：审批+start、artifacts+终态各自原子，不跨方括号。
- **args_hash 存全量哈希、args_excerpt 存截断**：敏感参数不留全量明文（对齐 F15 泄漏教训方向），复核时重算哈希判"是否同一参数"。
- **artifacts 行可重建**（§4.3），因此它不进哈希链——链只保护事实流（tool_call_audit / approvals），目录表损坏无一致性风险。

### 2.3 行校验和 / 哈希链方案（L2 防线，应用层）

node:sqlite 禁 `load_extension`（db.js:5），SQL 内无 `sha256()`，链必须 JS 端算：

```js
import { createHash } from "node:crypto";
const GENESIS = "0".repeat(64);

// 规范化串：字段按列序以 \u0000 连接（含 prev_hash、created_at，全部参与哈希）
function rowHash(cols, prevHash) {
  return createHash("sha256").update([prevHash, ...cols].join("\u0000"), "utf8").digest("hex");
}

// 写入（在 withTx 的同一事务内，保证 prev/curr 原子）：
//   prev = db.prepare(`SELECT row_hash FROM tool_call_audit ORDER BY id DESC LIMIT 1`).get();
//   prevHash = prev ? prev.row_hash : GENESIS;
//   INSERT … VALUES (…, prevHash, rowHash(cols, prevHash));

// 校验（daemon 周期任务；游标存 config，db.js:313-325 readConfig 模式）：
//   SELECT * FROM tool_call_audit WHERE id > :cursor ORDER BY id;
//   逐行：① id 必须连续（断号 = 删行/重建表）；
//         ② 重算 row_hash 比对；③ 记录 lastHead = {id, row_hash, count} → 写锚点（§5.2）
//   游标推进写入 config key 'audit.verify_cursor'（JSON {id}），断点续验。
```

- 校验频率：随 daemon 每小时轮（daemon.js:599 `setInterval 60*60*1000`）跑一次增量校验，成本 = 只扫新行。
- **校验"通过"≠ 全库可信**：它只能证明"自游标以来无篡改"；整库被替换需靠锚点对比（§5.2）。

---

## 3. ② WAL 崩溃一致性

### 3.1 长事务 × busy_timeout 交互（先给规则）

**规则：审计/产物路径上不允许出现长写事务；产物正文永不入 DB（BLOB 入 DB 即被否决）。**

- 若 artifact 以 BLOB 存库：10MB 级写入 = 一个写事务持写锁数秒 → 其他写连接 `busy_timeout=5000`（db.js:347）满 5s 后拿锁 → `SQLITE_BUSY` → `withTx` 重试 3 次（db.js:859-862）全部撞上同一把长锁 → 第 4 次抛错，MCP 调用方看到 "database is locked"。多会话并发时形成锁风暴。
- 本方案的产物 = 外部文件 + 索引行（§4.3）：所有 DB 事务都是"插入 1-3 行"级别（毫秒级），`busy_timeout=5000` 绰绰有余，`withTx` 3 次重试的语义（"让出后重试，竞争窗口很小"，db.js:860 注释）成立。
- 该决策与项目既有先例同向：BLOB 拆独立表就是为了"VACUUM 与备份效率下降"（db.js:132-136）——产物比 embedding BLOB 大 3-4 个量级，更不能进主库。
- **归档动作（§4.1）是唯一可能变长的写**：`INSERT INTO …_archive SELECT … WHERE id < :watermark` 一次搬 10 万行也是单事务——可接受（daemon 独占时段跑，且 VACUUM INTO 每日才一次，锁竞争可容忍 30s 级），但要求：① 只在 daemon 治理轮执行；② 搬完同一轮内做 `checkpointWal`（daemon.js:581）截断 WAL；③ 若超 60s 仍未提交，宁可回滚下次分批（水位推进在 config 里，幂等）。

### 3.2 崩溃后"审计表有记录、任务未结项"的对账与恢复

**前提事实**：`synchronous=NORMAL` 下崩溃可丢"最后一个未 checkpoint 事务"（db.js:350 注释自证）；daemon 每小时 TRUNCATE checkpoint（daemon.js:581）→ 丢失窗口上界 ≈ 1h。

**可选加固（推荐采用，成本极低）**：审计写入走**专用连接**，与内核主连接（性能调优，db.js:355-357）分离：

```js
import { DatabaseSync } from "node:sqlite";
export function openAuditConn(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");   // 与主文件模式一致（WAL 是文件属性）
  db.exec("PRAGMA synchronous = FULL");   // 每个审计提交 fsync —— start 事件不丢
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
```

- 只影响 `tool_call_audit`/`approvals` 写入路径；事件频率 = 工具调用次数（每分钟个位数），每事件 1 次 fsync 可忽略。
- 语义变化：有了 FULL 审计连接后，"start 已提交"在 kill -9 后**必然可读**，对账从"可能执行过"升级为确定的"start 时点之前的一切已落库"。
- 不加固的替代方案（可接受但要写进运维手册）：承认 start 行可能随未 checkpoint 事务丢失，对账把"无 start 行"也按"未知"处理——审计完整性降一级。**建议加固，这是 P0 级别的正确性投资。**

**对账查询（悬空 start）**：

```sql
-- 悬空 = 有 start、无同 call_key 终态、且早于 now-5min（留出正常执行时长裕量）
SELECT a.*
FROM tool_call_audit a
WHERE a.phase = 'start'
  AND a.created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes')
  AND NOT EXISTS (
    SELECT 1 FROM tool_call_audit b
    WHERE b.call_key = a.call_key AND b.phase IN ('ok','fail','denied'));
```

**恢复流程（衔接 agent.js --resume）**：

```
1. 崩溃后第一次启动（agent / daemon 任一，建议封装为 dist/audit-reconcile.js 幂等脚本）：
   a. openDb 自动 WAL 恢复（SQLite 打开时自动重放 -wal；无需手工干预）
   b. PRAGMA integrity_check → 必须 ok（§7 清单）
   c. 跑悬空扫描 → 得到悬空 start 行集合 D
   d. 对每个悬空行：不改任务状态（状态机 in_progress 的合法去向是人工/agent 决定，
      server.js:691），只产出"复核上下文"
2. node dist/agent.js --work --resume（agent.js:7, 139-141, 151-153）：
   - --resume 找到"我认领的 in_progress 任务"后，在构造 user 消息（agent.js:174）时
     追加确定性段落：
     "⚠ 崩溃对账：本任务最后一次工具调用 <tool> <args_excerpt> 于 <time> 开始，
      结果未知（进程被 kill/断电）。先验证副作用（读目标文件/跑只读命令）再决定
      重试或收尾；执行类工具须幂等或可验证。"
   - 这一步是**呈现层改动**（给 LLM 的上下文），不改 agent 循环语义，符合 B3。
3. 被托管接管的场景（原 agent 已死、租约过期，db.js:225-226；task_claim takeover，
   server.js:800-826）：接管方的 task_next / 复核上下文同样注入悬空信息。
4. 人工兜底：悬空行对应的任务在 dashboard 显示"待复核"（呈现层），
   人工可用 task_done（conclusion 说明复核结论）或 task_supersede 收尾。
```

**clean-exit vs kill -9 的判别**：agent.js:108 的 SIGINT 处理可加一行——优雅退出时给最后未结的 `call_key` 写 `phase='fail', error='user-abort'` 终态行；写不出（已断）就靠悬空扫描兜底。判别依据 = 该 call_key 有没有终态行，无需日志（日志本身不可靠）。

### 3.3 产物文件侧的崩溃一致性

- 写 `.tmp` 未 rename 即死 → 半个文件留在磁盘：恢复扫描按"非最终名文件 = 垃圾"处理（GC 删除），索引行从未产生（事务 4 未提交），无悬空引用。
- rename 完成、DB 事务 4 未提交即死 → 孤儿产物文件（有文件无索引行）：§4.3 的重建扫描收编，**可检测、可恢复**——这就是"先文件后 DB"订单的全部意义。
- 反向订单（先 DB 后文件）不存在于本设计；若有人改造成它，崩溃态 = 索引行指向不存在的文件，文件端扫描**看不到**（没有文件可扫），静默悬挂 → 代码评审红线。

---

## 4. ③ 备份纪律延伸

### 4.1 新表自动纳入 VACUUM INTO 快照与 7 份轮转（零改动声明）

- `VACUUM INTO` 产出**整个数据库文件**的一致点副本（db.js:686 注释：自包含、已整理、不阻塞其他连接）→ `tool_call_audit / approvals / artifacts / *_archive` 全在同一 .db 内，**daemon 现有每日备份（daemon.js:572 `backupDb(db, dbPath, { keep: 7 })`）一字不改即覆盖新表**。
- 轮转逻辑按文件名日期正则滚动删 7 份之外（db.js:709-724），新表不影响该逻辑。
- **唯一要新增的是增长控制**（审计事件是无限追加的）：
  - daemon 治理轮（每小时，daemon.js:599）把主表 >30 天（config key `audit.retention_days`，`readConfig` 缺省 30）的行**单事务**搬入 `_archive` 表（同文件内 INSERT…SELECT + DELETE；DELETE 合法因为归档是转移而非销毁，与 db.js:286-310 纪律一致）；
  - 哈希链跨归档表**不断链**：归档行原样带走 `prev_hash/row_hash`，校验器按"主表 + 归档表（按 id 段拼接）"分段验证；
  - 效果：主表常驻 ≤ 30 天事件量，VACUUM INTO 快照体积有界；归档表随 7 份快照滚动消失（7 天前的归档段不在最新快照内也仍在 .db 里——**注意**：归档表在本库内增长是无界的，长期要接受"审计历史即数据库资产"，或按年做 `VACUUM INTO` 冷归档到独立文件（`data/audit-cold-YYYY.db`，走同一套 VACUUM INTO 纪律，严禁 copy）。

### 4.2 改代码前手动快照 SOP（B2：data/memory.db.pre-*，必须 VACUUM INTO 而非 copy）

```powershell
# SOP-改代码前快照（Windows / pwsh，在 MemoryOS 数据目录执行）
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$env:MEMORY_DB = "C:\Users\WYX\AppData\Roaming\MemoryOS\data\memory.db"
node --input-type=module -e "
  import { DatabaseSync } from 'node:sqlite';
  import { env } from 'node:process';
  const p = process.env.MEMORY_DB;
  const db = new DatabaseSync(p);
  db.exec(`VACUUM INTO '${p}.pre-${process.env.SNAP_TS}'`);   # SNAPS_TS 见下
  db.close();
"
# 更稳的写法（避免单引号转义坑，db.js:705 已有同款转义先例）：
node dist/snapshot.js --out "data\memory.db.pre-$ts"      # 封装脚本，内部 VACUUM INTO + 打印体积
git add -A && git commit -m "pre-audit-v1: 能力迁移前基线" && git tag pre-audit-v1
```

SOP 五步（写进 CONTRIBUTING / 运维手册）：
1. **停写**（可选但推荐）：暂停 daemon 治理轮 / agent，避免快照窗口内事务干扰（VACUUM INTO 本身不阻塞，db.js:686，但停写让快照语义更干净）；
2. `VACUUM INTO data/memory.db.pre-<ts>`（**严禁 `Copy-Item memory.db`**——WAL 下活库复制是 B2 明令禁止的坏备份）；
3. 验证快照可用：`node -e` 打开快照（readOnly）跑 `SELECT COUNT(*) FROM tool_call_audit` + `PRAGMA integrity_check`；
4. `git commit + git tag` 固定代码基线（代码回滚锚点）；
5. 动手改代码 / 跑迁移。失败处置 = §6 的回滚剧本。

### 4.3 产物外部文件 × DB 索引的两段式一致性

**定序：先文件，后 DB。方向不可反（理由见 §3.3 崩溃矩阵）。**

```
写序（每个 artifact 实例）：
  1) path = data/artifacts/<task_id>/<id>-<safe-name>.<ext>.<rand4>.tmp
  2) 写内容 → fsyncFile → close
  3) rename(path → 去掉 .tmp 的最终名)          # 原子发布；rename 前磁盘上只有"垃圾"
  4) sha256 = 流式读最终文件实测（不信任写时的内存值）
  5) withTx: INSERT artifacts(…, sha256, size_bytes) + INSERT 审计终态行   # §2.2 事务4
崩溃矩阵：
  步3后死  → 最终名文件在、索引行无 → 孤儿，重建扫描收编（可检测）
  步5死    → 同上（rename 与 INSERT 之间）
  无"步5行在、文件无"的崩溃态 → 反向订单才有此态，本设计从根上排除
重建扫描（幂等，daemon 周期 + 崩溃恢复各跑一次）：
  for f in walk(data/artifacts/): 最终名文件
    若该 (task_id, 相对路径) 无索引行 → INSERT 重建行（sha256 实测），记 daemon_log(task='artifact-reindex')
    .tmp / 无归属 task 段 → GC 删除
校验（daemon 周期，抽样 + 崩溃后全量）：
  SELECT 每行 → 实测 sha256 比对 → 不符即 daemon_log(task='artifact-tamper', op='mismatch')
  并置 artifacts 行… 注意：artifacts 是可变表，可 UPDATE 打 tainted 标记列（+tainted INTEGER NOT NULL DEFAULT 0）
GC（删除方向的两段式）：
  保留窗口内（被最近 7 份快照引用的 task 段、未结项 task）永不删文件；
  到期的删除序 = 先 UPDATE artifacts.tainted/删除索引行（事务）→ 后 unlink 文件：
    中间死 = 行无文件在（读取端按"文件缺失"降级展示，可检测）；
    反向（先删文件后删行）中间死 = 行指向死文件且扫描收不回（文件已不在）—— 不可接受。
  即：写序保护"不产生悬挂行"，删序保护"不产生悬挂文件引用"，两个方向各自取可检测侧。
```

---

## 5. ④ 不可变审计的强度分析（分层 + 边界，结论先行）

**结论：触发器防"库内 SQL 通路"（误操作 + 应用内越权 + sqlite3 CLI 手工改删）；哈希链防"库内结构性破坏 + 整库回灌 + 页级篡改"；锚点防"拿旧快照冒充最新库"；三层合力仍防不住"拿到 .db 文件 + 锚点 + 7 份快照全部物理载体的人"——本地单机的信任边界就是文件系统权限本身（B3 本地部署模型下的可接受残余风险）。**

| 威胁 | L1 触发器 | L2 哈希链 | L3 锚点 | 残余 |
|---|---|---|---|---|
| 应用代码误 UPDATE/DELETE 审计行 | **挡**（RAISE(ABORT) 跨连接生效） | 检测 | — | 无（直接报错） |
| DB 管理员用 sqlite3 CLI 改删 | **挡**（触发器与连接无关） | 检测 | — | 无 |
| `DROP TABLE` + 重建 + 重灌（触发器不拦 DDL） | 不挡 | **检测**（id 断号 / sqlite_sequence 重置 / 链头突变） | 检测 | 延迟 = 校验周期（≤1h，daemon 轮） |
| 拿旧快照/VACUUM INTO 文件整体替换 .db | 不挡（旧文件内触发器原样在） | **检测**（库内链比锚点链短） | **检测** | 同上 |
| 页级 hexedit 改某行 | 不挡 | **检测**（重算不符） | — | 校验周期内 |
| 删 .db + 锚点 + 7 快照 + 代码 | 全灭 | 全灭 | 全灭 | **OS 级，超出本方案范围**（说明：这是"谁拥有这台机器谁就是审计终点"，与本地隐私优先（B3）一致；若需更强，出路是链头外发（远程签名服务），违背 B3，不在本方案内） |

实现备注：
- 触发器挡不住 `DROP TRIGGER` 本身（删掉触发器的动作是 DDL）——所以 L2 校验器每次运行**同时**断言 `SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('trg_tca_no_upd','trg_tca_no_del',…)` = 期望值，触发器被摘除 = 校验失败。
- `PRAGMA integrity_check` 只能证"页结构合法"，**不能**发现逻辑篡改——审计完整性以链校验为准，integrity_check 只作为 §7 的地板检查。
- 哈希链在 NORMAL 同步下的尾部：最后一个未 checkpoint 事务可能整段丢失（db.js:350）→ 校验器对"尾部不连续"容忍一个 checkpoint 周期，且**锚点只在 daemon checkpoint/备份轮次推进**（daemon.js:578-582 之后），保证锚点指向的链头是 checkpoint 确认过的。

---

## 6. ⑤ 可回滚的迁移方案（DDL 脚本 + 回滚脚本 + 纪律对齐）

**纪律前提（FACTS-PACK §备份与运行时纪律）**：代码回滚走 git 提交/tag；数据回滚走 VACUUM INTO 快照。故迁移剧本 = 快照（数据锚）+ tag（代码锚）双锚点，回滚两条腿独立可单飞。

### 6.1 迁移 DDL 脚本（新能力上线）

`dist/migrate-audit-v1.js`（独立可跑、幂等、单事务、config 标记——照 db.js:546-567 `migrateVectorsSplit` 模式）：

```js
const FLAG = "migration.audit_v1";
export function migrateAuditV1(db) {
  if (readConfig(db, FLAG, false) === true) return { skipped: true };
  withTx(db, () => {
    db.exec(`
      /* §2.1 全部 DDL：三张主表 + 两张归档表 + 全部索引 + 触发器 */
      CREATE TABLE IF NOT EXISTS tool_call_audit ( …§2.1 A… );
      CREATE TABLE IF NOT EXISTS approvals ( …§2.1 B… );
      CREATE TABLE IF NOT EXISTS artifacts ( …§2.1 C(+tainted 列)… );
      CREATE TABLE IF NOT EXISTS tool_call_audit_archive ( …§2.1 D… );
      CREATE TABLE IF NOT EXISTS approvals_archive ( …§2.1 D… );
      /* 索引、触发器同 §2.1 */
    `);
    writeConfig(db, FLAG, true);            // 标记与 DDL 同事务提交
  });
  return { ok: true };
}
```

执行剧本（顺序不可调）：
1. §4.2 SOP：`data/memory.db.pre-<ts>` 快照 + `git tag pre-audit-v1`（双锚就位）；
2. 跑 `node dist/migrate-audit-v1.js`（DDL 落地，flag 置位）；
3. 部署写入路径代码（§2.2 五事务 + §3.1 FULL 审计连接）+ 校验器 + daemon 归档/重扫任务；
4. 验收：注入一次 L1 工具调用，三表各出对应行；`PRAGMA integrity_check=ok`；链校验首轮通过。

### 6.2 回滚剧本（两条腿 + 可选 DDL 撤销）

**腿 A · 代码回滚（新代码有 bug）**：`git revert <capability-commit>` 回到 tag；**数据库不动**——新表/触发器/flag 留在库里无害（旧代码的显式列清单（db.js:11 `BASE_COLUMNS`、各 `SELECT` 指定列）对新表零感知，B3"只改呈现不改功能"反向同样成立：附加式 schema 对旧代码透明）。旧代码 + 新表 = 合法稳态。

**腿 B · 数据回滚（新表数据本身把库搞坏了 / 要彻底撤销新能力的数据面）**：
```powershell
# 停一切连接（daemon、agent、dashboard、MCP server），顺序：agent → dashboard → daemon
Remove-Item data\memory.db-wal, data\memory.db-shm -ErrorAction SilentlyContinue
Move-Item data\memory.db data\memory.db.broken-<ts> -Force     # 活库永不覆盖，留尸
Move-Item data\memory.db.pre-<ts> data\memory.db -Force         # 快照是 VACUUM INTO 产物（自包含、无 WAL 依赖，db.js:686）——
                                                                # "恢复自快照"合法，"复制活库"才违反 B2
# 重启（openDb 重建 WAL 模式 db.js:346；若代码在迁移后，迁移 flag 随快照回到迁移前 → 自动重跑，表重建为空，幂等）
```
注意：`Remove-Item memory.db` 是恢复操作不是备份操作——被移除的"尸"文件**不得**被后续任何流程当备份用（它带活库状态，正是 B2 禁止复制的那类文件）。

**腿 C · DDL 撤销（主动下线整个能力，非故障路径；三表数据已无业务价值时）**：
```sql
BEGIN IMMEDIATE;
DROP TRIGGER IF EXISTS trg_tca_no_upd; DROP TRIGGER IF EXISTS trg_tca_no_del;
DROP TRIGGER IF EXISTS trg_appr_no_upd; DROP TRIGGER IF EXISTS trg_appr_no_del;
DROP TABLE IF EXISTS tool_call_audit_archive;  DROP TABLE IF EXISTS tool_call_audit;
DROP TABLE IF EXISTS approvals_archive;        DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS artifacts;
UPDATE config SET value='false' WHERE key='migration.audit_v1';   -- 允许未来重装
COMMIT;
```
（触发器随 DROP TABLE 自动消失，显式列出仅为剧本可读；撤销前**先跑腿 B 的快照**，且按 §4.1 冷归档纪律把审计历史 `VACUUM INTO data/audit-cold-<ts>.db` 留底——审计数据是合规资产，删表不等于销毁事实。）

### 6.3 与既有纪律的一致性核对

| 纪律 | 本方案 | 判定 |
|---|---|---|
| B2 严禁复制活库 | 所有快照/回滚源 = VACUUM INTO 产物（db.js:707、merge-db.js:112-117 先例） | ✅ |
| B2 每日 7 份轮转 | 新表自动入 `backupDb`（db.js:694-735 零改动） | ✅ |
| 代码回滚 git / 数据回滚快照 | 腿 A / 腿 B 独立单飞，双锚（tag + pre-*） | ✅ |
| B3 只改呈现不改功能 | 迁移纯附加；旧代码路径不动 | ✅ |
| B1 写操作先获同意 | `approvals` 事件流即 B1 的持久审计承载（F7 修复的落库半边） | ✅ |

---

## 7. ⑥ 故障注入测试清单（验收门槛）

> 每条用例的"通过"判据都包含地板三件套：`PRAGMA integrity_check=ok`、链校验首轮通过、`daemon_log` 有对应记录。执行环境：测试库（独立 `MEMORY_DB` 指向 scratch 目录），**严禁在活库上注入**。

| # | 注入 | 步骤 | 预期 | 判据 |
|---|---|---|---|---|
| T1 | **kill -9**（`Stop-Process -Force` 于工具执行中） | T1a 有 FULL 审计连接版：跑 T1b；T1b 注入点 = 事务2 后、工具执行中 | 开库自动 WAL 重放；integrity ok；**start 行可读**（FULL 版）或可能缺（NORMAL 版，记录为已知丢失窗口）；悬空扫描命中该 call_key | `--resume` 运行后 user 消息含"结果未知，先验证副作用"段落（agent.js:174 注入点） |
| T2 | **断电**（VM 直接 poweroff / 拔电池电源，无 clean-exit） | 同 T1 注入点 + 同时令 daemon 处于每小时轮中 | 主库与 -wal 一致恢复；WAL 重放成功；最后一个未 checkpoint 事务允许丢（记录丢失行数 = 窗口证据）；start 行（FULL 版）在 | integrity ok；悬空集合 = 注入时刻集合 |
| T3 | **磁盘满**（data 卷 fill 至余量 < 2MB） | 触发一次带 artifact 的工具调用 | 写序第 2-3 步（fsync/rename）先失败 → 无索引行产生；若 DB 提交遇 SQLITE_FULL → withTx 回滚（db.js:850-853）无半行；错误以 MCP 错误帧上抛（**不静默吞**，F6 反面教材） | 恢复空间后：integrity ok；-wal 未膨胀；孤儿 .tmp 被重扫 GC；无"行在文件无"态 |
| T4 | **锁竞争**（双 node 进程并发写 + 一方持锁 6s 的长事务） | A 进程 BEGIN IMMEDIATE 后 sleep 6s 再提交；B 进程正常审计写 | B 在 5s（busy_timeout，db.js:347）内等锁失败 → withTx 3 次重试耗尽 → B 抛 `database is locked` 被应用捕获重排（记录在案，不静默） | 无死锁；A 提交后 B 重排成功；审计行无丢失（丢失即 B 重排成功补齐） |
| T5 | **篡改**（`UPDATE tool_call_audit SET …` / `DROP TABLE` / 旧快照整体替换） | 在 scratch 库分别执行 | UPDATE/DELETE → 触发器 ABORT（报 append-only 文案）；DROP TABLE 与整库替换 → 链校验首轮红（id 断号 / 链头与锚点 `data/audit-chain.log` 尾行不符）；触发器被摘除 → 校验器 sqlite_master 断言红 | 三类篡改全部在 ≤1 个 daemon 周期内被检出并记 `daemon_log(task='audit-tamper')` |
| T6 | **产物篡改**（改 data/artifacts/ 下任一文件 1 字节） | 跑 daemon artifact 校验 | 实测 sha256 ≠ 行内值 → `tainted=1` + daemon_log artifact-tamper；重建扫描不收编（文件仍在，只是被标脏） | dashboard 呈现层降级展示（红标），读取路径跳过 tainted 行 |
| T7 | **快照恢复演练**（腿 B 全流程 dry-run） | 在 scratch：迁移 → 写入审计数据 → 快照 → 恢复 → 旧代码（tag 前）开库 | 旧代码正常读写（附加表零感知）；迁移 flag 若被快照带走则自动幂等重跑 | 旧代码 `node dist/agent.js -m` 冒烟通过；integrity ok |
| T8 | **VACUUM INTO 体积/时长**（主表满载：10 万审计行 + 归档 30 万行） | 跑 `backupDb`（db.js:694）计时 | 备份时长 < 30s（超过则 §4.1 的冷归档提前）；轮转后目录恰好 7 份 `memory-*.db`（db.js:713 正则） | 7 份在盘、第 8 份最旧被删（返回 `removed` 列表，db.js:715-724） |
| T9 | **checkpoint 争用**（读连接长开时跑 TRUNCATE） | 开 readOnly 连接读大查询同时 daemon 轮 `checkpointWal` | 返回 busy=1（部分合并，db.js:496-500）→ 不算失败，下轮重试（daemon.js:580 注释） | 无报错上抛；WAL 最终截断 |

清单执行纪律：T1/T2 注入前先跑一次 §4.2 快照（注入本身就是"改数据面"）；全部用例在 git worktree/scratch 环境；结果记入 `daemon_log`（task='fault-injection'）——审计表本身成为审计结果的存放处，闭环。

---

## 8. 落地顺序建议（给主 agent 的排程参考）

1. **P0 前置**（与 F7 修复同批）：`approvals` 事件流 + `openAuditConn`（FULL）+ 审批五事务写路径——B1 的落库半边，先于执行工具上线（无执行工具时 approvals 表先为 memory_write 等既有写工具服务，纪律即刻生效）。
2. P1：`tool_call_audit` + 哈希链 + 校验器 + `--resume` 注入段落（呈现层，B3 合规）+ 悬空对账脚本。
3. P1：`artifacts` + 文件写序/GC/重扫 + daemon 归档（30 天水位）。
4. P2：锚点（`audit-chain.log` + tag 签名）、冷归档、T1-T9 全量注入、dashboard 审计呈现页（只呈现不改功能）。

**风险提示（无法确认项，依审查严谨性约束明列）**：① `VACUUM INTO` 产物文件的 header 在"恢复后重新 `openDb`"时的 WAL 行为——本方案依赖 db.js:346 每次 open 无条件 `PRAGMA journal_mode = WAL`（db.js:346）兜底，故无论快照 header 状态如何，恢复后必落 WAL；此依赖已写入 §6.2 腿 B 的"重启"步骤，无需额外验证。② node:sqlite 对 `RAISE(ABORT)` 抛出的 Error.message 文案格式（触发器内自定义消息是否完整透传）——无法在本环境实测，实现时以 T5 用例断言"消息含 append-only 字样"验收，不通则降级为捕获后断言 `ABORT` 语义即可。
