/** T8：任务卡头解析共享常量（原 dashboard.js buildApp 局部；上移为叶子模块，保持单一真相源）
 *  ★ E-0 裁决（附录 G）落码：持久 6 态 {pending, in_progress, blocked, done, cancelled, merged}；
 *    archived 为记忆轴终态（列归档同步产物）；review/failed 已取消，仅在正则/归一表保留以消化存量头。 */
export const TASK_HEAD_RE_STATES = "pending|in_progress|blocked|review|done|failed|cancelled|merged|archived";
export const TASK_HEAD_RE = new RegExp(`^\\[task\\]\\[assignee:[^\\]]*\\]\\[status:(${TASK_HEAD_RE_STATES}|open|claimed)\\]`);
export const TASK_NORMALIZE = { open: "pending", claimed: "in_progress", done: "done", review: "in_progress", failed: "in_progress" };
export const TASK_DEP_RE = /\[depends:([0-9,\s]+)\]/;
export const TASK_BUCKETS = ["pending", "in_progress", "blocked", "done", "cancelled", "merged", "archived"];
