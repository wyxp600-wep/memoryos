/**
 * MemoryOS — 记忆序列化单一真源（WYSIWYG / 所见即所得）
 *
 * 背景：AI 侧（dist/server.js 的 MCP 工具）与用户侧（dist/dashboard.js 的 /api/all + 前端渲染）
 * 原先各自拼装记忆文本，规则不一致（AI 侧空白折叠 + 220/120 字裁剪、字段更少、过滤更严），
 * 导致「用户看到的记忆」≠「AI 收到的记忆」。
 *
 * 本模块把「一行记忆怎么变成 AI 上下文里的文本」收敛为唯一实现：
 *   - server.js：memory_search / memory_context / memory_read 三处输出（模板逐字未变）
 *   - dashboard.js：/api/all 每行附带 ai.* 视图（同一函数产出，只读派生，不落库）
 *   - 前端：直接展示 ai.*，用户所见即 AI 所得
 *
 * 约束：纯读时格式化 —— 不写库、不改存储结构、不影响现有读写流程。
 */
/** memory_search 正文裁剪上限（字） */
export const CLIP_SEARCH = 220;
/** memory_context 正文裁剪上限（字） */
export const CLIP_CONTEXT = 120;
/** 检索层有效度门槛：eff <= 该值的记忆不进 AI 检索结果（search.js 同规则） */
export const EFF_FLOOR = 0.15;
/** 空白折叠：换行/连续空白压成单空格（与 AI 侧历史行为逐字一致，故意不 trim） */
export function normContent(s) {
    return String(s ?? "").replace(/\s+/g, " ");
}
/** 折叠后按上限裁剪 */
export function clipText(s, n) {
    const t = normContent(s);
    return t.length > n ? t.slice(0, n) : t;
}
function conf2(v) {
    return Number(v ?? 0).toFixed(2);
}
function hitCount(r) {
    return r.hit_count ?? r.hits ?? 0;
}
/** memory_search 命中行：`#id [type|agent|YYYY-MM-DD](conf=x.xx) 正文(≤220)` */
export function fmtSearchLine(r) {
    return `#${r.id} [${r.type}|${r.agent}|${String(r.created_at ?? "").slice(0, 10)}](conf=${conf2(r.confidence)}) ${clipText(r.content, CLIP_SEARCH)}`;
}
/** memory_context 注入行：无 focus 时带 cited/hit，带 focus 时省略这两项 */
export function fmtContextLine(r, opts = {}) {
    const focus = !!opts.focus;
    return `#${r.id} [${r.type}|${r.agent}]${focus ? "" : ` cited=${r.cited ?? 0} hit=${hitCount(r)}`} conf=${conf2(r.confidence)}: ${clipText(r.content, CLIP_CONTEXT)}`;
}
/** memory_read 全文视图：`#id [type|agent|project] conf=… status=… 创建=…` + 完整正文（不裁剪） */
export function fmtReadLine(r) {
    return (`#${r.id} [${r.type}|${r.agent}|${r.project}] conf=${conf2(r.confidence)} status=${r.status} 创建=${String(r.created_at ?? "").slice(0, 10)}\n` +
        `完整正文（${String(r.content ?? "").length} 字）：\n${r.content}`);
}
/**
 * 一条记忆在 AI 侧三种通道的完整视图 + 裁剪/隐藏字数。
 * 用户侧直接展示这些字符串，即等于 AI 收到的原文。
 */
export function aiViews(r) {
    const normLen = normContent(r.content).length;
    return {
        search: fmtSearchLine(r),
        context: fmtContextLine(r, { focus: false }),
        context_focus: fmtContextLine(r, { focus: true }),
        read: fmtReadLine(r),
        rawLen: String(r.content ?? "").length,
        normLen,
        clip_search: CLIP_SEARCH,
        clip_context: CLIP_CONTEXT,
        searchClipped: normLen > CLIP_SEARCH,
        contextClipped: normLen > CLIP_CONTEXT,
        searchHidden: Math.max(0, normLen - CLIP_SEARCH),
        contextHidden: Math.max(0, normLen - CLIP_CONTEXT),
    };
}
/**
 * AI 检索可见性：hybridSearch 只返回 status='active' 且 eff>0.15 的记忆；
 * memory_read 按 id 读取不受此限制（可显式读全文）。
 */
export function aiVisible(r) {
    const status = r.status ?? "unknown";
    const eff = Number(r.eff ?? r.eff_confidence ?? r.confidence ?? 0);
    const searchable = status === "active" && eff > EFF_FLOOR;
    let reason = "";
    if (!searchable) {
        reason = status !== "active"
            ? `status=${status}（AI 检索仅返回 active）`
            : `eff=${eff.toFixed(2)} ≤ ${EFF_FLOOR}（低于有效度门槛，检索层过滤）`;
    }
    return { searchable, eff, floor: EFF_FLOOR, reason };
}
