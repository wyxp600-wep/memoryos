# 记忆库整理体检报告

状态：**只读体检已完成，未修改任何数据**（等待授权执行）
日期：2026-10-11
数据源：`%APPDATA%\MemoryOS\data\memory.db`（生产库，2440 条记忆 / 17 个 project）

---

## 一、体检结论（一句话）

记忆库**功能正常但存在三类结构性问题**：① project 命名分裂导致**101 条记忆当前搜不到**（最严重）② 258 条冲突标记积压 35 天无处理 ③ 573 条 active 记忆 30 天零命中（占 32%）。重复本身反而不是主要问题（无 active+active 同文重复）。

---

## 二、现状数据

| 维度 | 数值 |
|---|---|
| 记忆总量 | **2440**（active 1807 / merged 437 / rejected 109 / archived 77 / trial 10） |
| 向量 | 2409 条（31 条无向量 = dispatcher 卡片任务，`embedding_stale=0` 永不补算） |
| 正文长度 | p50=120 / p75=452 / p90=954 / p99=2103 / max=7249；>1000 字 **243** 条，>2000 字 48 条，>3000 字 13 条 |
| 写入方分布（active） | trae 727 / workbuddy 396 / zcode 301 / claude 65 / codex 60 / dispatcher 52 / opencode 33 |
| 表规模 | daemon_log **820574** / memories_gram 185945 / card_events 15239 / memory_usage 8008 / memory_events 2855 / cards 196 |
| 敏感记忆 | sensitivity=secret **0** 条（无泄漏面） |
| 过期未清 | valid_until 已过但仍 active **0** 条（H6 过滤有效） |

---

## 三、问题清单（按严重度）

### 问题 1：project 命名分裂 → 101 条记忆检索不到 ★最严重
| project | 条数 | 问题 |
|---|---|---|
| `MemoryOS` | 119 | 与 `memoryos`（74）**大小写分裂** |
| `memoryos` | 74 | 当前 agent 用的 scope，只能搜到这 74 条 |
| `知识库` | 94 | 正常；但 `knowledge`(1) + `ZSK`(3) 是它的分裂体 |
| `-c-Users-WYX-Desktop-MemoryOS--p2-4b0cf18188ac7b5e8485` | 1 | 路径形态脏数据（id 4807，托盘图标根因那条） |
| `wimoor` / `trae` / `ui-layout` / `ui-motion` / `copywriting` | 各 1 | 单条碎片 scope |

**影响**：`memory_search`/`memory_context` 的 scope 隔离是精确匹配（`project IN (?, 'global')`），所以：
- 传 `project='memoryos'` → **漏掉 `MemoryOS` 的 119 条**（含本项目的核心经验）
- 传 `project='知识库'` → 漏掉 `knowledge` + `ZSK` 的 4 条
- 记忆 #4537 早已记录"两个相似项目名导致读取不全"，但一直未修

### 问题 2：冲突队列积压 258 条，35 天零处理
- 时间跨度：2026-09-06 → 2026-10-11
- 其中 **228 条**双方都还 active（真冲突对，检索时会同时召回互相矛盾的内容）
- 另 **22 条**指向的目标已 archived/merged/rejected（**无效标记，可直接清**）
- 分布：trae 69 / workbuddy 56 / zcode 42 / opencode 29 / minimax 18 / qoder 10 / unknown 10 / claude 6
- 消费入口只有人工（`/api/conflicts` + `arbitrate.js` TUI），daemon 不自动处理

### 问题 3：573 条 active 记忆 30 天零命中（占 active 32%）
- 判据：`status='active' AND hit_count=0 AND created_at < now-30d`
- 未被 daemon 归档的原因：归档条件是 `eff<0.1` 或 `45 天无曝光`，而这些条 salience=1、λ 小，eff 仍高于阈值
- 风险：它们仍在语义候选池里参与计算（每次检索都算），但不产出价值

### 问题 4：完全同文重复 15 组（影响小）
- 状态组合：`active+merged` 10 组 / `merged+merged` 4 组 / `rejected+rejected` 1 组
- **没有 active+active** → 说明写入侧精确同文闸在正常工作
- 属设计痕迹（merged 保留原文供审计），不是漏检

### 问题 5：daemon_log 82 万行无归档策略
- `decay` 任务占 812450 行（每小时为每条 active 记忆写一行）
- daemon 的保留策略只归档 `card_events>180d` 与 `memory_usage>90d`，**daemon_log 不在其列** → 单调膨胀

### 问题 6：31 条无向量孤儿
- 全部是 `agent=dispatcher` 的 `[task][assignee:?]` 卡片派发任务，`embedding_stale=0` 永不补算
- 影响有限（卡片任务在检索时被 `source_ref LIKE 'card:%'` 过滤），但属数据不完整

---

## 四、整理方案

### A 档：零风险、纯收益（建议直接执行）
| # | 动作 | SQL / 做法 | 影响面 | 验证 |
|---|---|---|---|---|
| A1 | **project 归并** | `UPDATE memories SET project='memoryos' WHERE project IN ('MemoryOS','-c-Users-…')`；`UPDATE memories SET project='知识库' WHERE project IN ('knowledge','ZSK')` | 194 条记忆的 scope 字段；修复 101 条漏检 | 归并后 `memory_search(project='memoryos')` 能命中原 `MemoryOS` 的条 |
| A2 | **清单条碎片 scope 归一** | `wimoor/trae/ui-layout/ui-motion/copywriting` 各 1 条 → 按内容归入 `memoryos` 或 `global` | 5 条 | 逐条人工确认内容后归并 |
| A3 | **清无效冲突标记** | `UPDATE memories SET conflict_with=NULL WHERE conflict_with IN (SELECT id FROM memories WHERE status!='active')` | 22 条（指向已终态） | `conflict_with` 非空数 258 → 236 |
| A4 | **补 31 条孤儿向量** | `UPDATE memories SET embedding_stale=1 WHERE id NOT IN (SELECT memory_id FROM memory_vectors)` | 31 条，daemon 每小时补 20 条 | 两轮后 `memories`=向量数 |

### B 档：需你决策（涉及状态变更，可回滚）
| # | 动作 | 选项 |
|---|---|---|
| B1 | 228 条真冲突对 | ①出清单人工裁决 ②定策略自动裁决（如"保留 conf 高者、平手保留新"）③不动 |
| B2 | 573 条零命中僵尸 | ①出清单确认后批量归档 ②调 daemon 阈值让它自然收敛 ③不动 |
| B3 | 13 条 >3000 字超长记忆 | ①逐条精简为"结论+依据" ②不动（多为已 rejected 的长笔记） |
| B4 | 10 组 active+merged 同文重复 | ①merged 条正文改存 `[已并入 #winner]` 指针省空间 ②不动（保留审计） |
| B5 | daemon_log 82 万行 | ①加保留策略（>90 天归档到 `daemon_log_archive`）②不动 |

### C 档：不建议动
- merged/rejected/archived 623 条（审计价值，且不进检索）
- 不可信围栏、scope 列表（安全与可用性边界）
- 任何 `sensitivity=secret` 相关（当前 0 条）

---

## 五、执行前置（授权后第一步）
1. 备份：`cp %APPDATA%\MemoryOS\data\memory.db <备份目录>/memory.db.bak-organize-20261011`（含 -wal/-shm）
2. 停写窗口：确认无 agent 正在写（或直接依赖 WAL 并发安全 + busy_timeout）
3. 逐档执行 → 每档跑一次验证断言 → 全绿后再进下一档
4. 回滚：还原备份文件 + 托盘重启内核

## 六、待你拍板
1. **A 档是否直接执行**（A1 修复 101 条漏检，收益最高）
2. **A1 归并方向**：统一小写 `memoryos`，还是统一大写 `MemoryOS`？（建议小写，与工具默认参数一致）
3. **B 档哪些要做**（B1 冲突 / B2 僵尸 / B5 daemon_log 归档）
