/** T8：任务卡头解析共享常量（原 dashboard.js buildApp 局部；上移为叶子模块，保持单一真相源） */
export const TASK_HEAD_RE_STATES = "pending|in_progress|blocked|review|done|failed|cancelled";
export const TASK_HEAD_RE = new RegExp(`^\\[task\\]\\[assignee:[^\\]]*\\]\\[status:(${TASK_HEAD_RE_STATES}|open|claimed)\\]`);
export const TASK_NORMALIZE = { open: "pending", claimed: "in_progress", done: "done" };
export const TASK_DEP_RE = /\[depends:([0-9,\s]+)\]/;
export const TASK_BUCKETS = ["pending", "in_progress", "blocked", "review", "done", "failed", "cancelled"];
