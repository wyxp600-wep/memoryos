/**
 * 第二批·第 5 步冒烟：验收标准 / 交接进度 / 防重复发布（三条 P0）
 *
 * 覆盖（全部走领域层真实代码，不手工造字符串）：
 *   A. acceptance：发布写入头段 → 卡 body / 卡 API / task_next / REST 看板四处同口径可见
 *   B. task_done：缺项拒绝 / fail 拒绝 / na 无理由拒绝 / 全过通过且回执写明哪几条过了
 *   C. progress：提交(done)/释放(release)/换手(租约回收) 三种情况下都留摘要，接手方直接可见
 *   D. 防重复发布：撞范围拒绝、撞验收拒绝、仅标题相似只提示、force=true 强制发布
 *   E. 回归：不带验收标准的老任务，task_done 行为不变
 *
 * 用法：node dist/smoke-task-accept.js（smoke-all 自动发现）
 */
import { openDb, readMemory } from "./db.js";
import {
    assignTaskDomain, claimTaskDomain, releaseTaskDomain, doneTaskDomain,
    readTaskState, taskBody, acceptanceOf, progressOf, parseTaskRows,
    nextTasks, renderTaskNextText,
} from "./task-domain.js";
import { createCardsDomain } from "./cards-domain.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const dbPath = path.join(os.tmpdir(), `mem-task-accept-${Date.now()}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
const nowIso = () => new Date().toISOString();
const ctx = {
    db: null,
    agentName: () => "trae",
    agentFpath: () => null,
    envCredential: () => null,
    isCredentialValid: () => true,
    nowIso,
    requestAbortSignal: () => null,
    killTree: () => { },
    readTaskState,
    taskBody,
};

try {
    const db = openDb(dbPath);
    ctx.db = db;

    /* ── A. 发布带验收 + 进度的任务 ── */
    const a = await assignTaskDomain(ctx, {
        content: "改任务卡：验收与进度可见", assignee: "trae", project: "global",
        scope: "resources/memoryos/dist", acceptance: ["A 能点击", "B 返回 200 且响应含特征串"],
        progress: "已定位到 task-domain.js，下一步补 schema",
    });
    check("A1. assign 回执标注验收条数", a.includes("验收 2 条"), a.slice(0, 120));
    const aId = Number(a.match(/#(\d+)/)?.[1]);
    const aSt = readTaskState(readMemory(db, aId).content);
    check("A2. 头段 accept 解析回两条", aSt?.acceptance?.length === 2 && aSt.acceptance[0] === "A 能点击", JSON.stringify(aSt?.acceptance));
    check("A3. 头段 progress 落库", aSt?.progress === "已定位到 task-domain.js，下一步补 schema", String(aSt?.progress));
    const aCard = db.prepare(`SELECT id, body FROM cards WHERE ref_kind='memory' AND ref_id=?`).get(aId);
    check("A4. 卡 body 显示验收与进度", !!aCard && aCard.body.includes("验收（2 条）") && aCard.body.includes("进度摘要："), String(aCard?.body ?? "").slice(0, 120));
    const cardsApi = createCardsDomain({ db });
    const cardRow = cardsApi.cardRowOf(db.prepare(`SELECT * FROM cards WHERE id=?`).get(Number(aCard.id)));
    check("A5. 卡 API 结构化字段同源", cardRow.acceptance.length === 2 && cardRow.acceptance_text.includes("验收（2 条）") && cardRow.progress === aSt.progress, JSON.stringify({ a: cardRow.acceptance, p: cardRow.progress }));
    const nextTxt = renderTaskNextText(nextTasks(ctx, { project: "global" }));
    check("A6. task_next 显示验收与进度", nextTxt.includes("验收（2 条）") && nextTxt.includes("进度摘要：已定位到"), nextTxt.split("\n").find((l) => l.includes(`#${aId}`)) ?? "");
    const boardRow = parseTaskRows(db, { limit: 50 }).find((r) => r.id === aId);
    check("A7. 看板结构化字段 + 正文不混入头段", !!boardRow && boardRow.acceptance.length === 2 && boardRow.progress === aSt.progress && !boardRow.body.includes("[accept:"), JSON.stringify({ acc: boardRow?.acceptance?.length, p: boardRow?.progress }));

    /* ── B. task_done 逐条对照 ── */
    const claimA = await claimTaskDomain(ctx, { memory_id: aId, project: "global" });
    check("B0. 认领回执展示验收清单", claimA.includes("验收（2 条）"), claimA.split("\n")[0].slice(0, 120));
    const dNo = await doneTaskDomain(ctx, { memory_id: aId, conclusion: "做完了" });
    check("B1. 未逐条确认 → 拒绝 done", dNo.includes("验收未逐条通过") && dNo.includes("未确认：第 1 条"), dNo.slice(0, 160));
    check("B1b. 拒绝后状态仍 in_progress", readTaskState(readMemory(db, aId).content)?.status === "in_progress");
    const dNa = await doneTaskDomain(ctx, { memory_id: aId, conclusion: "做完了", acceptance_results: [{ item: 1, result: "pass" }, { item: 2, result: "na" }] });
    check("B2. na 无理由 → 拒绝", dNa.includes("必须带 note"), dNa.slice(0, 160));
    const dFail = await doneTaskDomain(ctx, { memory_id: aId, conclusion: "做完了", acceptance_results: [{ item: 1, result: "fail" }, { item: 2, result: "pass" }] });
    check("B3. 有 fail → 拒绝并点名没过", dFail.includes("没过：第 1 条"), dFail.slice(0, 160));
    const dOk = await doneTaskDomain(ctx, {
        memory_id: aId, conclusion: "验收完成，卡与 task_next 都能看到",
        acceptance_results: [{ item: 1, result: "pass" }, { item: 2, result: "na", note: "本轮不含 HTTP 接口" }],
    });
    check("B4. 全过/na带理由 → 允许 done", dOk.includes("已标记 done") || dOk.includes("task_done"), dOk.slice(0, 160));
    check("B5. 回执写明哪几条过/不适用", dOk.includes("验收：第 1 条 过；第 2 条 不适用（本轮不含 HTTP 接口）"), dOk.slice(0, 200));
    check("B6. 回执结构化列出通过/不适用", dOk.includes("acceptance_passed") && dOk.includes("acceptance_na"), dOk.slice(-160));
    check("B7. 完成后状态 done 且头段保留验收", readTaskState(readMemory(db, aId).content)?.status === "done" && readTaskState(readMemory(db, aId).content).acceptance.length === 2);

    /* ── C. 释放留进度摘要（同一套格式） ── */
    const c = await assignTaskDomain(ctx, { content: "整理看板排序", assignee: "trae", project: "global" });
    const cId = Number(c.match(/#(\d+)/)?.[1]);
    await claimTaskDomain(ctx, { memory_id: cId, project: "global" });
    const rel = await releaseTaskDomain(ctx, { memory_id: cId, reason: "被更高优先级打断", progress: "已改一半排序逻辑，未跑测试" });
    check("C1. 释放回执带进度摘要", rel.includes("进度摘要：已改一半排序逻辑，未跑测试"), rel.slice(0, 160));
    check("C2. 释放后头段保留摘要", readTaskState(readMemory(db, cId).content)?.progress === "已改一半排序逻辑，未跑测试");
    const cCard = cardsApi.cardRowOf(db.prepare(`SELECT * FROM cards WHERE id=(SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1)`).get(cId));
    check("C3. 卡 API 直接看到释放后的摘要", cCard.progress === "已改一半排序逻辑，未跑测试", String(cCard.progress));
    const claimC = await claimTaskDomain(ctx, { memory_id: cId, project: "global" });
    check("C5. 接手方认领回执看到前手摘要", claimC.includes("进度摘要：已改一半排序逻辑，未跑测试"), claimC.split("\n")[0].slice(0, 160));
    const rel2 = await releaseTaskDomain(ctx, { memory_id: cId, reason: "临时让路给线上故障" });
    check("C4. 未传 progress 时沿用旧摘要（不被清空）", rel2.includes("进度摘要：已改一半排序逻辑"), rel2.slice(0, 160));

    /* ── D. 防重复发布 ── */
    const base = await assignTaskDomain(ctx, { content: "补充登录接口限流", assignee: "trae", project: "global", scope: "src/api", acceptance: ["压测 QPS 达标"] });
    const baseId = Number(base.match(/#(\d+)/)?.[1]);
    const dupScope = await assignTaskDomain(ctx, { content: "给登录接口加限流", assignee: "codex", project: "global", scope: "src/api/login", acceptance: ["压测 QPS 达标"] });
    check("D1. 撞范围 → 拒绝并点名编号与撞点", dupScope.includes("possible duplicate") && dupScope.includes(`#${baseId}`) && dupScope.includes("范围重叠"), dupScope.slice(0, 160));
    const dupAcc = await assignTaskDomain(ctx, { content: "补充订单接口日志", assignee: "codex", project: "global", scope: "src/order", acceptance: ["压测 QPS 达标"] });
    check("D2. 撞验收条件 → 拒绝并点名第几条", dupAcc.includes("同一验收条件") && dupAcc.includes(`#${baseId}`), dupAcc.slice(0, 160));
    const dupTitle = await assignTaskDomain(ctx, { content: "补充登录接口限流", assignee: "codex", project: "global", scope: "src/web", acceptance: ["按钮可点击"] });
    check("D3. 仅标题相似 → 提示但不阻挡", dupTitle.includes("已分派任务") && dupTitle.includes("提示：与") && dupTitle.includes("不阻挡"), dupTitle.slice(0, 200));
    const force = await assignTaskDomain(ctx, { content: "给登录接口加限流（拆分版）", assignee: "codex", project: "global", scope: "src/api/login", acceptance: ["压测 QPS 达标"], force: true });
    check("D4. force=true → 强制发布且回执点名", force.includes("已分派任务") && force.includes("已强制发布") && force.includes(`#${baseId}`), force.slice(0, 200));
    /* ★ #700057：通用验收句（测试全绿/控制台 0 报错/有回滚说明）不得当成实质重复——审核曾被这类句子误拦两次 */
    await assignTaskDomain(ctx, { content: "订单导出加校验", assignee: "trae", project: "global", scope: "src/export", acceptance: ["测试全绿", "控制台 0 报错"] });
    const genDup = await assignTaskDomain(ctx, { content: "库存同步补重试", assignee: "codex", project: "global", scope: "src/stock", acceptance: ["测试全绿", "有回滚说明"] });
    check("D5. 只有通用验收句重合 → 不拦（照常发布）", genDup.includes("已分派任务") && !genDup.includes("possible duplicate"), genDup.slice(0, 160));
    check("D6. 命中回执回显相似度数值（范围/标题）", /范围重叠 0\.67/.test(dupScope) && /标题相似度 1\.00/.test(dupTitle), dupScope.slice(0, 160) + " | " + dupTitle.slice(0, 120));

    /* ── G. 工作证归还（#700057）：还给原主 / 显式未指派 / 越权拒绝 ── */
    const withAgent = async (name, fn) => { const old = ctx.agentName; ctx.agentName = () => name; try { return await fn(); } finally { ctx.agentName = old; } };
    const cardAssigneeOf = (mid) => db.prepare(`SELECT assignee FROM cards WHERE id=(SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1)`).get(mid)?.assignee ?? null;
    // G1-G5：AI 领了别人的过期任务 → 归还时自动退回原主（旧实现根本没有这个能力）
    const g = await assignTaskDomain(ctx, { content: "重构导出模块", assignee: "claude", project: "global", acceptance: ["导出字段对齐"] });
    const gId = Number(g.match(/#(\d+)/)?.[1]);
    const gClaim = await withAgent("claude", () => claimTaskDomain(ctx, { memory_id: gId, project: "global" }));
    check("G1. 原主 claude 正常认领", gClaim.includes("已认领任务") && readTaskState(readMemory(db, gId).content)?.assignee === "claude", gClaim.split("\n")[0].slice(0, 120));
    db.prepare(`UPDATE dispatches SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes') WHERE memory_id=? AND state IN ('active','stale')`).run(gId);
    db.prepare(`UPDATE cards SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes') WHERE id=(SELECT card_id FROM card_memory WHERE memory_id=? AND relation='dispatch' LIMIT 1)`).run(gId);
    const gReclaim = await claimTaskDomain(ctx, { memory_id: gId, project: "global" });
    check("G2. 租约过期 → 他人（trae）回收成功", gReclaim.includes("接手") && readTaskState(readMemory(db, gId).content)?.assignee === "trae", gReclaim.split("\n")[0].slice(0, 160));
    const gRel = await releaseTaskDomain(ctx, { memory_id: gId, reason: "误领，归还原主", progress: "只读了代码" });
    const gSt = readTaskState(readMemory(db, gId).content);
    check("G3. 未传 assignee_to → 自动归还原主 claude", gSt?.status === "pending" && gSt?.assignee === "claude" && gRel.includes("归还原主 claude"), gRel.slice(0, 160));
    const gBoard = parseTaskRows(db, { limit: 50 }).find((r) => r.id === gId);
    check("G4. 归还后 头/看板/卡片 负责人一致", gBoard?.assignee === "claude" && cardAssigneeOf(gId) === "claude", JSON.stringify({ head: gSt?.assignee, board: gBoard?.assignee, card: cardAssigneeOf(gId) }));
    const gEv = db.prepare(`SELECT payload FROM memory_events WHERE memory_id=? AND op='task_release' ORDER BY id DESC LIMIT 1`).get(gId);
    const gP = JSON.parse(gEv?.payload ?? "{}");
    check("G5. 归还事件流留痕 from/to/restored", gP.assignee_from === "trae" && gP.assignee_to === "claude" && gP.restored_owner === "claude", JSON.stringify(gP).slice(0, 160));
    const gForeign = await claimTaskDomain(ctx, { memory_id: gId, project: "global" });
    check("G6. 还给原主后他人领不到（归属生效）", gForeign.includes("指派给 claude"), gForeign.slice(0, 140));
    const gBack = await withAgent("claude", () => claimTaskDomain(ctx, { memory_id: gId, project: "global" }));
    check("G7. 原主可直接再领", gBack.includes("已认领任务") && readTaskState(readMemory(db, gId).content)?.assignee === "claude", gBack.split("\n")[0].slice(0, 120));
    // G8：显式退回「未指派」
    const h = await assignTaskDomain(ctx, { content: "临时排查内存泄漏", assignee: "trae", project: "global" });
    const hId = Number(h.match(/#(\d+)/)?.[1]);
    await claimTaskDomain(ctx, { memory_id: hId, project: "global" });
    const hRel = await releaseTaskDomain(ctx, { memory_id: hId, assignee_to: "?", reason: "不做了，退回池子" });
    const hSt = readTaskState(readMemory(db, hId).content);
    const hBoard = parseTaskRows(db, { limit: 50 }).find((r) => r.id === hId);
    check("G8. assignee_to=? → 明确回到未指派（头/看板/卡）", hSt?.assignee === "?" && hBoard?.assignee === "?" && cardAssigneeOf(hId) === null && hRel.includes("未指派"), hRel.slice(0, 160));
    // G9：越权拒绝——他人不得替认领者归还
    const i = await assignTaskDomain(ctx, { content: "复核结算口径", assignee: "trae", project: "global" });
    const iId = Number(i.match(/#(\d+)/)?.[1]);
    await claimTaskDomain(ctx, { memory_id: iId, project: "global" });
    const iRel = await withAgent("zcode", () => releaseTaskDomain(ctx, { memory_id: iId, reason: "越权试探" }));
    const iSt = readTaskState(readMemory(db, iId).content);
    check("G9. 越权归还被拒且任务原样在办", iRel.includes("你不是认领者") && iSt?.status === "in_progress" && iSt?.assignee === "trae", iRel.slice(0, 160));
    // G10：显式写回指定 agent（acceptance① 的「可写回指定 agent」，非仅未指派）
    const j = await assignTaskDomain(ctx, { content: "补齐对账导出", assignee: "trae", project: "global" });
    const jId = Number(j.match(/#(\d+)/)?.[1]);
    await claimTaskDomain(ctx, { memory_id: jId, project: "global" });
    const jRel = await releaseTaskDomain(ctx, { memory_id: jId, assignee_to: "codex", reason: "这块归 codex" });
    const jSt = readTaskState(readMemory(db, jId).content);
    const jBoard = parseTaskRows(db, { limit: 50 }).find((r) => r.id === jId);
    check("G10. assignee_to=codex → 指定 agent 接手（头/看板/卡一致）", jSt?.assignee === "codex" && jBoard?.assignee === "codex" && cardAssigneeOf(jId) === "codex" && jRel.includes("写回 codex"), jRel.slice(0, 160));

    /* ── E. 回归：无验收标准的老任务 ── */
    const e = await assignTaskDomain(ctx, { content: "无验收的老式任务", assignee: "trae", project: "global" });
    const eId = Number(e.match(/#(\d+)/)?.[1]);
    await claimTaskDomain(ctx, { memory_id: eId, project: "global" });
    const eDone = await doneTaskDomain(ctx, { memory_id: eId, conclusion: "老流程照旧" });
    check("E1. 未声明验收 → done 不被新规则拦截", eDone.includes("已标记 done") || eDone.includes("task_done"), eDone.slice(0, 160));
    check("E2. 无验收任务头段不出现空 accept", acceptanceOf(readMemory(db, eId).content.replace(/\n[\s\S]*/, "")).length === 0);

    /* ── F. 解析器边界 ── */
    const headOnly = "[task][assignee:x][status:pending] [accept:甲|乙] [progress:半路] 正文 [accept:伪造]";
    check("F1. 只认头行（正文里的 [accept:] 不算）", acceptanceOf(headOnly.split("\n")[0]).length === 2 && taskBody(headOnly).includes("[accept:伪造]"));
    const over = await assignTaskDomain(ctx, { content: "验收超限", assignee: "trae", project: "global", acceptance: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] });
    check("F2. 超过 8 条 → 拒绝", over.includes("最多 8 条"), over.slice(0, 120));
    const prog = readTaskState("[task][assignee:x][status:pending] [progress:" + "长".repeat(200) + "] x");
    check("F3. 进度摘要超长被截断到 120", prog?.progress?.length === 120, String(prog?.progress?.length));

    try { fs.unlinkSync(dbPath); } catch { }
    try { fs.rmSync(dbPath + "-wal", { force: true }); fs.rmSync(dbPath + "-shm", { force: true }); } catch { }
} catch (e) {
    console.log(`FAIL  冒烟异常：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    failed++;
}
console.log(`\n== smoke-task-accept：${failed === 0 ? "全部 PASS" : failed + " 项 FAIL"} ==`);
process.exit(failed === 0 ? 0 : 1);
