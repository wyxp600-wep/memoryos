# 记忆库整理执行报告

日期：2026-10-11
授权范围：A1 project 归并 · B1 冲突自动策略 · B3 超长精简（B2 僵尸不动）
改动性质：**仅数据，零代码改动**
备份：`outputs/db-backup-20261011/memory.db`（VACUUM INTO 一致性快照，130.6MB / 2442 条）

---

## 一、A1 project 命名归并（128 行）

| 动作 | 行数 | 依据 |
|---|---|---|
| `MemoryOS` → `memoryos` | 119 | 大小写分裂，同一项目 |
| `-c-Users-…MemoryOS--p2-4b0cf18188ac7b5e8485` → `memoryos` | 1 | 路径形态脏数据（id 4807 托盘图标根因） |
| 碎片 `knowledge`/`trae` → `memoryos` | 2 | 按正文判定（#4190 "MemoryOS T1 热更新加固"、#4092 命中率口径） |
| `ZSK` → `知识库` | 3 | ZSK = 知识库缩写 |
| `copywriting` → `知识库` | 1 | 文案技巧笔记（#4605） |
| `ui-layout`/`ui-motion` → `ui-prompt` | 2 | UI 提示词清单（#4590/#4618），与 ui-prompt 同类 |
| `wimoor` 保留 | 0 | 真实独立项目名，不动 |

**结果**：17 个 project → **9 个**，分裂残留 **0**。
**修复效果**：`project='memoryos'` 的检索候选池（`project IN (?, 'global')`）现覆盖 **1589 条**；此前 119 条 `MemoryOS` 记忆对任何查询都不可见（记忆 #4537 记录过此坑，今日修复）。

---

## 二、B1 冲突自动策略（251 条 → 0）

### 策略（核心原则：**信息零损失**，不二选一丢弃）
1. **无效标记**（`conflict_with` 指向已终态）：22 条 → 清空标记。
2. **真冲突**：选 winner 后把 loser 正文**并入** winner 正文（`\n--- 并入 #loser（agent·日期）\n<正文>`），loser 置 `status='superseded'` + `superseded_by=winner`。
   - R1 新条含更新语义（更正/修正/已废弃/改为/不再适用/替换/过期/推翻…）→ 保留新
   - R2 旧条含更新语义 → 保留旧
   - R3 conf 差 ≥0.15 → 保留高 conf 者
   - R4 平手 → 保留新（后写上下文更全）
   - 护栏：loser 内容已含于 winner → 只裁决不拼接；拼接后超 4000 字 → 只裁决不拼接

### 执行分布
| 规则 | 条数 |
|---|---|
| R1 新含更新语义 | 31 |
| R2 旧含更新语义 | 33 |
| R3 保留新（conf 高） | 8 |
| R3 保留旧（conf 高） | 43 |
| R4 平手取新 | 46 |
| 无效标记清空 | 22 |
| 残留收敛（互指/长链） | 5 |
| **合计** | **251** |

### 结果
- `conflict_with` 非空：**258 → 0**
- `active`：1808 → **1644**（161+5 条 loser 移出检索）
- 新增 `superseded`：**166 条**（全部带 `superseded_by`，检索只取 `active` 故不影响召回；前端 `app.js` 已内置 `superseded: '已取代'` 文案与配色，无需改动）
- 审计：`memory_events` `op='fold'` **166 条**（含 before/after 长度与规则）
- 悬空卡：2 张指向 superseded 记忆的卡已是 archived 终态，无残留
- 跳过拼接 20 条（已含或超长护栏）

---

## 三、B3 超长精简（45 条）

### 分两段执行
1. **机械压缩 39 条**（合并产物）：把"并入段"全文压成首句摘要 + `…（原文见 #N）`。loser 原文仍在库（superseded 状态可 `memory_read`），零信息丢失。
2. **逐条重写 7 条**（3 条 obsidian 长笔记 + 3 条无并入段 + 1 条）：
   | id | 前 | 后 | 压缩 |
   |---|---|---|---|
   | #3182 | 5231 | 1937 | −63% |
   | #3183 | 2503 | 1587 | −37% |
   | #3184 | 2692 | 2076 | −23% |
   | #3185 | 2447 | 1596 | −35% |
   | #4590 | 2719 | 1643 | −40% |
   | #4587 | 2682 | 1834 | −32% |
   | #4685 | 2617 | 2271 | −13% |

### 结果
- `active` 正文 >2000 字：**49 → 6**（余 4 条 task 记录 + #3184 2076 + 1 条）
- 最长正文：**7249 → 2432 字**
- 长度分布：p50 110 / p90 961 / p99 1844
- 审计：`op='condense'` **46 条**；原文全文备份 `outputs/condense-backup-20261011.jsonl`（46 条）

---

## 四、向量补算 ✅ 已完成
`updateMemory` 置 `embedding_stale=1` 共 **128 条**（正文变更必然失效）。经内核 `/api/embed/recompute/:id`（内部 `reembedStale(db,1)` 按队列头逐条）补算：
- **110 次调用后 `pending=0`、`failed=0`**，耗时 7 分 09 秒
- 最终 `embedding_stale=1` 计数 **0**；记忆 2443 / 向量 2412（差 31 = 遗留的 dispatcher 无向量孤儿）
- 未自跑嵌入（避免 `EMBED_MODE=fake` 污染语义空间），全程使用内核已加载的正确 embedder

---

## 五、验证证据（实测）

| 项 | 结果 |
|---|---|
| project 分裂残留 | **0**（`MemoryOS`/`ZSK`/`knowledge`/`copywriting`/`ui-layout`/`ui-motion`/`trae`/路径形态 全清） |
| conflict_with 非空 | **0** |
| superseded 缺 superseded_by | **0** |
| 状态分布 | active 1644 / merged 437 / superseded 166 / rejected 108 / archived 76 / trial 11 |
| 审计链 | fold 166 + condense 46 条事件，均有 operator=`organize:auto` |
| 备份完整性 | `outputs/db-backup-20261011/memory.db` 130.6MB / 2442 条 |
| 前端兼容 | `superseded` 文案/配色已存在（app.js 5 处），无需改前端 |
| 内核健康 | 8787 LISTENING（PID 27464），health 端点 200 |

---

## 六、回滚方式

1. **全量回滚**：把 `outputs/db-backup-20261011/memory.db` 覆盖 `%APPDATA%\MemoryOS\data\memory.db`，**同时删除 `memory.db-wal` 与 `memory.db-shm`**，然后托盘 →「重启内核」。
2. **逐条回滚**：精简的 46 条原文全文在 `outputs/condense-backup-20261011.jsonl`（JSONL：`{id, before, after}`）；合并的 166 条可经 `superseded_by` 反查 winner，loser 正文未改动。
3. 本次**无任何代码/配置改动**，无需回滚代码。

---

## 七、未做（按指示保留）

- **B2 僵尸 573 条**：按你指示不动（daemon 的 `eff<0.1 或 45 天无曝光` 规则会自然收敛）。
- **B4 同文重复改指针**、**B5 daemon_log 归档**：未授权，未做。

## 八、遗留建议

1. **daemon_log 82 万行无归档策略**（decay 占 812450）—— 保留策略只覆盖 `card_events>180d` 与 `memory_usage>90d`，建议加 `daemon_log` 归档（改动小，可单独授权）。
2. **31 条 dispatcher 无向量孤儿**（`embedding_stale=0` 永不补算）—— 全为 `[task][assignee:?]` 卡片任务，影响有限。
3. **`superseded` 是新引入状态**（166 条）：`merge-db.js` 的搬运白名单是 `active/trial/archived`，跨库迁移会漏这 166 条，将来用 merge-db 前需先扩白名单。
4. **合并策略副作用复盘**：本次"拼接 loser 全文"导致 43 条超 2000 字，已用机械压缩收敛。若后续要做自动合并（见 `merge-similar-plan.md`），应改为**只并入 loser 摘要句**而非全文。
