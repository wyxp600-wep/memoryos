/**
 * ★ 2026-11-16（R02-04 / M-2）：A1 凭据门禁模式的单一真相源。
 *
 * 背景：原实现 `process.env.MEMORYOS_A1_ENFORCE === "1"` 只在显式开启时生效，
 *   默认是"软模式放行且只留痕"——部署时若忘记设置变量，任何 agent 都能无凭据改写任务归属
 *   （认领/释放/完成/接管），安全默认值方向错误。
 *
 * 现口径（fail-closed）：
 *   · 未设置 / =1 / 任何其他值 → 硬模式（拒绝无凭据敏感写）；
 *   · 仅显式 MEMORYOS_A1_ENFORCE=0 → 旧软模式（不拒绝，仅事件留痕 cred_id=null）。
 *
 * 兼容策略：受管客户端须先用 `node dist/a1-bootstrap.js <agent>` 签发凭据并注入
 *   MEMORYOS_A1_CREDENTIAL，再升级内核；测试套件由 smoke-all 显式注入 =0，
 *   硬模式矩阵由 smoke-a1-hard.js 单独覆盖（不靠放宽生产口径换全绿）。
 */
export function a1Hard() {
    return process.env.MEMORYOS_A1_ENFORCE !== "0";
}

/** 凭据行有效性三态（未撤销 / 未过期）：server-tools.js 与硬模式冒烟共用同一判据，避免两处口径漂移。 */
export function isCredentialRowValid(row, nowIso = new Date().toISOString()) {
    if (!row) return false;
    if (row.revoked_at) return false;
    if (row.expires_at && row.expires_at <= nowIso) return false;
    return true;
}

/** 硬模式下的统一拒绝提示后缀（告诉调用方怎么恢复，而不是只说"被拒"）。 */
export const A1_HINT = "如需临时恢复旧软模式，显式设置 MEMORYOS_A1_ENFORCE=0（不推荐，仅限灰度回滚）；受管客户端请先 node dist/a1-bootstrap.js <agent> 签发凭据并注入 MEMORYOS_A1_CREDENTIAL。";
