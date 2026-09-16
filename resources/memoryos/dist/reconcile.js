/**
 * MemoryOS ★ P2-6（C-5 / #4201）：三方对账与投影重建守护（任务记忆 ⇄ 看板卡片）。
 *  - 投影重建：任务记忆（active/trial 且非终态）无 dispatch 卡 → 补建卡（事件 reconcile_created）
 *  - 状态对齐：记忆头 pending/in_progress/blocked ↔ 卡片 ready/running/blocked 失配 → 修复（事件 reconcile_aligned）
 *  - 镜像滞后：修复时卡片 updated_at 滞后 >5 分钟 → daemon_log 告警（op=lag）
 *  实现纪律：参数绑定（无内联 SQL 字面量）+ 字符串切分（无正则转义）+ 幂等（一致的对不命中）。
 *  由常驻 daemon 每 5 分钟调用（daemon.js runReconcile）。
 */
const EXPECT_CARD_OF = { pending: "ready", in_progress: "running", blocked: "blocked" };
const NON_TERMINAL = ["pending", "in_progress", "blocked"];
const CARD_TERMINAL = ["done", "archived", "cancelled"];

/** 从任务记忆正文里取状态头（字符串切分，不用正则） */
function headStatus(content) {
    const a = String(content ?? "").split("[status:")[1];
    if (!a)
        return null;
    return a.split("]")[0].trim() || null;
}

/** 从任务记忆正文里取 assignee（字符串切分） */
function headAssignee(content) {
    const a = String(content ?? "").split("[assignee:")[1];
    if (!a)
        return null;
    const v = a.split("]")[0].trim();
    return !v || v === "?" ? null : v;
}

export function reconcileTasksAndCards(db) {
    const out = { created: 0, aligned: 0, lagAlerts: 0 };
    try {
        const pairs = db
            .prepare(`SELECT cm.memory_id, cm.card_id, m.content, c.status AS card_status, c.updated_at AS card_updated
                FROM card_memory cm
                JOIN memories m ON m.id = cm.memory_id
                JOIN cards c ON c.id = cm.card_id
                WHERE cm.relation=? AND m.type=? AND m.status IN (?,?)`)
            .all("dispatch", "task", "active", "trial");
        for (const p of pairs) {
            const st = headStatus(p.content);
            const want = st ? EXPECT_CARD_OF[st] : null;
            if (!want || p.card_status === want || CARD_TERMINAL.includes(p.card_status))
                continue;
            const lagMin = p.card_updated ? (Date.now() - Date.parse(p.card_updated)) / 60000 : null;
            db.prepare(`UPDATE cards SET status=?, updated_at=strftime(?, ?) WHERE id=?`).run(want, "%Y-%m-%dT%H:%M:%fZ", "now", p.card_id);
            db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(p.card_id, "reconciler", "reconcile_aligned", p.card_status, want, `任务 #${p.memory_id} 三方对账：头 ${st} → 卡 ${want}（C-5）`);
            out.aligned++;
            if (lagMin != null && lagMin > 5) {
                out.lagAlerts++;
                db.prepare(`INSERT INTO daemon_log(task,op,memory_id,detail,operator) VALUES (?,?,?,?,?)`).run("reconcile", "lag", p.memory_id, `卡片 #${p.card_id} 镜像滞后 ${Math.round(lagMin)} 分钟（任务 #${p.memory_id}），已修复至 ${want}`, "reconciler");
            }
        }
        const orphans = db
            .prepare(`SELECT m.id, m.content FROM memories m
                WHERE m.type=? AND m.status IN (?,?)
                AND NOT EXISTS (SELECT 1 FROM card_memory cm WHERE cm.memory_id=m.id AND cm.relation=?)`)
            .all("task", "active", "trial", "dispatch");
        for (const o of orphans) {
            const st = headStatus(o.content);
            if (!st || !NON_TERMINAL.includes(st))
                continue;
            // ★ 2026-09-16 修正：原为 `st === "pending" ? "ready" : st`，当头部是 in_progress 时直接把
            //   "in_progress" 写进 cards.status —— 但**卡片状态词汇表**是 ready/running/blocked/done/archived/
            //   cancelled（认领后为 running），"in_progress" 并非合法卡态：补建的卡会短暂处于非法状态、
            //   不在 running 泳道，且要等下一轮对账（5 分钟后）才被自我修正为 running。
            //   正解：复用文件顶部已定义的单一映射 EXPECT_CARD_OF（pending→ready / in_progress→running / blocked→blocked）。
            const cardStatus = EXPECT_CARD_OF[st] ?? st;
            const title = String(o.content ?? "").slice(0, 120) || `任务 #${o.id}`;
            const info = db
                .prepare(`INSERT INTO cards(board,kind,title,body,status,ref_kind,ref_id,priority,assignee) VALUES (?,?,?,?,?,?,?,?,?)`)
                .run("default", "task", title, "对账补建（C-5）", cardStatus, "memory", o.id, 3, headAssignee(o.content));
            const cid = Number(info.lastInsertRowid);
            db.prepare(`INSERT OR IGNORE INTO card_memory(card_id, memory_id, relation) VALUES (?,?,?)`).run(cid, o.id, "dispatch");
            db.prepare(`INSERT INTO card_events(card_id, actor, action, from_status, to_status, detail) VALUES (?,?,?,?,?,?)`).run(cid, "reconciler", "reconcile_created", null, cardStatus, `任务 #${o.id} 无卡，投影重建（C-5）`);
            out.created++;
        }
    }
    catch (e) {
        console.error(`[reconcile] 失败（不阻断）: ${e instanceof Error ? e.message : String(e)}`);
    }
    return out;
}
