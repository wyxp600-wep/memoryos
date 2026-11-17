/**
 * ★ 2026-11-16（R02-04 / M-2）冒烟：A1 凭据门禁默认 fail-closed 的六组矩阵。
 *
 * 背景：`checkWriteCredential` 原为「默认软模式放行、只留痕」，部署忘设变量即失去归属保护。
 * 本套件在**硬模式**（MEMORYOS_A1_ENFORCE=1）下逐项验证，与 smoke-all 给既有套件注入的
 * 灰度软模式（=0）互不遮蔽：
 *   A. 无凭据 → 拒绝（fail-closed 核心）
 *   B. 他人凭据（agent 不匹配）→ 拒绝
 *   C. scope=read → 拒绝
 *   D. 已过期 → 拒绝
 *   E. 已撤销 → 拒绝（即使未过期）
 *   F. 合法写凭据 → 放行且返回 credId
 *   G. 灰度软模式（显式 =0）→ 无凭据放行（证明回滚路径仍可用，且必须显式）
 *   H. 默认值（变量未设置）→ 等同于硬模式（证明不是"只有 =1 才硬"）
 *
 * 用法：node dist/smoke-a1-hard.js（smoke-all 自动发现；本文件自设环境变量，不依赖外部注入）
 */
import { openDb } from "./db.js";
import { checkWriteCredential } from "./task-domain.js";
import { a1Hard } from "./a1-mode.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const dbPath = path.join(os.tmpdir(), `mem-a1-hard-${stamp}.db`);
let failed = 0;
function check(name, cond, detail = "") {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    if (!cond)
        failed++;
}
const nowIso = () => new Date().toISOString();
const plusMs = (ms) => new Date(Date.now() + ms).toISOString();
const minusMs = (ms) => new Date(Date.now() - ms).toISOString();

const db = openDb(dbPath);
const mkCtx = (agent, envCred = null) => ({
    db,
    agentName: () => agent,
    agentFpath: () => null,
    envCredential: () => envCred,
    isCredentialValid: (row) => Boolean(row) && !row.revoked_at && !(row.expires_at && row.expires_at <= nowIso()),
    nowIso,
});
const issue = (agent, scope, expiresAt, revokedAt = null) => {
    const cred = randomBytes(24).toString("hex");
    db.prepare(`INSERT INTO agent_credentials (agent, credential, scope, expires_at, revoked_at, session_id)
                VALUES (?,?,?,?,?,?)`).run(agent, cred, scope, expiresAt, revokedAt, "smoke-a1-hard");
    return cred;
};

const ORIGINAL = process.env.MEMORYOS_A1_ENFORCE;
try {
    // ── H：默认值（未设置）必须等同硬模式 ──
    delete process.env.MEMORYOS_A1_ENFORCE;
    check("H 默认（未设置）→ a1Hard()=true", a1Hard() === true, `a1Hard=${a1Hard()}`);
    let r = checkWriteCredential(mkCtx("trae"), "trae", null);
    check("H 默认无凭据 → 拒绝", r.ok === false, r.msg?.slice(0, 80));
    check("H 拒绝文案含回滚开关", String(r.msg).includes("MEMORYOS_A1_ENFORCE=0"));

    // ── A~F：硬模式矩阵 ──
    process.env.MEMORYOS_A1_ENFORCE = "1";
    check("硬模式 a1Hard()=true", a1Hard() === true);

    r = checkWriteCredential(mkCtx("trae"), "trae", null);
    check("A 无凭据 → 拒绝", r.ok === false && r.credId === null);

    const otherCred = issue("codex", "write", plusMs(3600_000));
    r = checkWriteCredential(mkCtx("trae"), "trae", otherCred);
    check("B 他人凭据 → 拒绝（不接受跨 agent 改写）", r.ok === false, r.msg?.slice(0, 60));

    const readCred = issue("trae", "read", plusMs(3600_000));
    r = checkWriteCredential(mkCtx("trae"), "trae", readCred);
    check("C scope=read → 拒绝", r.ok === false, r.msg?.slice(0, 60));

    const expiredCred = issue("trae", "write", minusMs(60_000));
    r = checkWriteCredential(mkCtx("trae"), "trae", expiredCred);
    check("D 已过期 → 拒绝", r.ok === false, r.msg?.slice(0, 60));

    const revokedCred = issue("trae", "write", plusMs(3600_000), nowIso());
    r = checkWriteCredential(mkCtx("trae"), "trae", revokedCred);
    check("E 已撤销（未过期）→ 拒绝", r.ok === false, r.msg?.slice(0, 60));

    const goodCred = issue("trae", "write", plusMs(3600_000));
    r = checkWriteCredential(mkCtx("trae"), "trae", goodCred);
    check("F 合法写凭据 → 放行且返回 credId", r.ok === true && r.credId != null, `credId=${r.credId}`);

    // 环境变量注入路径（MEMORYOS_A1_CREDENTIAL）同样要过校验，不能绕过 agent 归属
    r = checkWriteCredential(mkCtx("trae", goodCred), "trae", null);
    check("F2 env 注入合法凭据 → 放行", r.ok === true && r.credId != null);
    r = checkWriteCredential(mkCtx("codex", goodCred), "codex", null);
    check("B2 env 注入他人凭据 → 拒绝", r.ok === false);

    // ── G：灰度软模式必须显式 =0 ──
    process.env.MEMORYOS_A1_ENFORCE = "0";
    check("G 显式 =0 → a1Hard()=false", a1Hard() === false);
    r = checkWriteCredential(mkCtx("trae"), "trae", null);
    check("G 软模式无凭据 → 放行（credId=null）", r.ok === true && r.credId === null);

    // 非 "0" 的任意值都按硬模式处理（防拼写错误静默降级）
    process.env.MEMORYOS_A1_ENFORCE = "false";
    r = checkWriteCredential(mkCtx("trae"), "trae", null);
    check("I 非法值 'false' → 仍按硬模式拒绝", r.ok === false && a1Hard() === true);
} finally {
    if (ORIGINAL === undefined) delete process.env.MEMORYOS_A1_ENFORCE;
    else process.env.MEMORYOS_A1_ENFORCE = ORIGINAL;
    try { db.close(); } catch { /* 已关闭 */ }
    try { fs.rmSync(dbPath, { force: true }); } catch { /* Windows 句柄未释放时留临时文件 */ }
}

console.log(`\n== A1 硬模式矩阵：${failed ? `${failed} FAIL` : "全部 PASS"} ==`);
process.exit(failed ? 1 : 0);
