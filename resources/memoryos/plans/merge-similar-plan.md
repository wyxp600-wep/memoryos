# 相似记忆合并成一条 —— 方案与实施计划

状态：**待授权**（本文档只做设计与计划，未修改任何源码）
日期：2026-10-11
范围：`resources/memoryos/dist/{db.js, server-reg-memory.js, daemon.js}`

---

## 1. 目标

让"内容相似的记忆"在系统内**收敛为一条**，且满足三条硬要求：

1. **不丢信息** —— 被合并方的正文必须可追溯（进 winner 正文或事件快照），不得静默丢弃。
2. **可回滚** —— 每次融合留 before 快照，人工可还原。
3. **不破坏检索** —— 融合后必须重算向量，否则语义召回永久失效。

---

## 2. 现状与根因（已实证）

| 事实 | 证据 |
|---|---|
| "合成一条"的能力已存在 | `db.js:1914 insertMerged`：正文拼接、type/agent/confidence 合并、`derived_from` 溯源 |
| 但只有人工仲裁一条触发路径 | `insertMerged` 唯一调用点 `db.js:1823`（`applyArbitration` key=3）；实测 `derived_from` 非空 = **0** |
| 两条自动路径都"丢内容" | 写入闸 `server-reg-memory.js:198-204`、守护 `daemon.js:291-301` 只做 `bumpConfidence(+0.1)` |
| 合并产物无向量（隐藏缺陷） | `insertMerged` → `writeMemory` 不传 `embedding`；`db.js:1144` 仅 `if (args.embedding) upsertVector(...)`；未置 `embedding_stale=1`，而 `reembedStale` 只查 `stale=1`（`daemon.js:336`）→ 该条永久仅词法可见 |
| 撤销栈会被污染（隐患） | `undoLastArbitration` 取 `WHERE op!='undo' AND undone=0 ORDER BY id DESC LIMIT 1`（`db.js:1846`），不筛 op → 新增的 `fold` 事件会被误当仲裁记录撤销 |
| 阈值双口径 | 写入 merge ≥0.92（`db.js:1333`）vs 守护 dedupe >0.96（`daemon.js:24`） |
| 灰区是主体 | 300 条 active 样本重写同文：merge 16 / **conflict 192（64%）** / insert 50 |
| 内容静默丢失风险面 | 489 条非 active 池中 **273 条与所有 active 条 maxSim<0.92**（merged 207/archived 44/rejected 18/trial 4） |

**根因一句话**：写入/守护两条自动路径把"≥0.92"一律理解为"重复 → 丢弃新内容"，而"≥0.92"实际包含两类：①同一结论的不同表述（丢弃合理）②同主题的互补信息（丢弃即信息丢失）。系统无法区分，于是选择了一律丢弃。

---

## 3. 设计原则

1. **融合而非丢弃**：命中 merge 时把新正文以附录形式并入 winner，winner 仍是唯一 active 条。
2. **可逆**：每次融合写 `memory_events(op='fold')`，payload 存 before 正文 + 长度，供人工/脚本还原。
3. **有护栏**：正文长度上限 + 同文短路，防"越并越胖"。
4. **向量必须重算**：融合即置 `embedding_stale=1`，由现有 `reembedStale` 补算（不引入新机制）。
5. **阈值语义分离**：0.92~0.95 仍走人工冲突，只有 ≥0.95 才自动融合（融合有成本，宜保守）。

---

## 4. 方案 A 详细设计（推荐）

### 4.1 新增 `db.js` 内部函数 `foldInto`

```js
const FOLD_MAX_CHARS = 3000;   // winner 正文上限护栏
export function foldInto(db, winnerId, loserContent, meta = {}) {
  // 返回 {ok, reason?, newLen?, skipped?}
  // 1) 读 winner；不存在 → {ok:false, reason:'missing'}
  // 2) 同文短路：winner.content.includes(loserContent.trim()) → {ok:true, skipped:'duplicate'}
  // 3) 护栏：winner.content.length + loserContent.length > FOLD_MAX_CHARS
  //      → 不拼接，仅写事件 {ok:true, skipped:'too_long'}
  // 4) 事务内：
  //    content = winner.content + `\n--- 并入 #${meta.fromId ?? 'new'}（${meta.agent}·${date}）\n` + loserContent
  //    UPDATE memories SET content=?, embedding_stale=1, version=version+1 WHERE id=?
  //    UPDATE memories_fts SET content=? WHERE rowid=?        // 与 updateMemory 同范式
  //    syncGrams(db, winnerId, content)                        // 私有函数，同文件可用
  //    appendEvent(db, {memory_id:winnerId, op:'fold',
  //                     payload: JSON.stringify({beforeLen, afterLen, fromId, agent}), operator})
  //    invalidateVectorCache(db)
}
```

要点：
- 复用 `updateMemory` 已验证的落库范式（`db.js:1163-1171`），不新造轮子。
- `syncGrams` 是模块私有（`db.js:1437`），故 `foldInto` 必须写在 `db.js` 内并 export 给上层调用。
- 每对融合的 gram 重写量 ≈ 正文长度（≤4000 gram），是主要成本。

### 4.2 必修配套改动（否则方案不可用）

| # | 改动 | 文件:行 | 理由 |
|---|---|---|---|
| M1 | `insertMerged` 补 `embedding_stale=1` | `db.js:1914-1926` | 否则人工仲裁产物永久无向量 |
| M2 | `undoLastArbitration` 增加 `AND op IN ('keep_new','keep_old','merge','no_conflict')` | `db.js:1846` | 防止 `fold` 事件污染撤销栈 |
| M3 | `markMerged` 后 loser 正文保留策略复核 | `db.js:1782` | 融合后 winner+loser 正文重复存储，需明确"保留审计"或"改存指针"（见 §7 决策项） |

### 4.3 接入点

**① 写入闸**（`server-reg-memory.js:198-204`）
```
d2.action === 'merge' && d2.targetId:
  旧：plan = {kind:'merge'} ; bumpConfidence(target, 0.1) ; t = readMemory(target)
  新：const f = foldInto(db, d2.targetId, args.content, {agent: AGENT})
      plan = {kind:'merge', targetId, sim, folded: f}
      // 精确同文闸（:187-194）走同一分支，由 foldInto 的"同文短路"兜住，避免自我膨胀
  回执：`已并入 #${t.id}（正文已融合，向量待重算）` + stateReceipt{..., folded:true|skipped}
```

**② 守护 dedupe**（`daemon.js:291-301`）
```
for (const d of plan.dedupes) {
  const loser = readMemory(db, d.loser)
  foldInto(db, d.winner, loser.content, {fromId: d.loser, agent: loser.agent})
  markMerged(db, d.loser, d.winner)
  if (d.crossSource) bumpConfidence(db, d.winner, 0.1)
}
```
- 顺序：先 fold 后 mark（fold 需读 loser 正文；mark 会写 status/事件）。
- `applyPlan` 是单事务（`daemon.js:270`），fold 抛错 → 整轮 ROLLBACK，不会半途。
- **限量**：`dedupeRoundLimit` 由 50 降为 **10**/轮，控制 gram 重写与向量重算压力（`daemon.js:25`）。

### 4.4 阈值决策（需用户拍板）
- 保持 0.92：融合更积极，正文膨胀概率高。
- 上调 0.95（建议）：0.92~0.95 落入人工冲突队列，队列会再涨（现 253 条积压）→ **与"冲突队列自动处理"耦合**，建议同批做或先不做上调。

### 4.5 向量补算链路（无需新代码）
`foldInto` 置 `stale=1` → `daemon.js:811` 每小时 `reembedStale(db, 20)` → `upsertVector` + 清 stale。
注意：融合条在补算前仍持有**旧向量**（语义略偏），窗口 ≤1 小时；单次融合量 >20 条时需多轮消化。

---

## 5. 分阶段计划

### Phase 0 — 准备（无源码改动）
- 备份：`cp dist/{db.js,server-reg-memory.js,daemon.js} dist/<name>.bak-fold-20261011`
- 门禁基线：`node dist/smoke-all.js`（期望 22 PASS/0 FAIL/2 SKIP）
- 临时验证库：`cp %APPDATA%\MemoryOS\data\memory.db <temp>/mem-verify/memory.db`

### Phase 1 — 核心（P0，写入路径）
改动：`db.js`（新增 `foldInto` + M1 + M2）、`server-reg-memory.js`（merge 分支接入）
验证断言（临时实例，`MEMORY_DB=<副本> MEMORY_PORT=8799 MEMORY_RESTRICTED=0`）：
1. 写 A，再写与 A 相似度 ≥0.95 的 B → 回执含"已并入 #A"，无新行产生
2. `SELECT content FROM memories WHERE id=A` → 含 B 正文且含 `--- 并入 #`
3. `SELECT embedding_stale FROM memories WHERE id=A` = 1
4. `SELECT * FROM memory_events WHERE op='fold'` ≥1 条，payload 含 before 快照
5. 重写与 A 完全同文 → 回执 skipped=duplicate，A 正文**未二次膨胀**
6. 连续并入至 >3000 字 → 回执 skipped=too_long，事件仍留痕
7. `arbitrate.js --json` 队列数不因本次改动异常增长
回滚：还原两个 `.bak` + 托盘重启内核

### Phase 2 — 守护路径
改动：`daemon.js`（dedupe 循环接入 fold + `dedupeRoundLimit` 50→10）
验证：
1. 构造 3 条互似（sim>0.96）记忆，手动跑一轮治理 → 1 条 active + 2 条 merged，winner 正文含另两条内容
2. `daemon_log` 出现 `task='dedupe' op='merge'`，且 winner `embedding_stale=1`
3. 跑 `reembedStale` 后 `memory_vectors` 有 winner 行且 `stale=0`
4. 治理耗时对比：折叠前后一轮 `buildPlan`+`applyPlan` 时间差 ≤2×
回滚：还原 `daemon.js.bak`

### Phase 3 — 可选增强（需另行授权）
- 冲突队列自动裁决（超期 N 天自动 key=1/2），否则 253 条会持续涨
- 阈值统一到 0.95 + 面板"折叠此对"按钮
- 存量清理：对 273 条"孤立非 active 条"做一次性体检报告（只报不改）

---

## 6. 验证矩阵（每 Phase 收尾必跑）

| 项 | 命令 | 通过标准 |
|---|---|---|
| SQL 占位符/实参 | `node dist/lint-sql-arity.js` | 0 error |
| 静默写失败 | `node dist/lint-silent-catch.js` | 无 HIGH |
| 路由快照 | `node dist/snapshot-routes.js --check` | 0 差异 |
| 全量冒烟 | `node dist/smoke-all.js` | ≥22 PASS / 0 FAIL |
| 语法 | `node --check dist/db.js` 等 | 通过 |
| 端到端 | 临时实例 7 条断言（§5 Phase1） | 全绿 |

---

## 7. 不做的事（边界）
- 不改 `getVectorsOnProject` 的候选池语义（属上一轮报告的独立缺陷，单独授权再改）
- 不动 conflict 灰区（0.85~0.92）的自动裁决
- 不引入 LLM 生成式合并（`llm.js` 现仅 `extractFromSource`，新增摘要 prompt 有幻觉风险，收益不抵成本）
- 不物理删除任何记忆行（merged/rejected 保留审计）

## 8. 待你拍板的三项
1. **阈值**：保持 0.92 融合，还是上调 0.95（配合冲突队列自动处理）？
2. **守护侧是否同步做**：Phase 2 一起做，还是先只做写入侧（A′）观察一周？
3. **loser 正文策略**：融合后 loser 保留原文（存储翻倍、审计完整），还是改存 `[已并入 #winner]` 指针（省空间、审计弱化）？
