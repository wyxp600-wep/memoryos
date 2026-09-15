/**
 * MemoryOS v0.1 → v0.2 — db 层（node:sqlite，零原生依赖）
 * SQLite(WAL) + FTS5 trigram + AFTER INSERT 触发器 + scope 隔离。
 * v0.2 增：status/confidence/hit_count/last_hit_at/embedding(BLOB) + 去重/冲突预检。
 * 引擎约束（实证）：node:sqlite 禁 load_extension → 向量用 BLOB 存 + JS 余弦，见 V5.1 R2 实现说明。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { vecToBuf, bufToVec, cosine } from "./embed.js";
const BASE_COLUMNS = "id, content, type, agent, agent_fpath, project, status, confidence, eff_confidence, conflict_with, superseded_by, derived_from, hit_count, last_hit_at, created_at, sector, form, salience, decay_lambda, last_seen_at, valid_from, valid_until, trigger_cond, trigger_kind, trigger_action, valence, arousal, source_ref, sensitivity, pinned, version, fencing_token, epoch, idempotency_key, causal_parent";
function joinPrefix(s) {
    return s ? `[${s.replace(/"/g, '""')}]` : "";
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content     TEXT    NOT NULL,
  type        TEXT    NOT NULL DEFAULT 'experience',
  agent       TEXT    NOT NULL,
  agent_fpath TEXT,
  project     TEXT    NOT NULL DEFAULT 'global',
  status      TEXT    NOT NULL DEFAULT 'active',     -- active/merged/superseded/rejected/archived
  confidence  REAL    NOT NULL DEFAULT 0.8,
  eff_confidence REAL,                              -- v0.3 衰减后有效置信（daemon 维护）；NULL=未衰减
  conflict_with INTEGER,                            -- v0.3 疑似冲突指向的旧记忆 id
  superseded_by INTEGER,                            -- v0.3 被哪条取代（去重/仲裁）
  derived_from  INTEGER,                            -- v0.3 溯源
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  embedding   BLOB,                                  -- float32[]（v0.2 向量 / 语义路）
  -- ★ P1-2.4：正文被编辑后置 1，表示 embedding 已与正文语义脱节，待 daemon 重算。
  -- 为什么需要它：编辑不重算向量时，语义检索会命中「与正文不符」的记忆 —— 比搜不到更糟。
  embedding_stale INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_status_eff ON memories(status, eff_confidence);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  project UNINDEXED,
  tokenize = 'trigram case_sensitive 0'
);
CREATE TRIGGER IF NOT EXISTS trg_memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, project) VALUES (new.id, new.content, new.project);
END;
-- ★ P0-3.1：补齐 UPDATE/DELETE 同步。原先只有 AFTER INSERT 触发器：
--   · UPDATE 依赖 updateMemory() 内手动同步 —— 任何绕过它的 UPDATE 都会让 FTS 与正文脱节；
--   · DELETE 完全无人同步 —— FTS 残留脏行，产生"幽灵搜索结果"（能搜到但读不到正文）。
--   content/project 是 FTS 的参与列，故用 OF 限定，避免 type/status 等更新触发无谓的索引写。
CREATE TRIGGER IF NOT EXISTS trg_memories_au AFTER UPDATE OF content, project ON memories BEGIN
  UPDATE memories_fts SET content = new.content, project = new.project WHERE rowid = new.id;
END;
CREATE TRIGGER IF NOT EXISTS trg_memories_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE rowid = old.id;
END;

-- ★ v0.3 治理：daemon/人工归档/仲裁的审计留痕
CREATE TABLE IF NOT EXISTS daemon_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task        TEXT    NOT NULL,                   -- decay / archive / dedupe / arbitrate / manual-archive
  op          TEXT    NOT NULL,                   -- eff_update / archive / unarchive / merge / supersede / reject
  memory_id   INTEGER,
  detail      TEXT,                               -- 变更理由/前后值要点
  operator    TEXT    NOT NULL DEFAULT 'daemon',  -- daemon 或 human:dashboard / human:arbitrate
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_daemon_log_mem ON daemon_log(memory_id);

-- ★ v0.3 仲裁事件表（M-2.4）：before 快照 + undone 标记，撤销与审计的基础
CREATE TABLE IF NOT EXISTS memory_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   INTEGER,                              -- 被仲裁/操作的主记忆 id
  op          TEXT    NOT NULL,                     -- possible-conflict / keep_new / keep_old / merge / no_conflict / undo
  payload     TEXT,                                 -- before 快照 JSON（裁决前双方行状态，供 u 还原）
  operator    TEXT    NOT NULL DEFAULT 'human:arbitrate',
  undone      INTEGER NOT NULL DEFAULT 0,           -- 1=已撤销
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mem_events_mem ON memory_events(memory_id);

-- ★ 使用埋点表（价值度量基础，M-1.5）
-- event: write / returned / cited；reader_agent≠writer_agent → 跨工具复用（cross-tool）
CREATE TABLE IF NOT EXISTS memory_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     INTEGER NOT NULL,
  event         TEXT    NOT NULL,              -- write / returned / cited
  reader_agent  TEXT,                          -- 消费方（returned/cited；write 时=写入方）
  writer_agent  TEXT,                          -- 写入方
  project       TEXT    NOT NULL DEFAULT 'global',
  session_id    TEXT,                          -- 会话标识（inferred-cited 判定基础）
  task_hint     TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON memory_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_memory  ON memory_usage(memory_id);
CREATE INDEX IF NOT EXISTS idx_usage_event   ON memory_usage(event);

-- ★ v0.3 治理规则配置（M-记忆卫生）：KEY→JSON。缺省走代码内默认，本表存在即覆盖
CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ★ 采集增量水位（M-采集自动化）：记录每个源文件的 (size, mtime)，
-- 下一轮只处理「变了」的文件 → 让定时采集的空跑成本降到 stat 级（几十 ms）。
CREATE TABLE IF NOT EXISTS ingest_state (
  path       TEXT PRIMARY KEY,                    -- 源文件绝对路径
  size       INTEGER NOT NULL DEFAULT 0,
  mtime_ms   INTEGER NOT NULL DEFAULT 0,
  last_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ingest_state_last ON ingest_state(last_at);

-- ★ P1-2.3 索引补齐（依据 EXPLAIN QUERY PLAN 实测，而非猜测）
-- 诊断结论：多数报表查询（write/returned/Top/僵尸/跨工具）已由 idx_usage_event 覆盖，
-- 实测真正的全表扫描只有下面两处，故只补这两个（避免无证据的索引膨胀拖慢写入）：
--   ① 按 agent 统计 GROUP BY agent            → SCAN memories
--   ② trend 按日分组（仅时间条件，无 event）  → SCAN memory_usage
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent);
CREATE INDEX IF NOT EXISTS idx_usage_created ON memory_usage(created_at);
--   ③ 候选池 SELECT ... WHERE status='active' AND project IN (...)：
--      原走 idx_memories_status_eff(status) 只定位到 status，再逐行过滤 project；
--      建复合后计划变为 (status=? AND project=?) 两级定位，实测被查询规划器选中。
--   ④ 保留 idx_memories_project 不删：复合索引最左前缀是 status，
--      无法服务「只按 project 过滤」的查询（如 getVectorsOnProject 的 activeOnly=false 路径）。
--   ⑤ 不建 memory_usage(reader_agent)：漏斗查询已被 idx_usage_created 覆盖，实测无收益。
CREATE INDEX IF NOT EXISTS idx_memories_status_project ON memories(status, project);

-- ★ P1-2.2 向量独立表。
-- 背景：embedding 原为 memories 表的 BLOB 列（1024 维 float32 ≈ 4KB/行），
--   导致：① memories 行宽膨胀；② 任何 SELECT/全表扫都拖带 BLOB（即便只需正文）；
--   ③ VACUUM 与备份效率下降。
-- 拆表后：正文表瘦身，读正文不再触碰向量；向量仅在语义检索/去重路径按需读取。
-- 迁移见 openDb 内的 migrateVectorsSplit（事务内、幂等、以 config 标记防重复）。
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id INTEGER PRIMARY KEY,
  embedding BLOB    NOT NULL
);

-- ★ P0-3.4 CJK 2-gram 倒排索引（修复中文检索全表扫）
-- 背景：memories_fts 用 trigram 分词，对 <3 字符（尤其中文 2 字词）不产 token，
--   导致中文查询一直落到 content LIKE '%q%' —— 前导通配符使索引完全失效，
--   每次中文检索都全表扫描（实测中文正是主要使用场景）。
-- 方案：写入时把正文中「相邻两个 CJK 字符」切为 gram 存入本表；
--   检索时先用 gram 精确点查把候选集收窄，再用 LIKE 精筛。
--   正确性：bigram 命中是「子串命中」的必要条件（content 含 "缓存" 则必含 bigram "缓存"），
--   故索引收窄不会漏召回，LIKE 精筛保证子串语义精确。
--   无 CJK 的正文写入空串哨兵，用于标记「已同步但无 gram」，避免每次启动重复回填。
CREATE TABLE IF NOT EXISTS memories_gram (
  gram      TEXT    NOT NULL,
  memory_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gram_lookup ON memories_gram(gram, memory_id);

-- ★ v0.4 记忆类别（10 sector）+ 统一链接图 + 卡片看板
-- 设计依据：OpenMemory HMD 认知分层（sector + λ 衰减 + 权重）、A2A Task 模型、
--   Hermes Kanban（CAS 认领 / lease / 熔断 / 事件流）、Obsidian wikilink 规范。
-- 全部为「附加」结构：旧代码 SELECT 指定列不受影响，可回退。

-- 注：memories 的 sector/valid_until/pinned 索引不在此处建 —— SCHEMA 先于 ALTER TABLE 执行，
--     此时新列尚不存在，建索引会抛 "no such column"。故移至 openDb 的加列之后。

-- 笔记镜像（vault 笔记 + 用户自建笔记统一存放；links 的 note 节点来源）
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_root TEXT    NOT NULL,
  rel_path   TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  aliases    TEXT,
  tags       TEXT,
  sector     TEXT,
  body       TEXT    NOT NULL,
  hash       TEXT    NOT NULL,
  memory_id  INTEGER,
  mtime_ms   INTEGER NOT NULL DEFAULT 0,
  origin     TEXT    NOT NULL DEFAULT 'vault',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT,
  UNIQUE(vault_root, rel_path)
);
CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(title);
CREATE INDEX IF NOT EXISTS idx_notes_mem   ON notes(memory_id);

-- 统一链接图：note / memory / card 三类节点共用（双向链接 + 卡片互联同一套存储）
-- vault_root：M12 多 vault 隔离 —— 链接解析/回填一律限定在源笔记所属 vault 域内，
--   杜绝 A vault 的 [[X]] 错解到 B vault 同名笔记。memory/card 源时可为空。
CREATE TABLE IF NOT EXISTS links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_root TEXT,
  src_kind   TEXT NOT NULL,
  src_id     INTEGER NOT NULL,
  dst_kind   TEXT NOT NULL,
  dst_id     INTEGER,
  dst_title  TEXT,
  kind       TEXT NOT NULL,
  anchor     TEXT,
  alias      TEXT,
  context    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_links_src   ON links(src_kind, src_id);
CREATE INDEX IF NOT EXISTS idx_links_dst   ON links(dst_kind, dst_id);
CREATE INDEX IF NOT EXISTS idx_links_title ON links(dst_title);
CREATE INDEX IF NOT EXISTS idx_links_vault ON links(vault_root);
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_uniq ON links(
  src_kind, src_id, kind, IFNULL(dst_id, -1), IFNULL(dst_title, ''), IFNULL(anchor, ''), IFNULL(alias, '')
);

-- 卡片看板（权威存储；任务 = 卡片的一种 kind）
CREATE TABLE IF NOT EXISTS cards (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  board          TEXT    NOT NULL DEFAULT 'default',
  kind           TEXT    NOT NULL DEFAULT 'task',
  title          TEXT    NOT NULL,
  body           TEXT,
  status         TEXT    NOT NULL DEFAULT 'triage',
  assignee       TEXT,
  lane           TEXT,
  priority       INTEGER NOT NULL DEFAULT 0,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  claim_lock     TEXT,
  lease_expires_at TEXT,
  heartbeat_at   TEXT,
  workspace      TEXT,
  workspace_kind TEXT    DEFAULT 'scratch',
  ref_kind       TEXT,
  ref_id         INTEGER,
  meta           TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_board_status ON cards(board, status);
CREATE INDEX IF NOT EXISTS idx_cards_assignee     ON cards(assignee);
CREATE INDEX IF NOT EXISTS idx_cards_lease        ON cards(lease_expires_at);

-- ★ H1（R4 裁决）：废弃独立 card_links 表 —— 卡片互链统一写入 links（src_kind='card'），
--   单一存储单一写路径；"强制 card 类型"约束改由 /api/cards/:id/links 应用层校验。
-- ★ H2（R4 裁决）：working 记忆独立成表（随会话生命周期建立/销毁），不进 memories ——
--   否则 working 行只做软衰减、永远留在库里，会话结束即变僵尸。
CREATE TABLE IF NOT EXISTS working_memory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,                -- 注入隔离的唯一键
  key         TEXT,                            -- 会话内逻辑键（upsert 用，如 "tool:last_result"）
  kind        TEXT    NOT NULL DEFAULT 'note', -- note / tool_result / task_state / context
  content     TEXT    NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT,
  UNIQUE(session_id, key)
);
CREATE INDEX IF NOT EXISTS idx_working_session ON working_memory(session_id);

CREATE TABLE IF NOT EXISTS card_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id     INTEGER NOT NULL,
  actor       TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_card_events_card ON card_events(card_id);

CREATE TABLE IF NOT EXISTS card_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id      INTEGER NOT NULL,
  author       TEXT    NOT NULL,
  body         TEXT    NOT NULL,
  ref_card_ids TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_card_comments_card ON card_comments(card_id);

CREATE TABLE IF NOT EXISTS card_memory (
  card_id    INTEGER NOT NULL,
  memory_id  INTEGER NOT NULL,
  relation   TEXT    NOT NULL DEFAULT 'context',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (card_id, memory_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_card_memory_mem ON card_memory(memory_id);

-- ★ R4-1（第四轮评审）：长期治理保留策略归档目标表（只归档不删除，对齐 v1.1 纪律）
CREATE TABLE IF NOT EXISTS card_events_archive (
  id          INTEGER PRIMARY KEY,
  card_id     INTEGER NOT NULL,
  actor       TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_events_archive_ts ON card_events_archive(created_at);

CREATE TABLE IF NOT EXISTS memory_usage_archive (
  id           INTEGER PRIMARY KEY,
  memory_id    INTEGER NOT NULL,
  event        TEXT    NOT NULL,
  reader_agent TEXT,
  writer_agent TEXT,
  project      TEXT NOT NULL DEFAULT 'global',
  session_id   TEXT,
  task_hint    TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_archive_ts ON memory_usage_archive(created_at);

-- ★ P0 执行面：工具调用审计（append-only）。任何执行类工具的每次调用都留痕，
--   审批结论（auto / preauth / gate-allowed / gate-denied / off）在此可查 —— B1 的审计证据链。
--   纪律：args_digest / detail 由调用方截断后写入，**绝不写入凭据或大文本全文**（大输出走 artifact 文件）。
CREATE TABLE IF NOT EXISTS exec_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool        TEXT    NOT NULL,                   -- file_read / file_write / exec_run ...
  agent       TEXT    NOT NULL DEFAULT 'unknown',
  risk        TEXT    NOT NULL DEFAULT '',        -- L0..L4
  approval    TEXT    NOT NULL DEFAULT 'auto',    -- auto / preauth / gate-allowed / gate-denied / off
  args_digest TEXT,                               -- 参数摘要（已截断）
  detail      TEXT,                               -- 结果/错误摘要（已截断）
  duration_ms INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_exec_audit_agent_ts ON exec_audit(agent, created_at);
CREATE INDEX IF NOT EXISTS idx_exec_audit_tool_ts  ON exec_audit(tool, created_at);

/* ── ★ P2-5（E-1 / MACP 资源锁）：跨 agent 互斥资源占用 ─────────────────────
 * 目的：让「同一份资源同一时刻只有一个写者」由**数据库**保证，而非靠 agent 自觉。
 * 关键设计：idx_resource_locks_active 是**部分唯一索引**（仅约束 released_at IS NULL 的行）
 *   ⇒ 同一 resource 同时最多存在一把活跃锁；重复获取会被 SQLite 直接拒绝（而不是"约定上不该"）。
 * 租约语义（与 P2-6 的 heartbeat/release 配套）：
 *   expires_at 到期即视为可被接管（接管方写新行 + 旧行补 released_at，fencing_token 递增）；
 *   因此**过期的锁不会永久阻塞**，但会留下可追溯的历史行。 */
CREATE TABLE IF NOT EXISTS resource_locks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  resource      TEXT    NOT NULL,                 -- 资源标识，如 file:<abs> / port:8787 / db:memory
  holder        TEXT    NOT NULL,                 -- 持有者 agent
  session_id    TEXT,
  purpose       TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,       -- 同一 resource 的获取序号（接管时递增，用于拒过期写）
  acquired_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  heartbeat_at  TEXT,
  expires_at    TEXT    NOT NULL,                 -- 租约到期时间
  released_at   TEXT,                             -- 显式释放时间（NULL = 活跃）
  meta          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_locks_active ON resource_locks(resource) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_resource_locks_holder ON resource_locks(holder, released_at);
CREATE INDEX IF NOT EXISTS idx_resource_locks_expiry ON resource_locks(expires_at) WHERE released_at IS NULL;
`;
/** 读配置（KEY 不存在返回默认值，JSON 解析失败也返回默认值） */
export function readConfig(db, key, def) {
    const row = db
        .prepare(`SELECT value FROM config WHERE key = ?`)
        .get(key);
    if (!row)
        return def;
    try {
        return JSON.parse(row.value);
    }
    catch {
        return def;
    }
}
/** 写配置（UPSERT，覆盖旧值并刷新 updated_at） */
export function writeConfig(db, key, value) {
    db.prepare(`INSERT INTO config(key, value, updated_at) VALUES(?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, JSON.stringify(value));
}
/** 读全部采集水位（path → {size, mtime_ms}），用于增量跳过未变文件 */
export function getIngestStates(db) {
    const rows = db.prepare(`SELECT path, size, mtime_ms FROM ingest_state`).all();
    const m = new Map();
    for (const r of rows)
        m.set(r.path, { size: r.size, mtime_ms: r.mtime_ms });
    return m;
}
/** 写单个源文件的采集水位（UPSERT） */
export function setIngestState(db, path, size, mtime_ms) {
    db.prepare(`INSERT INTO ingest_state(path, size, mtime_ms, last_at) VALUES(?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, last_at = excluded.last_at`).run(path, size, mtime_ms);
}
/* ── P1-5 / T14：查询可观测性（进程内，零依赖，不改任何语义）──────────────
 *  背景：全仓无慢查询日志、无耗时分位、无锁等待统计；性能退化只能靠人工 EXPLAIN
 *  发现（历史 B 系列瓶颈全部靠实测）。本模块补最小可观测面。
 *  ① 执行耗时采样：包装 db.prepare() 返回语句的 all/get/run，单次耗时写入定长
 *     环形缓冲（默认 500 条）→ 供 p50/p95/max；≥50ms 额外记入慢查询环（默认 200 条）。
 *  ② busy 重试计数：withTx 在 busy_timeout 溢出后的自动重试次数（锁竞争真实水位）。
 *  安装点：openDb() 内自动安装 → 调用方（server/dashboard/daemon/smoke）零改动。
 *  开销：每次执行 +2 次 hrtime 调用 +1 次数组写；无字符串拼接、无 I/O。
 *  关闭：MEMORYOS_QT_OFF=1。 */
const _QT_OFF = process.env.MEMORYOS_QT_OFF === "1";
const _QT = { total: 0, slow: 0, busyRetry: 0, slowMs: 50, durMax: 500, ringMax: 200, n: 0, idx: 0, durs: null, slowRing: [] };
const _QT_EXEC_METHODS = new Set(["all", "get", "run"]);

/** 安装查询计时采样（幂等；已安装则直接返回）。opts: {slowMs, ringMax, durMax} */
export function installQueryTiming(db, opts = {}) {
    if (!db || db.__qtInstalled || _QT_OFF)
        return db;
    if (Number(opts.slowMs) > 0)
        _QT.slowMs = Number(opts.slowMs);
    if (Number(opts.ringMax) > 0)
        _QT.ringMax = Number(opts.ringMax);
    if (Number(opts.durMax) > 0)
        _QT.durMax = Number(opts.durMax);
    _QT.durs = new Float64Array(_QT.durMax);
    const orig = db.prepare.bind(db);
    db.prepare = (sql) => {
        const stmt = orig(sql);
        return new Proxy(stmt, {
            get(target, prop, recv) {
                const v = Reflect.get(target, prop, recv);
                if (typeof v !== "function")
                    return v;
                if (!_QT_EXEC_METHODS.has(prop))
                    return v.bind(target); // 其余方法（columns/sourceSQL 等）原样透传
                return (...args) => {
                    const t0 = process.hrtime.bigint();
                    try {
                        return v.apply(target, args);
                    }
                    finally {
                        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
                        _QT.total++;
                        _QT.durs[_QT.idx] = ms;
                        _QT.idx = (_QT.idx + 1) % _QT.durMax;
                        if (_QT.n < _QT.durMax)
                            _QT.n++;
                        if (ms >= _QT.slowMs) {
                            _QT.slow++;
                            _QT.slowRing.push({ ms: Number(ms.toFixed(1)), sql: String(sql).replace(/\s+/g, " ").trim().slice(0, 160), at: new Date().toISOString() });
                            if (_QT.slowRing.length > _QT.ringMax)
                                _QT.slowRing.shift();
                        }
                    }
                };
            },
        });
    };
    db.__qtInstalled = true;
    return db;
}
/** busy_timeout 溢出后的自动重试计数（由 withTx 调用） */
export function noteBusyRetry() {
    _QT.busyRetry++;
}
/** 查询耗时快照：p50/p95/max + 慢查询 Top10 + 锁重试次数 */
export function queryStats() {
    const d = _QT.durs ? Array.from(_QT.durs.slice(0, _QT.n)).sort((a, b) => a - b) : [];
    const pick = (p) => (d.length ? Number(d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1)) : null);
    return {
        enabled: !_QT_OFF,
        total: _QT.total,
        slow: _QT.slow,
        sampled: d.length,
        slowMs: _QT.slowMs,
        busyRetry: _QT.busyRetry,
        p50: pick(0.5),
        p95: pick(0.95),
        max: d.length ? Number(d[d.length - 1].toFixed(1)) : null,
        slowTop: _QT.slowRing.slice(-10).reverse(),
    };
}
export function openDb(dbPath) {
    const db = new DatabaseSync(dbPath);
    installQueryTiming(db); // ★ P1-5：先装采样，后续所有 prepare 都被覆盖
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    // ★ P1-1.2 PRAGMA 调优（不改语义，只调性能；均为跨版本安全的选项）
    //   synchronous=NORMAL：WAL 下兼顾安全与吞吐 —— 默认 FULL 每次提交都 fsync，
    //     而 WAL 模式下 NORMAL 只在 checkpoint 时 fsync，崩溃最多丢失最后一个事务（可接受）。
    //   cache_size=-64000：64MB 页缓存（负值表示 KB），减少直接读 I/O。
    //   mmap_size=256MB：内存映射读，避免 read() 系统调用。
    //   temp_store=MEMORY：排序/临时表走内存（gram 回填、报表聚合等受益）。
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA cache_size = -64000");
    db.exec("PRAGMA mmap_size = 268435456");
    db.exec("PRAGMA temp_store = MEMORY");
    db.exec(SCHEMA);
    // 迁移：旧库缺 v0.2 列则补
    const cols = db.prepare(`PRAGMA table_info(memories)`).all().map((c) => c.name);
    const add = [
        ["status", "TEXT NOT NULL DEFAULT 'active'"],
        ["confidence", "REAL NOT NULL DEFAULT 0.8"],
        ["hit_count", "INTEGER NOT NULL DEFAULT 0"],
        ["last_hit_at", "TEXT"],
        ["embedding", "BLOB"],
        // v0.3 增量
        ["eff_confidence", "REAL"],
        ["conflict_with", "INTEGER"],
        ["superseded_by", "INTEGER"],
        ["derived_from", "INTEGER"],
        // P1-2.4 增量
        ["embedding_stale", "INTEGER NOT NULL DEFAULT 0"],
        // ★ v0.4 记忆类别（10 sector）+ 时态/情感/溯源
        ["sector", "TEXT NOT NULL DEFAULT 'episodic'"],
        ["form", "TEXT NOT NULL DEFAULT 'textual'"],
        ["salience", "REAL NOT NULL DEFAULT 1.0"],
        ["decay_lambda", "REAL"],
        ["last_seen_at", "TEXT"],
        ["valid_from", "TEXT"],
        ["valid_until", "TEXT"],
        ["trigger_cond", "TEXT"],
        ["trigger_kind", "TEXT NOT NULL DEFAULT 'pattern'"], // H6: cron | pattern | llm
        ["trigger_action", "TEXT"],
        ["valence", "REAL"],
        ["arousal", "REAL"],
        ["source_ref", "TEXT"],
        ["sensitivity", "TEXT NOT NULL DEFAULT 'normal'"],
        ["pinned", "INTEGER NOT NULL DEFAULT 0"],
        // ★ P2-5（E-1 / MACP 强一致字段）：多 agent 并发下的「过期写 / 重复写 / 因果乱序」治理基础。
        //   version/fencing_token/epoch 由 P2-6 的生命周期工具维护；idempotency_key 供重试去重；
        //   causal_parent 记录因果前驱（同一结论的修订链）。均为附加列 → 老库可读、旧 dist 不受影响。
        ["version", "INTEGER NOT NULL DEFAULT 1"],
        ["fencing_token", "INTEGER NOT NULL DEFAULT 0"],
        ["epoch", "TEXT"],
        ["idempotency_key", "TEXT"],
        ["causal_parent", "INTEGER"],
    ];
    for (const [name, def] of add) {
        if (!cols.includes(name))
            db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${def}`);
    }
    // ★ P2-5（E-1）：cards 表同样补强一致字段（与 memories 同名同义，便于双层对账）
    const cardCols = db.prepare(`PRAGMA table_info(cards)`).all().map((c) => c.name);
    const addCards = [
        ["version", "INTEGER NOT NULL DEFAULT 1"],
        ["fencing_token", "INTEGER NOT NULL DEFAULT 0"],
        ["epoch", "TEXT"],
        ["idempotency_key", "TEXT"],
        ["causal_parent", "INTEGER"],
    ];
    if (cardCols.length) {
        for (const [name, def] of addCards) {
            if (!cardCols.includes(name))
                db.exec(`ALTER TABLE cards ADD COLUMN ${name} ${def}`);
        }
    }
    // 幂等键唯一化：**部分唯一索引**（NULL 不受约束，故存量行与"不带幂等键"的写入都不受影响）
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_idem ON memories(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_memories_fencing ON memories(epoch, fencing_token);
  `);
    if (cardCols.length) {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_idem ON cards(idempotency_key) WHERE idempotency_key IS NOT NULL;`);
    }
    // ★ M12（R4 裁决）：老库 links 表补 vault_root 列（多 vault 隔离域）。SCHEMA 的 CREATE IF NOT EXISTS 只对新库生效。
    const linkCols = db.prepare(`PRAGMA table_info(links)`).all().map((c) => c.name);
    if (linkCols.length && !linkCols.includes("vault_root")) {
        db.exec(`ALTER TABLE links ADD COLUMN vault_root TEXT`);
    }
    // ★ P2：老库 idx_links_uniq 缺 alias 列 → 重建（否则 [[b]] 与 [[b|别名]] 被误去重）。索引是可重建派生结构，幂等。
    const uniqDef = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_links_uniq'`).get();
    if (uniqDef && !/alias/i.test(uniqDef.sql)) {
        db.exec(`DROP INDEX IF EXISTS idx_links_uniq`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_links_uniq ON links(
         src_kind, src_id, kind, IFNULL(dst_id, -1), IFNULL(dst_title, ''), IFNULL(anchor, ''), IFNULL(alias, '')
       )`);
    }
    // ★ v0.4 索引：必须在加列之后建（见 SCHEMA 内注释）；idx_memories_last_seen 供 H5 hit 批量刷盘用
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_sector ON memories(sector, status);
    CREATE INDEX IF NOT EXISTS idx_memories_valid  ON memories(valid_until);
    CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);
    CREATE INDEX IF NOT EXISTS idx_memories_last_seen ON memories(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_memories_stale  ON memories(embedding_stale);
    CREATE INDEX IF NOT EXISTS idx_daemon_log_ts   ON daemon_log(created_at);
  `);
    // fts 补齐
    db.exec(`
    INSERT INTO memories_fts(rowid, content, project)
    SELECT id, content, project FROM memories m
    WHERE NOT EXISTS (SELECT 1 FROM memories_fts f WHERE f.rowid = m.id);
  `);
    // ★ P0-3.4 gram 回填：为「尚无 gram 记录」的记忆补齐 CJK 2-gram 索引（首次升级 / 历史数据）。
    // 无 CJK 的正文会写入空串哨兵，因此该判定不会对纯英文/代码类记忆反复触发。
    try {
        const missing = db
            .prepare(`SELECT id, content FROM memories m
         WHERE NOT EXISTS (SELECT 1 FROM memories_gram g WHERE g.memory_id = m.id)`)
            .all();
        if (missing.length) {
            const ins = db.prepare(`INSERT INTO memories_gram(gram, memory_id) VALUES (?, ?)`);
            // 必须包事务：实测 899 条记忆产生 8.2 万条 gram，逐条自动提交会让启动阻塞 35 秒；
            // 单个事务下同样的工作量降到秒级（每条 INSERT 一次 fsync → 只 fsync 一次）。
            db.exec("BEGIN");
            try {
                for (const m of missing) {
                    const grams = gramTokens(m.content);
                    if (grams.length === 0)
                        ins.run("", m.id); // 哨兵：避免每次启动重复回填纯英文/代码类记忆
                    else
                        for (const g of grams)
                            ins.run(g, m.id);
                }
                db.exec("COMMIT");
            }
            catch (e) {
                db.exec("ROLLBACK");
                throw e;
            }
            console.error(`[db] gram 回填完成: ${missing.length} 条记忆`);
        }
    }
    catch (e) {
        console.error(`[db] gram 回填失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ★ P1-2.2 向量表迁移（幂等、单事务、以 config 标记防重复）
    migrateVectorsSplit(db);
    // ★ v0.4 记忆类别迁移（幂等；按旧 type 回填 sector + λ）
    try {
        migrateSectors(db);
    }
    catch (e) {
        console.error(`[db] 记忆类别迁移失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // ★ P0-5.1 启动自检：打印「实际库路径 + 记忆条数 + project 数」。
    // 本项目曾并存三处 memory.db（手动版 / 桌面内嵌版 / %APPDATA% 版），
    // 配错路径时工具只回一句"暂无相关记忆"，从外部完全无法区分「空库」与「连错库」——
    // 本次故障排查即耗费大量往返。写 stderr：stdout 是 MCP stdio 协议通道，不可污染。
    try {
        const one = (sql) => db.prepare(sql).get().c;
        const total = one(`SELECT COUNT(*) AS c FROM memories`);
        const active = one(`SELECT COUNT(*) AS c FROM memories WHERE status='active'`);
        const projects = one(`SELECT COUNT(DISTINCT project) AS c FROM memories`);
        const grams = one(`SELECT COUNT(*) AS c FROM memories_gram`);
        console.error(`[db] ${dbPath} | memories=${total} active=${active} projects=${projects} grams=${grams}`);
    }
    catch (e) {
        console.error(`[db] ${dbPath} | 自检失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    return db;
}
/**
 * ★ P1-1.2 WAL 检查点。
 *
 * 背景：WAL 只增不减 —— 实测 data/memory.db-wal 曾达 28MB（与 53MB 主库同量级）。
 * 后果：① 每次读都要先合并 WAL，性能随其增长而衰减；② 异常退出后恢复时间变长。
 *
 * TRUNCATE 会把已提交页合并回主库并**截断** WAL 文件；若此时有其他连接在读，
 * SQLite 会返回 busy 而只做部分合并 —— 故不视为失败，下轮再试即可。
 *
 * @returns 是否成功（busy=0 视为成功）与详情，便于 daemon 记日志
 */
export function checkpointWal(db, mode = "TRUNCATE") {
    try {
        const row = db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
        const busy = Number(row?.busy ?? 0);
        return {
            ok: busy === 0,
            busy,
            detail: `mode=${mode} busy=${busy} log=${row?.log ?? "?"} checkpointed=${row?.checkpointed ?? "?"}`,
        };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[db] wal_checkpoint(${mode}) 失败: ${msg}`);
        return { ok: false, busy: -1, detail: `mode=${mode} error=${msg}` };
    }
}
/** WAL 文件当前大小（字节）；文件不存在返回 0。用于监控与验收。 */
export function walSizeBytes(dbPath) {
    try {
        return fs.statSync(`${dbPath}-wal`).size;
    }
    catch {
        return 0;
    }
}
/* ---------- ★ P1-2.2 向量读写封装（vector 已独立成表，所有路径必须经此访问） ---------- */
/** 写入/替换某条记忆的向量（幂等 upsert）。vec=null 时删除该行。 */
export function upsertVector(db, memoryId, vec) {
    if (!vec) {
        db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(memoryId);
        return;
    }
    db.prepare(`INSERT INTO memory_vectors(memory_id, embedding) VALUES (?, ?)
     ON CONFLICT(memory_id) DO UPDATE SET embedding = excluded.embedding`).run(memoryId, vecToBuf(vec));
}
/** 读取单条记忆的向量；不存在返回 null。 */
export function readVector(db, memoryId) {
    const r = db.prepare(`SELECT embedding FROM memory_vectors WHERE memory_id = ?`).get(memoryId);
    return r ? bufToVec(r.embedding) : null;
}
/** 删除某条记忆的向量（记忆被物理删除时调用）。 */
export function deleteVector(db, memoryId) {
    db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(memoryId);
}
/**
 * ★ P1-2.2 迁移：把 memories.embedding 搬入 memory_vectors，并置空旧列以真正瘦身。
 *
 * 安全性设计：
 *   ① 全程单事务 —— 任一步失败即回滚，不会出现"搬了一半"；
 *   ② 先复制、后置空 —— 置 NULL 之前数据已确认在新表中（INSERT OR IGNORE 幂等）；
 *   ③ config 标记防重复 —— 迁移只跑一次，后续启动零成本；
 *   ④ 保留 memories.embedding 列 —— 结构向后兼容，老代码若遗漏改动会被 NULL 暴露而非静默读错。
 */
const VECTOR_MIGRATION_KEY = "migration.vectors_split_v1";
function migrateVectorsSplit(db) {
    if (readConfig(db, VECTOR_MIGRATION_KEY, false) === true)
        return;
    const legacy = db.prepare(`SELECT COUNT(*) c FROM memories WHERE embedding IS NOT NULL`).get().c;
    db.exec("BEGIN");
    try {
        db.exec(`
      INSERT OR IGNORE INTO memory_vectors(memory_id, embedding)
      SELECT id, embedding FROM memories WHERE embedding IS NOT NULL;
    `);
        db.exec(`UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL;`);
        writeConfig(db, VECTOR_MIGRATION_KEY, true);
        db.exec("COMMIT");
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
    if (legacy)
        console.error(`[db] 向量表迁移完成: ${legacy} 条向量移入 memory_vectors（memory 表已瘦身）`);
}
/* ---------- ★ v0.4 记忆类别（10 sector） ---------- */
/**
 * 记忆类别定义。来源：OpenMemory HMD 认知分层 + 本需求 8 类清单 + 调研补充 2 类。
 *   λ = 衰退率（越大越快被遗忘，daemon 按此算 eff_confidence）
 *   w = 检索权重（越大越优先召回）
 *   form 为**正交维度**（存储形态），不参与内容分类。
 */
export const SECTORS = {
    working: { cn: "工作记忆", desc: "当前上下文、临时变量、工具返回、任务状态", lambda: 0.05, w: 0.9, legacy: [] },
    episodic: { cn: "情景记忆", desc: "原始对话、时间、参与者、事件链、代码行号", lambda: 0.015, w: 1.2, legacy: ["experience"] },
    semantic: { cn: "语义记忆", desc: "事实、偏好、结论、概念关系", lambda: 0.005, w: 1.0, legacy: [] },
    procedural: { cn: "程序记忆", desc: "SOP、规约、工具用法、提示词、技能", lambda: 0.008, w: 1.1, legacy: ["convention", "rule"] },
    meta: { cn: "元记忆", desc: "来源、置信度、决策理由、冲突记录、复盘（含反思）", lambda: 0.001, w: 0.8, legacy: ["decision", "pitfall"] },
    social: { cn: "社会/共享记忆", desc: "任务分派、交接、权限、共享黑板", lambda: 0.01, w: 1.0, legacy: ["task"] },
    user: { cn: "用户记忆", desc: "用户画像、偏好与历史交互信息", lambda: 0.003, w: 1.0, legacy: [] },
    prospective: { cn: "前瞻记忆", desc: "触发条件 + 行动建议 + 有效期", lambda: 0.0, w: 1.0, legacy: [] },
    affective: { cn: "情感记忆", desc: "情绪极性/强度、挫败点、偏好强度", lambda: 0.02, w: 1.3, legacy: [] },
};
export const SECTOR_KEYS = Object.keys(SECTORS);
/** 存储形态（正交维度） */
export const FORMS = ["textual", "graph", "vector"];
/** 旧 type → 新 sector 的映射（迁移回填用；反向取 legacy 数组） */
export const TYPE_TO_SECTOR = (() => {
    const m = {};
    for (const [sector, def] of Object.entries(SECTORS))
        for (const t of def.legacy)
            m[t] = sector;
    return m;
})();
/** 取某类的默认 λ（无定义时给一个中性值，避免 0 导致永不衰减） */
export function sectorLambda(sector) {
    return SECTORS[sector ?? ""]?.lambda ?? 0.01;
}
/** 归一化 sector 值：非法/空 → 由 type 推导 → 兜底 episodic */
export function normalizeSector(sector, type) {
    const s = String(sector ?? "").trim().toLowerCase();
    if (SECTOR_KEYS.includes(s))
        return s;
    const t = String(type ?? "").trim().toLowerCase();
    return TYPE_TO_SECTOR[t] ?? "episodic";
}
const SECTOR_MIGRATION_KEY = "migration.sectors_v1";
/**
 * 记忆类别迁移（幂等、单事务、以 config 标记防重复）。
 * 只做两件事：① 按旧 type 回填 sector ② 写入 λ 默认值。
 * 不触碰 content / embedding / FTS / 向量表 —— 故旧代码仍可正常读取。
 */
export function migrateSectors(db) {
    if (readConfig(db, SECTOR_MIGRATION_KEY, false) === true)
        return;
    const rows = db
        .prepare(`SELECT id, type, sector FROM memories`)
        .all();
    db.exec("BEGIN");
    try {
        const upd = db.prepare(`UPDATE memories SET sector = ?, decay_lambda = COALESCE(decay_lambda, ?) WHERE id = ?`);
        let n = 0;
        for (const r of rows) {
            const target = normalizeSector(r.sector, r.type);
            // 默认值 'episodic' 视为「未回填」：仅当 sector 缺省或与 type 映射不符时改写
            const mapped = TYPE_TO_SECTOR[String(r.type ?? "").toLowerCase()];
            if (!r.sector || (mapped && r.sector === "episodic" && mapped !== "episodic")) {
                upd.run(target, sectorLambda(target), r.id);
                n++;
            }
        }
        writeConfig(db, SECTOR_MIGRATION_KEY, true);
        // M11（R4 裁决）：迁移完成即标记旧 type 列 deprecated —— 读层只用 sector，写层 type 参数仅映射后丢弃。
        //   前端旧筛选进入「兼容模式」折叠；不物理删列（旧代码仍可读，回退安全）。
        writeConfig(db, "type.deprecated", 1);
        db.exec("COMMIT");
        if (n)
            console.error(`[db] 记忆类别迁移完成: ${n} 条记忆回填 sector`);
    }
    catch (e) {
        db.exec("ROLLBACK");
        throw e;
    }
}
/** upsert 一条会话内 working 记忆（key 为会话内逻辑键，同 key 覆盖） */
export function setWorkingMemory(db, sessionId, key, content, kind = "note") {
    db.prepare(`INSERT INTO working_memory(session_id, key, kind, content, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(session_id, key)
     DO UPDATE SET kind = excluded.kind, content = excluded.content, updated_at = excluded.updated_at`).run(sessionId, key, kind, content);
}
/** 取某会话的 working 记忆（key 缺省 = 全量；按 updated_at 倒序，注入取前 N 条用） */
export function listWorkingMemory(db, sessionId, key) {
    const rows = key
        ? db
            .prepare(`SELECT * FROM working_memory WHERE session_id = ? AND key = ?`)
            .all(sessionId, key)
        : db
            .prepare(`SELECT * FROM working_memory WHERE session_id = ? ORDER BY updated_at DESC`)
            .all(sessionId);
    return rows.map((r) => ({
        id: Number(r.id),
        session_id: r.session_id,
        key: r.key,
        kind: r.kind,
        content: r.content,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }));
}
/** 删除某会话的 working 记忆（key 缺省 = 清空该会话；会话结束 / daemon 清理用） */
export function clearWorkingMemory(db, sessionId, key) {
    const info = key
        ? db.prepare(`DELETE FROM working_memory WHERE session_id = ? AND key = ?`).run(sessionId, key)
        : db.prepare(`DELETE FROM working_memory WHERE session_id = ?`).run(sessionId);
    return Number(info.changes);
}
/**
 * ★ P1-1.1 数据库备份（VACUUM INTO）。
 *
 * 为什么**不能**直接 copy 文件：
 *   WAL 模式下 .db 主文件并不含最新已提交事务（它们还在 -wal 里），直接复制 .db
 *   会得到一个**缺失最新数据、甚至页不一致**的备份 —— 这正是「备份了但备份是坏的」。
 *   VACUUM INTO 是 SQLite 官方在线备份机制：在事务一致点上产出单个自包含、已整理
 *   （无碎片）的库文件，且不阻塞其他连接。
 *
 * 幂等设计：daemon 每小时跑一轮，但备份是「每日一次」——以「当日目标文件已存在」
 * 作为判据跳过，无需额外状态表；跨天自然产生新文件。
 *
 * @param keep 保留最近 N 份（按文件名日期排序），超出的最旧文件被删除
 */
export function backupDb(db, dbPath, opts = {}) {
    const dir = opts.dir ?? path.join(path.dirname(dbPath), "backup");
    const keep = opts.keep ?? 7;
    const now = opts.now ?? new Date();
    const stamp = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const target = path.join(dir, `memory-${stamp}.db`);
    fs.mkdirSync(dir, { recursive: true });
    // 今日已备份 → 跳过（幂等；daemon 每小时一轮但只需每日一份）
    if (fs.existsSync(target)) {
        return { created: null, removed: [], note: `今日已备份（${path.basename(target)}）` };
    }
    // VACUUM INTO 要求目标文件不存在；路径中的单引号需转义
    const escaped = target.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    // 滚动删除：只保留最近 keep 份
    const removed = [];
    try {
        const all = fs
            .readdirSync(dir)
            .filter((f) => /^memory-\d{4}-\d{2}-\d{2}\.db$/.test(f))
            .sort(); // 文件名含 ISO 日期 → 字典序即时间序
        const excess = all.slice(0, Math.max(0, all.length - keep));
        for (const f of excess) {
            try {
                fs.unlinkSync(path.join(dir, f));
                removed.push(f);
            }
            catch {
                /* 删除失败不阻断备份主流程 */
            }
        }
    }
    catch {
        /* 目录列举失败不影响已完成的备份 */
    }
    const sizeMB = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
    return {
        created: target,
        removed,
        note: `已备份 ${path.basename(target)}（${sizeMB}MB）${removed.length ? `，清理 ${removed.length} 份旧备份` : ""}`,
    };
}
export function rowOf(r) {
    return {
        id: Number(r.id),
        content: r.content,
        type: r.type,
        agent: r.agent,
        agent_fpath: r.agent_fpath,
        project: r.project,
        status: r.status,
        confidence: Number(r.confidence),
        eff_confidence: r.eff_confidence == null ? null : Number(r.eff_confidence),
        conflict_with: r.conflict_with == null ? null : Number(r.conflict_with),
        superseded_by: r.superseded_by == null ? null : Number(r.superseded_by),
        derived_from: r.derived_from == null ? null : Number(r.derived_from),
        hit_count: Number(r.hit_count),
        last_hit_at: r.last_hit_at,
        created_at: r.created_at,
        // ★ v0.4 记忆类别（10 sector）+ 时态/情感/溯源（R4 修订补 trigger_kind）
        sector: String(r.sector ?? "episodic"),
        form: String(r.form ?? "textual"),
        salience: r.salience == null ? 1.0 : Number(r.salience),
        decay_lambda: r.decay_lambda == null ? null : Number(r.decay_lambda),
        last_seen_at: r.last_seen_at ?? null,
        valid_from: r.valid_from ?? null,
        valid_until: r.valid_until ?? null,
        trigger_cond: r.trigger_cond ?? null,
        trigger_kind: String(r.trigger_kind ?? "pattern"),
        trigger_action: r.trigger_action ?? null,
        valence: r.valence == null ? null : Number(r.valence),
        arousal: r.arousal == null ? null : Number(r.arousal),
        source_ref: r.source_ref ?? null,
        sensitivity: String(r.sensitivity ?? "normal"),
        pinned: Number(r.pinned ?? 0),
        // ★ P2-5（E-1）：MACP 字段（未迁移的老库读到 undefined → 此处给安全默认值）
        version: Number(r.version ?? 1),
        fencing_token: Number(r.fencing_token ?? 0),
        epoch: r.epoch ?? null,
        idempotency_key: r.idempotency_key ?? null,
        causal_parent: r.causal_parent == null ? null : Number(r.causal_parent),
    };
}
/**
 * 内容归一化：Windows 笔记常带 \r\n，统一转 \n 入库，保证内容 hash 稳定
 * （否则 LF/CRLF 两版本判为"不同内容"，去重失效）。
 * ★ P0-3.2：原 updateMemory 只 trim 不归一化 → 「写入后编辑」会让同一内容 hash 变化、去重失效。
 * 抽成单一真源供写入与编辑共用。
 */
function normalizeContent(s) {
    return s.replace(/\r\n?/g, "\n");
}
export function writeMemory(db, args) {
    args.content = normalizeContent(args.content);
    const status = args.status ?? "active";
    // ★ v0.4：sector 缺省时由 type 推导；λ 缺省取类默认（daemon 按此衰减）
    const sector = normalizeSector(args.sector, args.type);
    const lambda = args.decay_lambda ?? sectorLambda(sector);
    // ★ P1-2.2：向量不再写 memories 表，改由 upsertVector 写入独立的 memory_vectors。
    const info = db
        .prepare(`INSERT INTO memories(
         content,type,agent,agent_fpath,project,confidence,status,
         sector,form,salience,decay_lambda,valid_from,valid_until,
         trigger_cond,trigger_kind,trigger_action,valence,arousal,source_ref,sensitivity,pinned,
         epoch,idempotency_key,causal_parent
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(args.content, args.type, args.agent, args.agent_fpath, args.project, args.confidence ?? 0.8, status, sector, String(args.form ?? "textual"), args.salience ?? 1.0, lambda, args.valid_from ?? null, args.valid_until ?? null, args.trigger_cond ?? null, String(args.trigger_kind ?? "pattern"), args.trigger_action ?? null, args.valence ?? null, args.arousal ?? null, args.source_ref ?? null, String(args.sensitivity ?? "normal"), args.pinned ?? 0,
            // ★ P2-5（E-1）：MACP 可写字段。version/fencing_token 走 DDL 默认值（1/0），只在接管/修订时由工具递增，
            //   故此处不接受外部传值，避免调用方伪造版本号破坏单调性。
            args.epoch ?? null, args.idempotency_key ?? null, args.causal_parent ?? null);
    const newId = Number(info.lastInsertRowid);
    try {
        if (args.embedding)
            upsertVector(db, newId, args.embedding); // P1-2.2：向量入独立表
        syncGrams(db, newId, args.content); // P0-3.4：维护 CJK 2-gram 索引
        invalidateVectorCache(db); // P0-4.1：新记忆进入候选池
    }
    catch (e) {
        // 回滚：删除刚写的记忆，保持原子性
        db.prepare(`DELETE FROM memories WHERE id = ?`).run(newId);
        throw e;
    }
    return readMemory(db, newId);
}
export function updateMemory(db, id, args) {
    if (!readMemory(db, id))
        return null;
    const content = args.content != null ? normalizeContent(args.content).trim() : null;
    if (content !== null && !content)
        throw new Error("content 不能为空");
    if (content !== null) {
        // ★ P1-2.4：正文变更 → 向量失效。置 embedding_stale=1，由 daemon 异步重算
        //   （此处不重算：updateMemory 是同步 API，而嵌入计算是异步且耗时的）。
        db.prepare(`UPDATE memories SET content=?, embedding_stale=1 WHERE id=?`).run(content, id);
        // P0-3.1：FTS 同步现已由 trg_memories_au 触发器保证；此处保留为幂等兜底
        // （对触发器创建之前就已存在的旧库仍然有效，重复写入同值无副作用）。
        db.prepare(`UPDATE memories_fts SET content=? WHERE rowid=?`).run(content, id);
    }
    if (args.type)
        db.prepare(`UPDATE memories SET type=? WHERE id=?`).run(args.type, id);
    if (args.sector !== undefined)
        db.prepare(`UPDATE memories SET sector=? WHERE id=?`).run(args.sector || null, id);
    if (content !== null)
        syncGrams(db, id, content); // P0-3.4：正文已改，重建 CJK 2-gram
    invalidateVectorCache(db); // P0-4.1：正文已变（注：向量未重算，见上方 v0.3 约定）
    return readMemory(db, id);
}
/** 合并去重：对命中的已有记忆 confidence+0.1 */
export function bumpConfidence(db, id, delta = 0.1) {
    db.prepare(`UPDATE memories SET confidence = confidence + ? WHERE id = ?`).run(delta, id);
}
/**
 * 并发守卫：写事务重试封装。多客户端（MCP 多会话）同时写时，busy_timeout 只负责"等锁"，
 * 超时后仍会抛 `database is locked`——这里在锁竞争下自动重试并重开事务，避免写入方直接崩。
 * 用法：withTx(db, () => { 写操作 })；fn 抛非锁错误则吞掉后回滚并抛给上层。
 */
export function withTx(db, fn, retries = 3) {
    for (let attempt = 0;; attempt++) {
        try {
            // BEGIN IMMEDIATE：立即获取写锁，锁竞争在此即抛，便于在 BEGIN 层就能重试
            // （普通 BEGIN 是 deferred，写发生在 COMMIT 时，锁错误延后到 COMMIT 才抛——不利于 retry 对齐）
            db.exec("BEGIN IMMEDIATE");
            try {
                fn();
                db.exec("COMMIT");
            }
            catch (e) {
                db.exec("ROLLBACK");
                throw e;
            }
            return;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
            const locked = msg.includes("database is locked") || msg.includes("busy");
            if (locked && attempt < retries) {
                // 锁竞争：让出后重试（busy_timeout 已让锁释放，多试几次竞争窗口很小）
                noteBusyRetry(); // ★ P1-5：锁竞争真实水位（/api/health 可见）
                continue;
            }
            throw e;
        }
    }
}
export function readMemory(db, id) {
    const r = db.prepare(`SELECT ${BASE_COLUMNS} FROM memories WHERE id = ?`).get(id);
    return r ? rowOf(r) : null;
}
/** project 内（含 global）所有带向量记录，供语义 KNN。
 *  activeOnly=true 时仅取 status='active'（检索路径用：非 active 候选最终必被 search.js 过滤掉，
 *  提前在 SQL 收窄可显著缩小候选池，且避免无关候选挤占 topK）。去重预检请传 false（需覆盖全部状态）。 */
export function getVectorsOnProject(db, project, activeOnly = false) {
    // ★ P1-2.2：向量已独立成表 → JOIN 取代原来的 `embedding IS NOT NULL` 过滤
    //   （JOIN 天然只返回「有向量」的行），且 memories 侧不再读取 BLOB。
    const rows = db
        .prepare(`SELECT m.id, v.embedding, m.embedding_stale
       FROM memories m
       JOIN memory_vectors v ON v.memory_id = m.id
       WHERE m.project IN (?, 'global')` + (activeOnly ? ` AND m.status = 'active'` : ""))
        .all(project);
    return rows.map((r) => ({
        id: Number(r.id),
        vec: bufToVec(r.embedding),
        stale: Number(r.embedding_stale) === 1,
    }));
}
/* ---------- ★ P0-4.1 向量缓存：消除"每次检索全表反序列化 embedding" ---------- */
/**
 * 检索路径每次 hybridSearch 都会拉取整个 project 的向量并逐条反序列化
 * （bge-m3 1024 维 float32 ≈ 4KB/条 → 516 条≈2MB/次，万条级≈40MB/次），
 * 而同一 project 在两次写入之间这份数据完全不变。故加进程内缓存：
 *   · 以 db 实例为键（WeakMap），多库并存互不干扰；
 *   · 写入/状态流转后 version++ 整体失效（候选池已变）；
 *   · TTL 兜底（60s），即使遗漏某个失效点也不会长期读到陈旧候选。
 * 去重预检（dedupeDecision）需要写入后的实时数据 → 仍走非缓存的 getVectorsOnProject。
 */
const VEC_CACHE_TTL_MS = 60_000;
const vecCache = new WeakMap();
function vecState(db) {
    let s = vecCache.get(db);
    if (!s) {
        s = { version: 0, byKey: new Map() };
        vecCache.set(db, s);
    }
    return s;
}
/** 任何改变「向量候选池」的写入后调用：新增记忆、编辑正文、状态流转。 */
export function invalidateVectorCache(db) {
    const s = vecState(db);
    s.version++;
}
/** 带缓存的 getVectorsOnProject —— 仅供检索路径使用。 */
export function getVectorsOnProjectCached(db, project, activeOnly = false) {
    const s = vecState(db);
    const key = `${project}\u0000${activeOnly ? 1 : 0}`;
    const hit = s.byKey.get(key);
    const now = Date.now();
    if (hit && hit.version === s.version && now - hit.at < VEC_CACHE_TTL_MS)
        return hit.vectors;
    const vectors = getVectorsOnProject(db, project, activeOnly);
    s.byKey.set(key, { version: s.version, at: now, vectors });
    return vectors;
}
const ID_CHUNK = 400; // SQLite 变量数上限保护（默认 999，留足余量）
/** 批量读（供检索回填，避免 N+1 逐条 SELECT）；返回 id→行 映射，未命中的 id 不在 Map 中 */
export function readMemoriesByIds(db, ids) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const part = ids.slice(i, i + ID_CHUNK);
        const ph = part.map(() => "?").join(",");
        const rows = db
            .prepare(`SELECT ${BASE_COLUMNS} FROM memories WHERE id IN (${ph})`)
            .all(...part);
        for (const r of rows)
            out.set(Number(r.id), rowOf(r));
    }
    return out;
}
/**
 * 写入决策：对 project 内现有向量做去重/冲突预检（M-1.3）
 * @returns insert=直接写；merge=命中高相似(≥0.92)已记录,conf信心+0.1；conflict=疑似冲突(0.85~0.92)
 */
export function dedupeDecision(existing, newVec, newId, mergeThresh = 0.92, conflictThresh = 0.85) {
    let best = { id: newId, sim: -1 };
    for (const e of existing) {
        if (e.id === newId)
            continue;
        const s = cosine(e.vec, newVec);
        if (s > best.sim)
            best = { id: e.id, sim: s };
    }
    if (best.sim >= mergeThresh)
        return { action: "merge", targetId: best.id, sim: best.sim };
    if (best.sim >= conflictThresh)
        return { action: "conflict", targetId: best.id, sim: best.sim };
    return { action: "insert", targetId: null, sim: best.sim };
}
/* ---------- ★ P0-3.4 CJK 2-gram 索引维护 ---------- */
const CJK_RE = /[\u4e00-\u9fff]/;
const GRAM_MAX_PER_DOC = 4000; // 单条正文最多建多少 gram（超长文档防写放大）
/** 抽取正文中相邻两个 CJK 字符组成的 2-gram（已去重）。非 CJK 字符会打断连续性。 */
export function gramTokens(content) {
    const out = new Set();
    let prev = "";
    for (const ch of content) {
        if (CJK_RE.test(ch)) {
            if (prev)
                out.add(prev + ch);
            prev = ch;
            if (out.size >= GRAM_MAX_PER_DOC)
                break;
        }
        else {
            prev = "";
        }
    }
    return [...out];
}
/** 取查询中「前两个连续 CJK 字符」作为索引探针；不足两个则返回 null（回退 LIKE）。 */
function cjkProbe(q) {
    const chars = [...q];
    for (let i = 0; i + 1 < chars.length; i++) {
        if (CJK_RE.test(chars[i]) && CJK_RE.test(chars[i + 1]))
            return chars[i] + chars[i + 1];
    }
    return null;
}
/** ★ P0-2.1 快速去重预检：先用 gram 粗筛候选，再 cosine 精排；降级到全量确保安全。 */
const DEDUPE_FAST_TOPK = 100; // 粗筛候选上限
/** 从内容提取 bigram 探针（同 cjkProbe 逻辑，导出供外部使用） */
export function gramProbe(content) {
    return cjkProbe(content);
}
/** 按 id 列表批量拉取 embedding（避免全表扫描）；跳过 embedding 为 null 的记录 */
export function getVectorsByIds(db, ids) {
    if (ids.length === 0)
        return [];
    const out = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        const ph = chunk.map(() => "?").join(",");
        const rows = db
            .prepare(`SELECT m.id, v.embedding, m.embedding_stale
         FROM memories m
         JOIN memory_vectors v ON v.memory_id = m.id
         WHERE m.id IN (${ph})`)
            .all(...chunk);
        for (const r of rows) {
            out.push({ id: Number(r.id), vec: bufToVec(r.embedding), stale: Number(r.embedding_stale) === 1 });
        }
    }
    return out;
}
/**
 * 快速去重预检（★ P0-2.1）。
 *
 * 设计要点（含一次正确性修正）：
 *   词法粗筛**不能**安全替代全量向量比对 —— 用词完全不同但语义高度相似的记忆
 *   （如「向量检索慢」vs「embedding 查询效率低」）cosine 可能 ≥0.9，却没有任何
 *   共同 bigram。因此粗筛只作「快路径」，一旦没能拿到 ≥conflictThresh 的结果，
 *   一律降级到全量确认，绝不因为「粗筛 0 候选」就直接判 insert。
 *
 *   兜底走 getVectorsOnProjectCached：写入后会 invalidateVectorCache，故缓存内容
 *   始终等于库内最新状态（正确性不受影响），同时避免重复读取 4KB/条的 BLOB。
 */
export function dedupeDecisionFast(db, project, newVec, newContent, mergeThresh = 0.92, conflictThresh = 0.85) {
    const probe = gramProbe(newContent);
    if (probe) {
        const candidateRows = db
            .prepare(`SELECT DISTINCT memory_id FROM memories_gram WHERE gram = ? LIMIT ?`)
            .all(probe, DEDUPE_FAST_TOPK);
        if (candidateRows.length > 0) {
            const existing = getVectorsByIds(db, candidateRows.map((r) => r.memory_id));
            if (existing.length > 0) {
                const fast = dedupeDecision(existing, newVec, -1, mergeThresh, conflictThresh);
                // 快路径成立的条件：词法候选里已存在「足够相似」的记忆。
                // 此时结果与全量一致（全量的最大值不可能小于候选子集的最大值）。
                if (fast.sim >= conflictThresh)
                    return fast;
            }
        }
    }
    // 兜底：粗筛无候选 / 候选不够相似 → 全量确认（走缓存，避免重复 BLOB IO）
    return dedupeDecision(getVectorsOnProjectCached(db, project), newVec, -1, mergeThresh, conflictThresh);
}
/** 同步单条记忆的 gram 索引（先删后插，幂等）。无 CJK 时写空串哨兵，标记「已同步」。 */
function syncGrams(db, id, content) {
    db.prepare(`DELETE FROM memories_gram WHERE memory_id = ?`).run(id);
    const grams = gramTokens(content);
    const ins = db.prepare(`INSERT INTO memories_gram(gram, memory_id) VALUES (?, ?)`);
    if (grams.length === 0) {
        ins.run("", id); // 哨兵：避免每次启动重复回填纯英文/代码类记忆
        return;
    }
    for (const g of grams)
        ins.run(g, id);
}
/** LIKE 元字符转义：查询词里的 % _ \ 应作字面量匹配，否则 "%x%" 会退化为匹配任意内容。 */
function escapeLike(q) {
    return q.replace(/[\\%_]/g, (c) => "\\" + c);
}
/* ---------- 词法路（保留 v0.1 语义，含 scope 隔离 + 短查询 LIKE 兜底） ---------- */
/** ★ H4（R4 裁决）：词法候选池第一步强制过滤 secret —— secret 不出任何非本机前端通道。所有分支 SQL 均加。 */
const LEX_SECRET = ` AND sensitivity != 'secret'`;
export function lexSearch(db, query, project, limit = 20) {
    const q = query.trim();
    let rows;
    // FTS5 trigram 对 <3 字符（尤其中文 2 字词）不产 token；中文改为走 LIKE 兜底（实证中文 LIKE 可靠、trigram 0 命中）。
    // 判定：含 CJK → LIKE；否则按长度（>=3 走 FTS trigram，英文友好）
    const HAS_CJK = /[\u4e00-\u9fff]/;
    if (!HAS_CJK.test(q) && q.length >= 3) {
        const esc = q.replace(/"/g, '""');
        rows = db
            .prepare(`SELECT m.id, m.content, m.type, m.agent, m.project, m.status, m.confidence, m.created_at
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ?
           AND m.project IN (?, 'global')
           AND m.status IN ('active','trial')${LEX_SECRET}
         ORDER BY bm25(memories_fts) LIMIT ?`)
            // FTS5 trigram：整体作短语查询（双引号包裹，内容含引号用 " 转义），不能用 [ ] 包裹（非法语法）
            .all(`"${esc}"`, project, limit);
    }
    else {
        // LIKE 元字符转义后再拼 pattern：否则查询词里的 % 会被当成通配符（"%x%" 匹配任意内容）。
        const like = `%${escapeLike(q)}%`;
        const probe = cjkProbe(q);
        if (probe) {
            // ★ P0-3.4：先用 2-gram 倒排索引把候选集收窄，再 LIKE 精筛。
            // 原实现直接 `content LIKE '%q%'` —— 前导通配符使索引完全失效，中文查询每次全表扫描。
            // bigram 命中是子串命中的必要条件，故收窄安全（不漏召回），LIKE 保证语义精确。
            rows = db
                .prepare(`SELECT id, content, type, agent, project, status, confidence, created_at
           FROM memories
           WHERE id IN (SELECT memory_id FROM memories_gram WHERE gram = ?)
             AND content LIKE ? ESCAPE '\\'
             AND project IN (?, 'global')
             AND status IN ('active','trial')${LEX_SECRET}
           ORDER BY created_at DESC LIMIT ?`)
                .all(probe, like, project, limit);
        }
        else {
            // 单个 CJK 字 / <3 字符非 CJK：没有可用的 2-gram 探针，只能回退 LIKE
            rows = db
                .prepare(`SELECT id, content, type, agent, project, status, confidence, created_at
           FROM memories WHERE content LIKE ? ESCAPE '\\' AND project IN (?, 'global')
             AND status IN ('active','trial')${LEX_SECRET}
           ORDER BY created_at DESC LIMIT ?`)
                .all(like, project, limit);
        }
    }
    return rows.map((r, i) => ({ ...rowOf(r), score: rows.length - i }));
}
/** 语义路：余弦 topN */
export function vecSearch(hitEmbed, existing, project, topN) {
    return existing
        .map((e) => ({ id: e.id, sim: cosine(hitEmbed, e.vec) }))
        .filter((x) => x.sim > 0.4)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, topN);
}
export function ftsCount(db) {
    return db.prepare(`SELECT COUNT(*) AS c FROM memories_fts`).get().c;
}
export function logUsage(db, a) {
    db.prepare(`INSERT INTO memory_usage(memory_id,event,reader_agent,writer_agent,project,session_id,task_hint)
     VALUES (?,?,?,?,?,?,?)`).run(a.memory_id, a.event, a.reader_agent, a.writer_agent, a.project, a.session_id ?? null, a.task_hint ?? null);
}
export function usageCount(db, event) {
    const r = event
        ? db.prepare(`SELECT COUNT(*) c FROM memory_usage WHERE event = ?`).get(event)
        : db.prepare(`SELECT COUNT(*) c FROM memory_usage`).get();
    return r.c;
}
/** 审计留痕（daemon/人工归档共用同一通道） */
export function logDaemon(db, t) {
    db.prepare(`INSERT INTO daemon_log(task,op,memory_id,detail,operator) VALUES (?,?,?,?,?)`).run(t.task, t.op, t.memory_id ?? null, t.detail ?? null, t.operator ?? "daemon");
}
/**
 * 执行面工具调用审计（append-only，P0 exec-audit）。
 * 调用方负责截断：argsDigest/detail 均不得写入凭据或大文本全文（大输出走 artifact 文件）。
 * 审计写入失败绝不阻断工具执行本身 —— 由调用方 try/catch 包裹。
 */
export function logExecAudit(db, r) {
    db.prepare(`INSERT INTO exec_audit(tool,agent,risk,approval,args_digest,detail,duration_ms) VALUES (?,?,?,?,?,?,?)`)
        .run(r.tool, r.agent ?? "unknown", r.risk ?? "", r.approval ?? "auto", r.argsDigest ?? null, r.detail ?? null, r.durationMs ?? null);
}
/** 读最近 N 条执行审计（看板/CLI 查证用） */
export function recentExecAudit(db, limit = 20) {
    return db.prepare(`SELECT id,tool,agent,risk,approval,args_digest,detail,duration_ms,created_at
                       FROM exec_audit ORDER BY id DESC LIMIT ?`).all(Math.max(1, Math.min(200, Number(limit) || 20)));
}
export function daemonLogCount(db, task, op) {
    const where = [];
    const args = [];
    if (task) {
        where.push("task = ?");
        args.push(task);
    }
    if (op) {
        where.push("op = ?");
        args.push(op);
    }
    const r = (where.length
        ? db.prepare(`SELECT COUNT(*) c FROM daemon_log WHERE ${where.join(" AND ")}`).get(...args)
        : db.prepare(`SELECT COUNT(*) c FROM daemon_log`).get());
    return r.c;
}
export function listEffRows(db) {
    // ★ P1-2.2：向量从独立表 JOIN（原为 memories.embedding + IS NOT NULL 过滤）
    const rows = db
        .prepare(`SELECT m.id,m.type,m.content,m.agent,m.project,m.status,m.confidence,m.eff_confidence,
              m.hit_count,m.last_hit_at,m.last_seen_at,m.created_at,
              m.sector,m.salience,m.decay_lambda,m.pinned, v.embedding
       FROM memories m
       JOIN memory_vectors v ON v.memory_id = m.id
       WHERE m.status='active'`)
        .all();
    return rows.map((r) => ({ ...rowOf(r), vec: bufToVec(r.embedding) }));
}
/** 更新有效置信（衰减/回血），并回写 eff_confidence */
export function setEff(db, id, eff) {
    db.prepare(`UPDATE memories SET eff_confidence = ? WHERE id = ?`).run(eff, id);
}
/** 归档 active 记忆（daemon 与 human 共用；留痕由调用方 logDaemon 负责） */
export function archiveMemory(db, id) {
    db.prepare(`UPDATE memories SET status='archived' WHERE id = ? AND status='active'`).run(id);
    invalidateVectorCache(db); // P0-4.1：active → archived 会缩小 activeOnly 候选池
}
/**
 * 归档（试用考核专用）：trial → archived。
 * ⚠️ 不可复用 archiveMemory —— 它带 `AND status='active'` 守卫（为 active 归档设计），
 * 对 trial 行会静默匹配 0 行：daemon_log 照记 archive、状态却没变。
 * 实测后果：533 条试用考核「归档」全部空转，trial 只增不减。
 */
export function archiveTrial(db, id) {
    db.prepare(`UPDATE memories SET status='archived' WHERE id = ? AND status='trial'`).run(id);
    invalidateVectorCache(db); // P0-4.1
}
/** 去重合并：把 loser 置 merged + superseded_by；递增算子放在 daemon 单事务内 */
export function markMerged(db, loserId, winnerId) {
    db.prepare(`UPDATE memories SET status='merged', superseded_by = ? WHERE id = ?`).run(winnerId, loserId);
    invalidateVectorCache(db); // P0-4.1：merged 不再进入检索候选
}
export { joinPrefix }; // 保留出口（格式工具，备用）
/** 写仲裁事件（before 快照 + undone 标记；撤销与审计基础） */
export function appendEvent(db, e) {
    db.prepare(`INSERT INTO memory_events(memory_id,op,payload,operator) VALUES (?,?,?,?)`).run(e.memory_id, e.op, e.payload, e.operator ?? "human:arbitrate");
}
export function pendingConflicts(db) {
    const rows = db
        .prepare(`SELECT id FROM memories WHERE status='active' AND conflict_with IS NOT NULL ORDER BY id`)
        .all();
    return rows.map((r) => {
        const pending = readMemory(db, r.id);
        const old = pending.conflict_with == null ? null : readMemory(db, pending.conflict_with);
        return { pending, old };
    });
}
/** 仲裁状态转移。key ∈ 1/2/3/4（s/q 由 TUI 处理，不落库）。写 memory_events before 快照。返回人类可读结果。 */
export function applyArbitration(db, pendingId, key) {
    const pending = readMemory(db, pendingId);
    if (!pending || pending.conflict_with == null)
        return `#${pendingId} 无待仲裁或已处理`;
    const old = readMemory(db, pending.conflict_with);
    const snap = { pending: snapRow(pending), old: old ? snapRow(old) : null, insertedId: null };
    const op = { "1": "keep_new", "2": "keep_old", "3": "merge", "4": "no_conflict" }[key];
    switch (key) {
        case "1": // 保留新：旧→superseded（检索不再出现旧值——R1 active 过滤）
            setStatus(db, old.id, "superseded", pending.id);
            clearConflict(db, pending.id, 0.8);
            break;
        case "2": // 保留旧：新→rejected，旧 conf+0.05
            setStatus(db, pending.id, "rejected");
            bumpConfidence(db, old.id, 0.05);
            clearConflict(db, pending.id, null);
            break;
        case "3": {
            // 合并：双方→merged + 新插合并行（derived_from=新id）；insertedId 记入快照供 u 撤销删除
            const ins = insertMerged(db, pending, old);
            setStatus(db, old.id, "merged", ins.id);
            setStatus(db, pending.id, "merged", ins.id);
            snap.insertedId = ins.id;
            break;
        }
        case "4": // 不冲突：双方去标签，conf 恢复 0.8
            clearConflict(db, pending.id, 0.8);
            restore(db, snapRow(readMemory(db, old.id)), 0.8);
            break;
    }
    appendEvent(db, { memory_id: pending.id, op, payload: JSON.stringify(snap) });
    return SUMMARY[key];
}
const SUMMARY = {
    "1": "保留新：旧已 superseded（检索不再出现旧值）",
    "2": "保留旧：新已 rejected，旧 conf+0.05",
    "3": "合并：双方 -> merged，新插合并记忆",
    "4": "不冲突：双方去标签，conf 恢复 0.8",
};
/** 撤销最近一条未撤销仲裁：按 before 快照恢复双方状态，删 merge 插入行，标 undone */
export function undoLastArbitration(db) {
    const e = db
        .prepare(`SELECT id, memory_id, op, payload FROM memory_events WHERE op!='undo' AND undone=0 ORDER BY id DESC LIMIT 1`)
        .get();
    if (!e)
        return "无可撤销的仲裁记录";
    const snap = JSON.parse(e.payload);
    restore(db, snap.pending);
    if (snap.old)
        restore(db, snap.old);
    if (snap.insertedId != null)
        db.prepare(`DELETE FROM memories WHERE id = ?`).run(snap.insertedId);
    db.prepare(`UPDATE memory_events SET undone=1 WHERE id=?`).run(e.id);
    appendEvent(db, { memory_id: e.memory_id, op: "undo", payload: JSON.stringify({ undoEventId: e.id }) });
    return `已撤销 ${e.op}（#${e.memory_id}），状态已还原`;
}
function snapRow(r) {
    return {
        id: r.id,
        status: r.status,
        confidence: r.confidence,
        eff_confidence: r.eff_confidence,
        conflict_with: r.conflict_with,
        superseded_by: r.superseded_by,
    };
}
/** 按快照覆盖状态列（不动内容/向量/时间），conf 可选覆盖为另一值（如 4 恢复 0.8） */
function restore(db, s, confOverride) {
    db.prepare(`UPDATE memories SET status=?, confidence=?, eff_confidence=?, conflict_with=?, superseded_by=? WHERE id=?`).run(s.status, confOverride ?? s.confidence, s.eff_confidence, s.conflict_with, s.superseded_by, s.id);
    invalidateVectorCache(db); // P0-4.1：撤销仲裁会把记忆还原回 active，必须让候选池重载
}
/** 软删：置 status='rejected'（保留原文/向量/审计），供规则页删除与人仲裁复用。可选传入 operator 自动写审计。 */
export function rejectMemory(db, id, operator = "unknown") {
    setStatus(db, id, "rejected");
    logDaemon(db, { task: "reject", op: "reject", memory_id: id, operator, detail: "软删 rejected" });
}
/** 按类型查列表（规则页用 type='rule'），status 为空则不限；created 倒序 */
export function queryByType(db, type, opts = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
    const where = opts.status ? `status=? AND type=?` : `type=?`;
    const params = opts.status ? [opts.status, type, limit] : [type, limit];
    const rows = db
        .prepare(`SELECT ${BASE_COLUMNS} FROM memories WHERE ${where} ORDER BY julianday(created_at) DESC, id DESC LIMIT ?`)
        .all(...params);
    return rows.map(rowOf);
}
export function setStatus(db, id, status, supersededBy) {
    if (supersededBy != null) {
        db.prepare(`UPDATE memories SET status=?, superseded_by=? WHERE id=?`).run(status, supersededBy, id);
    }
    else {
        db.prepare(`UPDATE memories SET status=? WHERE id=?`).run(status, id);
    }
    // P0-4.1：状态流转直接决定 activeOnly 候选池；本次带出的 rejectMemory / applyArbitration 亦经此路径。
    invalidateVectorCache(db);
}
function clearConflict(db, id, confWhenNonNull) {
    if (confWhenNonNull != null) {
        db.prepare(`UPDATE memories SET conflict_with=NULL, confidence=? WHERE id=?`).run(confWhenNonNull, id);
    }
    else {
        db.prepare(`UPDATE memories SET conflict_with=NULL WHERE id=?`).run(id);
    }
    invalidateVectorCache(db); // P0-4.1
}
function insertMerged(db, a, b) {
    const content = `${a.content}\n--- 并入 #${a.id}\n${b?.content ?? ""}`.trim();
    const out = writeMemory(db, {
        content,
        type: a.type === (b?.type ?? a.type) ? a.type : "experience",
        agent: `${a.agent}+${b?.agent ?? "?"}`, // 合并为双方贡献
        agent_fpath: null,
        project: a.project,
        confidence: Math.round(((a.confidence + (b?.confidence ?? a.confidence)) / 2) * 100) / 100,
    });
    db.prepare(`UPDATE memories SET derived_from=? WHERE id=?`).run(a.id, out.id);
    return out;
}
