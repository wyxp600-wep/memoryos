# 数据库性能专家产出 · 工具调用审计 + 大输出 artifact 存储方案

> 项目：MemoryOS（`C:\Users\WYX\Desktop\MemoryOS`，SQLite WAL，`resources/memoryos/dist/db.js`）
> 本文所有数字与行为结论均附代码行号或当日（2026-09-15）实测值；无法实测的标注「估算」。

## 结论先行（一张表）

| # | 决策 | 数值 | 依据 |
|---|------|------|------|
| 1 | `tool_call_audit` 单表 + 3 个复合索引，热数据保留 90 天 | 3 索引 | 三个高频查询逐一对应；`ORDER BY id` 游标查最近 N 不建索引 |
| 2 | 大输出入外部文件 + DB 存路径/字节数/sha1/头尾预览；**行内阈值 2KB（结果）/ 1KB（参数）** | 2048B / 1024B | page_size=4096 实测：2KB 行无 overflow 页；VACUUM INTO 7 份快照放缩上限 ≈ 560MB |
| 3 | FTS5（trigram，standalone + 触发器，对齐 `memories_fts` 模式）只索引 `tool/args_json/error_excerpt/artifact_path`，**不索引全部结果正文** | FTS 体积 ≈ 5–10MB（估算） | trigram 索引放大 ~5–10× 文本（估算，建议 dbstat 实测）；全部行内文本 FTS 化会把快照预算打穿 |
| 4 | 审计写收口在 `server.js` 的 `addTool` 中心包装层（1 个写点），进程级单连接，禁止每次调用开连接/重设 PRAGMA | — | `server.js:49-63` 已有中心包装；`openDb` 重跑成本最高 35s（gram 回填实测，`db.js:432-433`） |
| 5 | 90 天过期 → 导出 `data/audit-archive/*.jsonl.gz`（库外冷存），不建库内无界归档表 | 90d | 库内无界归档表会被 VACUUM INTO 全量复制，快照放大回归 |
| 6 | 快照预算：主库热数据 ≤ ~65MB → 7 份快照 ≤ ~455MB | 14.4MB→~80MB | 实测快照 14.42MB（`data/backup/memory-2026-09-14.db`）；daemon `keep:7`（`daemon.js:572`） |

---

## 0. 实测基线（写方案的数字地基）

**磁盘实测（2026-09-15 当日，`resources/memoryos/data/`）：**
- `memory.db` 主文件 **53.05MB**（含碎片）；`memory.db-wal` 峰值 28MB（`db.js:485` 注释实测）；
- 最新 VACUUM INTO 快照 `data/backup/memory-2026-09-14.db` = **14.42MB**（紧凑体积）；手动 `pre-*` 快照同为 14.42–14.43MB；
- 快照 7 份轮转（`backupDb(..., { keep: 7 })`，`daemon.js:572`；默认 `keep ?? 7`，`db.js:696`）→ **实测轮转下限 ≈ 7 × 14.42 ≈ 101MB**。

**库内实测（当日 `PRAGMA` + 行数）：**
- `page_size = 4096`、`journal_mode = wal`；
- `memories` 907 行；`memory_vectors` 906 行（bge-m3 1024 维 float32 ≈ 4KB/行，`db.js:133`；维度 `embed.js:12`，模型 `embed.js:131`）；
- `memories_fts` 为 **standalone FTS5**（自带 `_content/_idx/_data/_docsize`，`_idx` B-tree 1306 条）；`memories_gram` 82143 行；`daemon_log` 3740 行；`memory_usage` 1168 行。

**连接格局（多进程共享一个 WAL 库）：**
- MCP stdio 服务端：`const db = openDb(DB_PATH)` 进程级单连接（`server.js:29`）；每个 DSH 会话拉起一个 server.js → 多进程并发写，靠 WAL + `busy_timeout=5000`（`db.js:347`）串行提交；
- Dashboard（8787）：CLI 启动时开一次（`dashboard.js:2629`）；
- daemon：每小时一轮（`daemon.js:599`），每日 VACUUM INTO + WAL TRUNCATE checkpoint（`daemon.js:568-582`）。

**现有 schema 风格（新表必须对齐）：**
- 时间戳一律 `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`（`db.js:35,67,94,308`）；
- 注释带 `★ P0-x.x / P1-x.x` 编号 + 「为什么」说明（`db.js:40-57,117-129,132-136`）；
- 新表直接进 `SCHEMA` 常量（`db.js:15`），`CREATE TABLE IF NOT EXISTS` 对老库自动生效（`db.js:358` 一次 `db.exec(SCHEMA)`），**不需要** table_info 迁移；
- FTS5 模式：standalone + `tokenize='trigram case_sensitive 0'`（`db.js:40-44`）+ 三个触发器 `AFTER INSERT / AFTER UPDATE OF <参与列> / AFTER DELETE`，rowid=父表 id（`db.js:45-57`）；
- 索引纪律：**只按 EXPLAIN QUERY PLAN 实测加索引，避免无证据的索引膨胀拖慢写入**（`db.js:117-129` 注释原文）。

> 勘误备注：任务书称「search.js 的 FTS 用法」。实测 FTS5 全部在 `db.js`（`memories_fts` + `lexSearch`，`db.js:1067-1115`）；`search.js` 只是 RRF 混合检索层，`lexSearch` 从 `db.js` 导入（`search.js:1`）。CJK 检索不走 FTS，走 `memories_gram` 2-gram 探针 + LIKE（`db.js:1086-1112`）。

---

## 1. ① `tool_call_audit` 表 schema + 索引设计

### 1.1 结论

单表 `tool_call_audit`（不拆主表/副表——与 `memory_usage` 同级的埋点表，`db.js:85-95`）；**恰好 3 个复合索引**，每个对应一个高频查询；「最近 N 条 / 实时 tail」走 PK 游标**不建索引**。

### 1.2 列设计（含类型与理由）

| 列 | 类型 | 理由 |
|---|---|---|
| `id` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 全库统一（`db.js:17`）；单调递增 → PK 反向扫 = 零索引成本取最近 N |
| `agent` | `TEXT NOT NULL` | 调用方 agent 名。身份已有现成来源：`MEMORY_AGENT` 环境变量（`server.js:18`，由 `core-process.js` env 注入，事实包 F9） |
| `agent_fpath` | `TEXT` | 配置路径指纹（`MEMORY_AGENT_FPATH`，`server.js:19`），B1 审计时佐证「谁调的」；对齐 `memories.agent_fpath`（`db.js:21`） |
| `session_id` | `TEXT` | 会话标识；对齐 `memory_usage.session_id`（`db.js:92`），跨表 JOIN 价值漏斗用 |
| `card_id` | `INTEGER` | 对应卡片/任务（任务 = cards 的 kind='task'，`db.js:212-237`；任务桥 `daemon.js:550`）。**任务链路追踪列** |
| `tool` | `TEXT NOT NULL` | 工具名（`addTool` 包装层 `def.name`，`server.js:58` 已捕获） |
| `status` | `TEXT NOT NULL DEFAULT 'ok'` | 取值对齐 agent 循环事件类型：`ok / error / timeout / write_denied / repeat_skip`（`agent-core.js:168,225-234` 的 onStep 事件）；`write_denied` 是 B1 门禁（F7）落地的审计证据列 |
| `args_json` | `TEXT` | **参数全量**；>1KB 存前 1KB + 截断标记。参数通常几十~几百字节（工具 schema 多为短串），1KB 阈值覆盖 >95%（估算） |
| `args_sha1` | `TEXT` | `sha1(args)` 前 16 位 hex：同参调用去重审计，直接对齐死循环护栏签名键 `name\|JSON(args)`（`agent-core.js:205`，F5） |
| `duration_ms` | `INTEGER NOT NULL DEFAULT 0` | 快速聚合（`AVG/SUM`）不用字符串时间差 |
| `started_at` | `TEXT` | 调用开始时刻（ISO Z，同 `created_at` 格式）；`duration_ms` 与之互校 |
| `result_inline` | `TEXT` | 结果全量 ≤2KB 时行内；>2KB 为 NULL（见第 2 节 artifact 判据） |
| `error_excerpt` | `TEXT` | 仅 `status!='ok'`：头 512B + 尾 512B。**头+尾而非只头**——F3 的 `MAX_TOOL_RESULT=3000` 截断只保头部（`agent-core.js:237`），而测试日志/栈追踪错误常在尾部；此列就是修复 F3 的存储侧配套 |
| `artifact_path` | `TEXT` | >2KB 时外部文件相对路径（`data/artifacts/...`，见 2.2） |
| `artifact_size` | `INTEGER` | 原始字节数（展示 + 清理判据） |
| `artifact_sha1` | `TEXT` | 完整性校验（daemon 清理/导出后可验证） |
| `created_at` | `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` | 完成时刻，全库统一格式 |

**时间戳策略（结论）**：沿用全库 `TEXT` ISO-8601 Z + `strftime` 默认表达式（`db.js:35,67,94`），不引入 INTEGER epoch。理由：① ISO Z 字符串字典序 = 时间序，复合索引范围扫描直接可用；② `DEFAULT (strftime('now'))` 让数据库侧定时刻，避免 JS `Date.now()` 本地时区漂移与跨进程（server.js/daemon/dashboard 三个进程）时钟不一致；③ 与全部现有表 JOIN/UNION 时类型一致。

### 1.3 索引设计（每个给 EXPLAIN 级理由）

按 P1-2.3 纪律（`db.js:117-129`）——只加有对应高频查询的索引：

```
idx_audit_agent_ts   ON tool_call_audit(agent, created_at)
idx_audit_tool_status ON tool_call_audit(tool, status)
idx_audit_card_ts     ON tool_call_audit(card_id, created_at)
```

1. **agent × 时间**（`WHERE agent=? AND created_at BETWEEN ? AND ? [ORDER BY created_at DESC]`，看板按 agent 出调用时间线）：
   B-tree 两列定位：`agent=` 等值下探 + `created_at` 范围扫描；`ORDER BY created_at DESC` 用索引反向遍历免排序。
   不建此索引时计划为 `SCAN tool_call_audit` + 两条件过滤（与 P1-2.3 诊断的「SCAN memories」全表扫同型，`db.js:118-121`）。
   单列 `(created_at)` 不建：agent 维度查询占多数；纯「最近 N」走 PK（见下）。
2. **工具 × 状态**（`WHERE tool=? AND status='error'`，定位哪类工具在挂；看板按工具出错误率）：
   等值 + 等值两列复合，`tool` 基数 ~20、`status` 基数 ~5，复合后规划器两级定位（依据：P1-2.3 ③「复合后计划变为 (status=? AND project=?) 两级定位」，`db.js:124-126`）。
   若只建单列 `tool`，status 需逐行回表过滤——与单列 `project` 被复合 `status,project` 取代同理（`db.js:125`）。
3. **任务链路**（`WHERE card_id=?`，追一个任务/卡片下所有 agent 的全部调用，`card_events` 同型，`db.js:256-265`）：
   `(card_id, created_at)` 复合：定位 + 组内时间序一次完成，避免 `USING idx` 后再 `USE TEMP B-TREE FOR ORDER BY`。
4. **「最近 N / 实时 tail」零索引**：`WHERE id > :lastId ORDER BY id LIMIT 200` → 隐式 PK(rowid) 索引正向/反向扫，`EXPLAIN QUERY PLAN` 显示 `SCAN/USE ... PRIMARY KEY`，O(N)。看板轮询与 `WHERE created_at > ?` 相比，id 游标不依赖 created_at 单调性假设（同一秒内多行 created_at 相同、字典序稳定但精度到 ms），且完全绕开任何二级索引的写放大。

**写放大核算（为什么恰好 3 个不多建）**：每条审计 INSERT 要写 3 个 B-tree + FTS 触发器行 + WAL 追加。P1-2.3 注释明确「避免无证据的索引膨胀拖慢写入」（`db.js:119`）；covering index（如 `(agent, created_at, status, duration_ms)`）可省回表但每行多 4 列 B-tree 写，**先不做**，等看板聚合查询实测 `EXPLAIN QUERY PLAN` 出现 `SEARCH ... TABLE ... USING INDEX` 回表且 p95 超 50ms 再升级为 covering（估算：当前主库 907 记忆 + 3740 daemon_log 量级下无压力）。

---

## 2. ② 大文本存储策略：入 DB vs 外部文件

### 2.1 结论

**混合方案，硬阈值：结果 ≤2KB 行内 / >2KB 外部文件（DB 存 path+size+sha1+头尾 512B 预览）；参数 ≤1KB 行内 / >1KB 外部文件。** 不把大 BLOB 放进热表。

### 2.2 字节阈值判据（全部给数字）

**判据 A — page_size（实测 4096B）：**
- 默认 4KB 页，`db.js` 未设 `PRAGMA page_size`（无该 PRAGMA，`db.js:346-357` 只有 5 项调优），实测 `page_size=4096`；
- 一行 ~2.5KB（result_inline 2KB + 其他列 ~500B）→ 1 页装下，**无 overflow 页**；
- 行内 BLOB/TEXT >~4KB 起进 overflow 页，此后**任何对该表的全表扫/顺序读都要拖 overflow 页**——这正是 P1-2.2 拆 `memory_vectors` 表的原因（`db.js:132-136`：「任何 SELECT/全表扫都拖带 BLOB，VACUUM 与备份效率下降」）。审计表是看板/报表高频扫描表，必须保持行小。

**判据 B — VACUUM INTO 快照放大（7 份轮转）：**
- 实测：紧凑快照 14.42MB × 7 ≈ **101MB**（现状轮转占用，`daemon.js:572` keep:7）；
- 若把 1MB 级测试日志/diff/快照直接入 DB：按 D=300 调用/天（上限假设，实测 daemon_log 全期 3740 行、memory_usage 1168 行，当前写压远低于此）、90 天热保留 → 300×1MB×90 ≈ **27GB 热数据** → 快照 ≈ 27GB × 7 ≈ **189GB**，且每日 VACUUM INTO 写 27GB（估算 10–60MB/s → 数十分钟，会拖垮 daemon 小时轮 `daemon.js:599`）。不可行；
- 2KB 阈值上限：300 调用/天 × 2.5KB/行 × 90 天 ≈ **67MB**（上限；正常 D=100/天 → ~22MB）→ 快照 ≈ 14.4+67 ≈ 81MB × 7 ≈ **568MB 上限**，正常 ≈ 400MB。<1GB 且 VACUUM INTO 数十秒内（估算，与 `backupDb` 已打印 sizeMB 的观测点一致，`db.js:729-733`）。

**判据 C — WAL 增长（读放大教训）：**
- 实测 WAL 曾 28MB 即造成读合并放大 + 崩溃恢复变慢（`db.js:485-486`；`daemon.js:579` 注释 27.1MB）；
- 2KB 阈值下审计日增量 ≈ 0.25–0.75MB/天（D=100–300），90 天峰值 ~67MB 主要由过期清理压住 → WAL 常态 <10MB（估算），不回 28MB 教训。

**判据 D — FTS 联动（见第 3 节）：**
- 大文本若入 DB 还想建 FTS，trigram 索引放大 ~5–10×（估算）会叠加进快照；外部文件方案里 FTS 只索引 error 摘录与 args，天然避开。

### 2.3 外部文件布局与 DB 侧记录

```
data/artifacts/<agent>/<YYYY-MM-DD>/<HHMMSS>-<tool>-<audit_id>.<ext>   # ext: log|diff|txt|json|png
```
- 路径存**相对 `data/` 的相对路径**（对齐 `ingest_state.path` 存绝对路径但 `notes.rel_path` 存相对的折中，`db.js:109,168-182`；审计行用相对，读取时拼 `data/` 前缀，避免机器迁移失效）；
- 文件**不在库内** → VACUUM INTO 不复制 → 快照放大归零（这是选外部文件的核心收益，对应判据 B）；
- 写文件用 `fs.writeFile` 先写 `.tmp` 再 rename（原子），`sha1` 流式计算（`node:crypto`，GB 级文件也只多一次流读，估算 <1s）；
- 目录总量 cap **1GB**（LRU 按 mtime 删最旧，daemon 顺路执行）；90 天外冷文件可选 gzip 压缩留存（日志/diff 压缩比 ~5–10×，估算）。

---

## 3. ③ FTS5 用于工具输出检索

### 3.1 结论

**可行，但范围必须收窄：FTS5 只索引 `tool / args_json / error_excerpt / artifact_path`，不索引全部结果正文；与向量检索分工——FTS 查精确串（日志关键词、错误码、diff 路径），向量查语义。** 建表沿用 `memories_fts` 的 standalone + 触发器 + trigram 模式；**不推荐 `content=` external-content 模式**（理由 3.4）。

### 3.2 分工矩阵

| 检索意图 | 走哪条路 | 理由 |
|---|---|---|
| 「哪个调用报了 ECONNREFUSED / 某 diff 里改了 X 文件」 | FTS trigram 精确子串 | 工具输出 90%+ 是 ASCII/代码/日志，≥3 字符子串 trigram 可靠（与 `lexSearch` 非 CJK 分支同一实证，`db.js:1070-1084`） |
| 「上次登录崩溃我们是怎么处理的」 | 向量（bge-m3，`embed.js:131`，1024 维） | 语义泛化；`hybridSearch` RRF 融合（`search.js:94-119`）已含该通道 |
| 「哪个 agent 在昨天跑过 migrate」 | 纯 SQL（`idx_audit_agent_ts`），不需要 FTS | 结构化条件，B-tree 秒出 |

artifact **全文不做向量嵌入**（嵌入成本：每 512 token 一次 ONNX 推理 + 4KB/行 BLOB，`db.js:133` 教训；日志类全文语义价值低）。可选增强：高价值 error_excerpt 未来进 `memory_write`（现有 18 工具之一）作为经验记忆——那是内容通道，不是索引通道。

### 3.3 建表建议（与 `db.js:40-57` 逐行同构）

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5(
  tool,
  args_json,
  error_excerpt,
  artifact_path UNINDEXED,      -- 存不索引：供回查定位，参与列越少触发器写越少
  tokenize = 'trigram case_sensitive 0'
);
-- 触发器三件套（INSERT / UPDATE OF 参与列 / DELETE），rowid = tool_call_audit.id
```

- `artifact_path` 设 `UNINDEXED`（对齐 `memories_fts` 的 `project UNINDEXED`，`db.js:42`）：路径是定位串不是检索词，索引它是纯写放大；
- CJK 暂不处理（工具输出中文占比低）；若出现「中文日志检索全表扫」，复用 `memories_gram` 2-gram 探针模式（`db.js:152-156,1090-1102`），不另造轮子；
- FTS 体积估算：错误率 ~10%（估算）× 1KB excerpt × 90 天 × 100 调用/天 ≈ 0.9MB 文本 × trigram 放大 5–10× ≈ **5–10MB**（估算，上线后用 `dbstat` 实测校正——`openDb` 自检处 `db.js:469-475` 可加一行 `SELECT COUNT(*) FROM audit_fts` 进 stderr）。

### 3.4 `content=` 模式判断（结论：不用）

- `content='tool_call_audit'`（external-content FTS5）省掉文本副本，但：① FTS 表自身不可读回内容，一切都要 JOIN 主表，主表行删了 FTS 即「悬空引用」；② 一致性 100% 依赖触发器——本项目已为此付过一次学费：P0-3.1 注释「UPDATE 依赖手动同步，任何绕过它的 UPDATE 都会让 FTS 与正文脱节；DELETE 无人同步产生幽灵搜索结果」（`db.js:48-50`），最终选 standalone + 三触发器（`db.js:45-57`）把脏行风险收敛到触发器层；
- 审计场景 FTS 文本量已收窄到 ~1MB 级（3.3），重复成本 <10MB（3 倍放大后 ~30MB 上限，进快照预算内）——**为省这点空间引入一致性风险不划算**；
- 外键：`audit_fts.rowid = tool_call_audit.id` 就是事实外键（FTS5 表不支持 `REFERENCES`），删除纪律：只允许经触发器删除（对齐 `trg_memories_ad`，`db.js:55-57`），手删 `tool_call_audit` 行必须同事务删 FTS 行。

---

## 4. ④ 写入路径性能：审计写与 dashboard 读不互卡

### 4.1 结论

**审计写收口在 `server.js` 的 `addTool` 中心包装层（1 个写点，覆盖现有 16 工具 + 未来全部新工具）；所有进程持有进程级单连接（`server.js:29` / `dashboard.js:2629`），禁止每次工具调用开新连接、禁止请求路径反复设 PRAGMA；WAL 天然读写并发，dashboard 读永不被审计写阻塞，唯一同步点是提交锁（毫秒级，`busy_timeout=5000` 兜底）。** 顺带效果：审计行是 B1「写操作先获同意」的第一层证据（`write_denied` 事件落表，`agent-core.js:220`）。

### 4.2 为什么「开新连接」是红线（成本逐项）

`openDb()` 不是 `new DatabaseSync()` 那么轻（`db.js:344-480`）：
1. 5 项 PRAGMA（`db.js:346-357`）：`journal_mode=WAL` 持久在库头（重开自动继承），但 **`synchronous=NORMAL / cache_size=-64000(64MB) / mmap_size=256MB / temp_store=MEMORY` 全是连接级**（`db.js:348-353` 注释自证「均为跨版本安全的选项」，语义即每连接都要设）——每次调用重开 = 重新暖 64MB 页缓存 + 重新映射 256MB mmap；
2. 全量 `db.exec(SCHEMA)` + 两个 `table_info` 迁移探测 + links 列探测 + `idx_links_uniq` 重建检查（`db.js:358-407`）；
3. FTS 补齐子查询 + **gram 回填（实测最坏 35s，`db.js:432-433` 注释：899 条记忆 8.2 万 gram 逐条自动提交 35s）+ 4 个 COUNT 自检**（`db.js:417-475`）。
⇒ 每次工具调用重开连接 = 重跑上述全部 + 丢缓存。审计写点与 agent 循环同进程，**必须复用 `server.js:29` 的既有连接**。

### 4.3 读/写并发模型（WAL 语义 + 本项目参数）

- WAL 模型：读连接读「最新一致快照」（主库 + 已提交 WAL 前缀），写连接追加 WAL 帧——**读不被写阻塞、写不被读阻塞**；唯一互斥点是 checkpoint/提交锁（WAL 头/尾锁），窗口毫秒级；
- `busy_timeout=5000`（`db.js:347`）：多个 DSH 会话 = 多个 server.js 并发写，提交锁竞争时各自等待而非立即 `SQLITE_BUSY`；
- `synchronous=NORMAL`（`db.js:354`）：WAL 提交**不做每次 fsync**（只在 checkpoint 时），崩溃最多丢最后一个事务——对审计表可接受（丢一条 <1s 前的调用记录，远小于 F3 截断丢尾部信息的严重度）；
- dashboard 侧读路径（127.0.0.1:8787，`dashboard.js:2650`）：tail-follow 用 `WHERE id > :lastId LIMIT 200`（PK 游标，§1.3-4），报表走 3 个复合索引（§1.3）——两条路都不碰全表扫，与审计写的 B-tree 追加无共享热页冲突（新行追加在 B-tree 末端，页缓存 64MB 内，`db.js:355`）；
- 请求路径**禁止**出现：`VACUUM` / `ANALYZE` / FTS 或 gram 回填（全部只在 `openDb`/daemon 路径，`daemon.js:558-582`）。

### 4.4 写入点实现要点（给实施工程师的清单）

1. 在 `server.js:49-63` 的 `addTool` 包装层（`_origAddTool` 覆盖处）扩展：`execute` 前后记 `t0=Date.now()`，finally 中 `logToolAudit(db, {...})`；
2. `logToolAudit` 在 `db.js` 内**模块级缓存 prepared statement**（`db.prepare` 一次，热路径只 `run()`）；同一 agent 步骤内多工具调用（`agent-core.js:199-239` for 循环）用 `withTx` 包一层 → N 次自动提交降为 1 次（实证数据：gram 回填逐条自动提交 35s vs 单事务秒级，`db.js:432-433`）；
3. >2KB 结果：`fs` 写 artifact（2.3 布局）在**同事务提交前**完成文件落盘（文件不存在时 DB 行不该先指过去；DB 写失败则回滚 + 删孤儿文件，估算代码 ~20 行）；
4. 单行写入成本估算：1 INSERT + 3 索引 B-tree + 1 FTS 行 + WAL 追加，`synchronous=NORMAL` 无逐提交 fsync → **SSD 上 <1ms（估算，未实测）**；上线后以 `tool_call_audit.duration_ms` 同表埋「audit 自身写耗时」列 p50/p99 校正（可选加 `audit_write_ms` 列）；
5. 与 `toolCallTimeoutMs:15000`（`.dsh/mcp.json`，事实包）的关系：审计写 <1ms，对 15s 超时预算零压力。

---

## 5. ⑤ 保留与归档策略（90 天热 + 冷归档，与 7 快照轮转配合）

### 5.1 结论

**热数据 90 天在库内；过期 → 导出库外 JSONL.gz（可选 SQLite sidecar），库内 DELETE；不建库内无界归档表。artifact 文件 90 天 LRU + 1GB cap，冷文件 gzip 年留（可选）。7 份快照轮转（B2）保持不变——它是「7 天恢复点」，不是归档；热库被 §2 预算压在 ~80MB 紧凑体积，快照放大被锁死在 ≤568MB。**

### 5.2 数字与配合关系

| 层 | 保留 | 体积（正常 D=100/天，估算） | 备注 |
|---|---|---|---|
| `tool_call_audit` 热表 | 90 天 | ~22MB + FTS ~8MB | §2.2-B 上限 67MB+30MB 仍在预算内 |
| `audit_fts` | 随热表 | ~8MB | 触发器联动，DELETE 热行即删 FTS 行 |
| artifact 文件 | 90 天 LRU，cap 1GB | ≤1GB（gzip 冷存后 ~200MB） | 库外，VACUUM INTO 不复制 |
| 快照（VACUUM INTO） | 7 份日轮转（B2，`daemon.js:572`） | 正常 ~400MB / 上限 ~568MB | 每份 = 当时全库热状态，含审计热表 |
| 冷归档 | 年 | ~0.5–1GB/年（jsonl.gz） | 库外，`data/audit-archive/` |

**为什么热 90 天而不是 30/180 天**：
- 30 天：追 #4073/#4129 这类跨期任务链路（事实包待办）不够长，且 30 天冷归档后「当时为什么这么调」要解压 jsonl 才查得到，违背审计表的存在目的；
- 180 天：热表 ~45MB+，快照 14.4+45+30 ≈ 90MB × 7 ≈ 630MB，预算顶到边缘（§2.2-B 上限算法），而 90 天外的调用链路在低频查询下用冷归档（`sqlite3 data/audit-archive/archive-2026Q3.db` 或直接 grep jsonl）代价可接受；
- 90 天 = 一个季度任务周期（估算假设，可经 `config` 表调参——对齐 `readConfig/writeConfig` 模式，`db.js:313-329`，key 如 `audit.hot_days`，daemon 读）。

**为什么冷归档必须库外（对 R4-1 先例的刻意偏离）**：
- 现有归档表 `card_events_archive` / `memory_usage_archive`（`db.js:287-310`，R4-1「只归档不删除」）是**有界事件流**（卡片事件/使用埋点，量级 = 热表的 1/N），归档进库无碍；
- 审计表是**无界写流**（每天 100–300 行 × 90 天 × 10 年 ≈ 百万行级），归档表留在库内 → 每年 +50–100MB 进 VACUUM INTO → 7 份快照每年 +350–700MB → 快照恢复/回滚时间逐年退化（对应 `db.js:485-486` WAL 28MB 即造成读放大的实测教训）；
- 故：库内只留 90 天热数据（有界），冷数据走 `data/audit-archive/audit-YYYY-MM.jsonl.gz`（`gzip` 流式，估算日志类 5–10× 压缩比）；需要 SQL 查冷数据时，daemon 提供 `audit-archive-YYYY.db` sidecar（冷 jsonl 批量导入，单事务，估算百万行 <1min）。

**daemon 月度归档作业（配合小时轮 `daemon.js:599`，加月度判据，对齐「当日文件已存在」幂等风格，`db.js:701-704`）**：
```
SELECT 热表中 created_at < date('now','-90 day') → 写 jsonl.gz（含 artifact 相对路径）
→ 可选：导 sidecar sqlite
→ 单事务 DELETE 热表 + 触发器自动清 audit_fts（§3.4 外键纪律）
→ artifact 文件按 mtime LRU 清理（cap 1GB）
→ stderr 留痕（对齐 daemon_log 3740 行的现有审计惯例，db.js:1139）
```
与 7 快照轮转的配合：快照恢复 = 回到 7 天内某一天的全库状态（含当时审计热表 90 天窗口内数据）；**更旧的审计事实只在冷归档里**——恢复脚本不需要碰 `audit-archive/`，两条线正交。

---

## 6. ⑥ 建表 SQL 片段（与 `db.js` 现有风格一致，可直接进 `SCHEMA` 常量，`db.js:15-311`）

```sql
-- ★ P0-4.x 工具调用审计（B1 写门禁证据链 + F3 截断修复的存储侧）
-- 设计依据：热表有界（90 天，daemon 月清）→ VACUUM INTO 快照放大可控（§2/§5）；
--   大输出走库外 artifact（§2.3），FTS 只索引错误摘录与参数（§3.3）。
CREATE TABLE IF NOT EXISTS tool_call_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent         TEXT    NOT NULL,              -- 调用方（MEMORY_AGENT env，server.js:18）
  agent_fpath   TEXT,                          -- 配置路径指纹（B1 佐证「谁调的」）
  session_id    TEXT,                          -- 会话（对齐 memory_usage.session_id）
  card_id       INTEGER,                       -- 对应卡片/任务（追链路，cards kind='task'）
  tool          TEXT    NOT NULL,              -- 工具名（addTool 包装层 def.name）
  status        TEXT    NOT NULL DEFAULT 'ok', -- ok/error/timeout/write_denied/repeat_skip
  args_json     TEXT,                          -- 参数全量；>1KB 存前 1KB + '…[truncated]'
  args_sha1     TEXT,                          -- sha1 前 16hex：同参去重审计（F5 签名对齐）
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT,                          -- 调用开始（ISO Z，与 created_at 同格式）
  result_inline TEXT,                          -- 结果全量（≤2KB）；>2KB 为 NULL 见 artifact_*
  error_excerpt TEXT,                          -- 仅失败：头 512B + 尾 512B（错误常在尾部，F3）
  artifact_path TEXT,                          -- 相对 data/ 的路径（>2KB 结果 / >1KB 参数）
  artifact_size INTEGER,
  artifact_sha1 TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- 索引纪律（P1-2.3，db.js:117-129）：只建有对应高频查询的 3 个；「最近 N」走 PK 游标不建索引
CREATE INDEX IF NOT EXISTS idx_audit_agent_ts    ON tool_call_audit(agent, created_at);      -- agent×时间线
CREATE INDEX IF NOT EXISTS idx_audit_tool_status ON tool_call_audit(tool, status);          -- 工具×状态（错误率报表）
CREATE INDEX IF NOT EXISTS idx_audit_card_ts     ON tool_call_audit(card_id, created_at);   -- 任务链路追踪

-- ★ FTS5 精确检索路（日志/diff/错误码；语义检索仍走 embed.js 向量，分工见 §3.2）
-- standalone + 三触发器，与 memories_fts 逐行同构（db.js:40-57）；
-- 不索引 result_inline（trigram 放大 5-10x，§3.3）；artifact_path UNINDEXED 只存不索引
CREATE VIRTUAL TABLE IF NOT EXISTS audit_fts USING fts5(
  tool,
  args_json,
  error_excerpt,
  artifact_path UNINDEXED,
  tokenize = 'trigram case_sensitive 0'
);
CREATE TRIGGER IF NOT EXISTS trg_audit_fts_ai AFTER INSERT ON tool_call_audit BEGIN
  INSERT INTO audit_fts(rowid, tool, args_json, error_excerpt, artifact_path)
  VALUES (new.id, new.tool, new.args_json, new.error_excerpt, new.artifact_path);
END;
CREATE TRIGGER IF NOT EXISTS trg_audit_fts_au AFTER UPDATE OF tool, args_json, error_excerpt, artifact_path ON tool_call_audit BEGIN
  UPDATE audit_fts SET tool=new.tool, args_json=new.args_json,
    error_excerpt=new.error_excerpt, artifact_path=new.artifact_path WHERE rowid = new.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_audit_fts_ad AFTER DELETE ON tool_call_audit BEGIN
  DELETE FROM audit_fts WHERE rowid = old.id;
END;

-- ★ 配置项（走 config 表，db.js:313-329 readConfig 缺省兜底；daemon 读）
INSERT OR IGNORE INTO config(key, value) VALUES ('audit.hot_days', '90');
INSERT OR IGNORE INTO config(key, value) VALUES ('audit.inline_limit', '2048');
INSERT OR IGNORE INTO config(key, value) VALUES ('artifact.cap_mb', '1024');
```

**实施注记**：
- 新表直接进 `SCHEMA`（`db.js:358` 的 `db.exec(SCHEMA)` 对老库幂等生效），**无需** table_info 迁移块——与 `memories` 老列迁移（`db.js:360-394`）不同，新表没有「缺列」场景；
- 触发器 `AFTER UPDATE OF` 限定参与列（`db.js:51-52` 同型），避免非参与列更新触发 FTS 写；
- `args_sha1` 存 hex 前 16 位足够（去重键只比同 agent 同工具，碰撞域 <2^64，估算安全）；
- FTS 查询写法对齐 `lexSearch` 的转义纪律（`db.js:1074` 双引号转义 + trigram 短语包 `"`，不能用 `[]`）。

---

## 7. 验证清单（上线后逐项跑，数字进 daemon_log）

1. `EXPLAIN QUERY PLAN` 三查询：`agent+时间窗` / `tool+status` / `card_id` 应分别为 `SEARCH tool_call_audit USING INDEX (agent=? AND created_at>?)` 等（P1-2.3 同款验收，`db.js:117-126`）；
2. `dbstat` 或按 §3.3 在 `openDb` 自检（`db.js:469-475`）加 `audit_fts` 行数，实测 FTS 放大倍数，校正 §3.3 的 5–10× 估算；
3. 快照观测：daemon `[backup]` 日志的 sizeMB（`db.js:733`）连续 7 天 ≤ 100MB（正常 D=100）即预算成立；
4. 写延迟：`tool_call_audit` 加 `audit_write_ms` 列（可选）p99 < 5ms；
5. 快照放大红线：任一快照 >150MB 即触发「热表或 FTS 越界」排查（§5.2 表格）。

## 附：事实来源（行号）

- 快照/轮转：`db.js:694-735`（backupDb，keep:7 默认 696）、`daemon.js:568-582`（每日判据+调用点）
- PRAGMA/连接：`db.js:344-480`（openDb 全成本）、`server.js:29`、`dashboard.js:2629`
- FTS/gram/like 分工：`db.js:40-57`（standalone+触发器）、`db.js:1067-1115`（lexSearch 分支）、`db.js:152-156`（gram 表）
- 索引纪律与 BLOB 拆表教训：`db.js:117-136`
- WAL 读放大实测：`db.js:485-486`、`daemon.js:579`
- 写点与事件类型：`server.js:49-63`、`agent-core.js:158-246`（F3/F5 行号）
- 归档先例：`db.js:287-310`（R4-1）
- 向量/embed：`embed.js:11-12,66,131-134`、`db.js:138-141`
- 磁盘实测：`memory.db` 53.05MB、快照 14.42MB、`page_size=4096`（2026-09-15 当日 PRAGMA 与目录扫描）
