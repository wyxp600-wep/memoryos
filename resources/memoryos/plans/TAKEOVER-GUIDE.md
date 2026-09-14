# 会话接管流程 · 多 Agent 任务计划（v1.1.0）

> 基于 `plan.schema.json` 的并发租约语义，说明"一个 Agent 的任务被另一个 Agent 接管"的正确流程。
> 核心：未完成必须可验证、可追责、可恢复；接管必须带租约证据，禁止静默覆盖写。

---

## 一、触发接管的前提条件

接管**不是任意时刻都能发生**，必须满足以下任一：

| # | 触发条件 | 判定方式（可机读） |
|---|---|---|
| 1 | 当前持有者租约过期 | `handoff.lease_expires_at < now` 且 `handoff.heartbeat_at` 未及时更新 |
| 2 | 持有者明确让渡 | `audit_log` 出现 `handoff.released`，且 `handoff.next_action == "handoff"` |
| 3 | 持有者失联 / 心跳停止 | `handoff.heartbeat_at` 距今超过阈值（见 §四 阈值） |

> 若租约未过期、心跳正常、持有者未让渡，**其他 Agent 不得接管**（尊重租约）。

---

## 二、接管前置检查（peek）

接管方应先**只读探测**计划，不写：

1. 读取 `plan.json`，解析 `schema_version`（须为 `1.1.0`）。
2. 检查 `plan_status`：若为 `paused`，须先解决 CONFLICT（§六）且 `next_action` 合法，才能接管。
3. 检查租约：
   - 无 `lease_expires_at` → 视为未上锁，可接管（但应补租约）。
   - 有过期 → 可接管。
   - 未过期 → 除非 `next_action == "handoff"`，否则禁止。
4. 记录 `audit_log` 一条 `lease.peek`（探测痕迹），供追溯。

---

## 三、接管步骤（Takeover）

按顺序执行，每步验证，任一步失败即回滚计划文件。

### 步骤 1 · 校验计划合法
```bash
node plan-validate.mjs plan-<id>.json
# 期望输出：✓ 校验通过
```

### 步骤 2 · 声明接管（先付 ack）
更新 `handoff`：

```json
{
  "handoff": {
    "previous_owner": "agent:executor-01",
    "current_owner": "agent:executor-02",
    "takeover_at": "2026-09-11T18:56:00+08:00",
    "lease_expires_at": "2026-09-11T19:26:00+08:00",
    "heartbeat_at": "2026-09-11T18:56:00+08:00",
    "version": 4,
    "etag": "sha256:<新哈希>"
  }
}
```

必须：`version` +1；`etag` 重算；`lease_expires_at` 重新签发（典型 +30min，可配置）；记录 `lease.takeover`。

### 步骤 3 · 回写 PLANUPD 审计行
在计划文件末尾追加（机器可读协议）：

```text
PLANUPD: plan_id=plan-memoryos-lease-demo task_id=T1 from=in_progress to=claimed_by_executor-02 reason=takeover-after-lease-expiry at=2026-09-11T18:56:00+08:00
```

### 步骤 4 · 执行任务
接管方以新 `current_owner` 身份继续推进已被 `claimed` 的任务。执行中每完成一个步骤：
- 更新 `steps[].status` 与 `progress.done_steps`
- 追加 `attempts[]`（含 `evidence_refs`）
- 更新 `heartbeat_at`（**续约**，防止被再次接管）

### 步骤 5 · 完成 & 交接出去（可选）
- 若任务完成：校验收 (review)，满足 done 前置 §五 后置 `done`，记录验收证据。
- 若仍需他人：更新 `handoff.next_action` + `last_synced_session`，追加 `handoff.released`，写 `lease.release`。

---

## 四、心跳 / 租约阈值（建议默认值）

| 参数 | 建议值 | 说明 |
|---|---|---|
| 租约时长 | 30 min（任务粒度可覆盖） | `lease_expires_at - takeoff/t/acquire` |
| 心跳间隔 | ≤ 10 min | 每次改计划即续约 |
| 失联判定 | `now - heartbeat_at > 20 min` | 超时 → 其他 Agent 可接管（须满足 §一） |
| 接管权限 | 见 `permissions.can_takeover_expired` | 未获授权不得接管 |

> 阈值可写进 `handoff` 无专门字段时，以 `lease_expires_at` / `heartbeat_at` 两者时间差推算，保持机读。

---

## 五、置 done 前置条件（从 schema 继承，接管完成时严格执行）

任务置 `done` 前五项必须同时满足：

1. `progress.percent == 100`
2. 所有 `acceptance_criteria[].verified == true`
3. 无 `blockers[].status == "open"`
4. 若 `review.required == true`，则 `review.status == "approved"`
5. 至少一条 `attempts` 证据或 `evidence_refs`

接管完成的任务若缺少任一，**必须补齐证据**，否则不置 done（防"假完成"）。

---

## 六、冲突处理（CONFLICT）

若接管方读取时发现 `version` 不匹配自己的预期（表示别人先写了）：

1. 停止写入，重读最新文件（含新 `version`）。
2. 对比差异：判断他人改动与自己的目标是否冲突。
3. 可用 `audit_log` / `PLANUPD` 行还原变更链。
4. 解决方式：
   - 若可合并 → 合并后 `version+1`，追加 `decisions_log` 记录决策与理由。
   - 若不可合并 → 将 `plan_status` 置 `paused`，`handoff.next_action="wait_user"`，请求用户仲裁。
5. **必须**：冲突解决后把 `plan_status` 从 `paused` 恢复 `active`，并记录 `decisions_log`。

回写约定：
```text
CONFLICT: plan_id=... task_id=T1 version_expected=3 version_actual=4 reason=concurrent-write at=ISO8601
# 解决后：
PLANUPD: plan_id=... task_id=T1 from=paused to=active reason=conflict-resolved at=ISO8601
PLANUPD: plan_id=... task_id=T1 from=in_progress to=blocked reason=under-user-arbitration at=ISO8601
```

---

## 七、状态机对照（任务级合法迁移）

```
pending ──→ in_progress ──→ blocked ──→ in_progress
   │            │   │            │
   │            │   ├──→ review ──→ done      (done 为终态，重开须 reopened 事件)
   │            │   │              └→ in_progress / failed / blocked
   │            │   └──→ failed ──→ in_progress / cancelled
   └───────→ cancelled（须写 cancel_reason）
```

**接管只改变 `assignee` / `handoff`，不改变任务 `status`**（除非租约过期时被读取方判定为可接管并可重排）。

---

## 八、检查清单（接管方交付前）

- [ ] `plan-validate.mjs` 校验通过
- [ ] `handoff.current_owner` 已更新，`version` 已 +1
- [ ] `audit_log` 含 `lease.pk` + `lease.takeover`
- [ ] 计划文件末尾已追加 `PLANUPD:` 行
- [ ] 若遇到并发写入，已按 §六 处理并记录 `decisions_log` / `CONFLICT`
- [ ] `resume_hint` ≤2 句，包含当前阻塞点
- [ ] `next_action` 是合法枚举
- [ ] 无 open blocker 却 `status=blocked` 的矛盾任务
- [ ] 所有 ISO8601 时间带时区
- [ ] 无敏感信息写入计划

---

## 九、相关文件

| 文件 | 用途 |
|---|---|
| `plan.schema.json` | 计划文件结构定义（v1.1.0） |
| `plan-20260911-lease-demo.json` | 并发租约示例计划 |
| `plan-validate.mjs` | 零依赖校验器 |