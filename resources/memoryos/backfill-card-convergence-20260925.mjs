/** ★ 2026-09-25 方案C（一次性回填）：任务看板僵尸卡收敛 + 嵌套任务头修复。
 *  背景：A（写时收敛 hook）上线前的存量脏数据 ——
 *   ① 开放态卡（triage/todo/ready/blocked）但关联记忆已 archived/merged/rejected 或任务头已 done；
 *   ② 记忆外层头 [status:pending] 但正文内层嵌套任务记录全为 [status:done]（UI 误粘脏头）。
 *  用法：node backfill-card-convergence-20260925.mjs [--dry-run]
 *  DB：默认 %APPDATA%/MemoryOS/data/memory.db（桌面 app 运行库；可用 MEMORY_DB 覆盖）。
 *  幂等：①走 db.convergeLinkedCards 状态守卫（已终态卡跳过）；②仅匹配「外层 pending 且全文无第二个 pending」，修复后二次跑恒 0。 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.MEMORY_DB ? resolve(process.env.MEMORY_DB) : resolve(process.env.APPDATA ?? "", "MemoryOS", "data", "memory.db");
const dryRun = process.argv.includes("--dry-run");
import { DatabaseSync } from "node:sqlite"; // 与 dist/db.js 同引擎（零原生依赖）
const { updateMemory, convergeLinkedCards, setCardEvtPusher } = await import("./dist/db.js");

const db = new DatabaseSync(dbPath); // 运行库已是 WAL，无需切
setCardEvtPusher(null); // 脚本进程无 SSE，仅落库（看板跨进程 2s 轮询补流会拾到）
console.log(`DB: ${dbPath}  dry-run=${dryRun}`);

// ① 卡侧收敛
const OPEN = ["triage", "todo", "ready", "blocked"];
const ph = OPEN.map(() => "?").join(",");
const zombies = db
  .prepare(
    `SELECT c.id AS card, c.status AS cstat, cm.memory_id AS mem, m.status AS mem_status
     FROM cards c JOIN card_memory cm ON cm.card_id = c.id JOIN memories m ON m.id = cm.memory_id
     WHERE c.status IN (${ph})
       AND (m.status IN ('archived','merged','rejected')
            OR (m.type='task' AND m.status='active' AND m.content LIKE '%[status:done]%'))`,
  )
    .all(...OPEN);
console.log(`\n① 开放态且记忆已终态/头done 的卡：${zombies.length} 张`);
let convCards = 0;
const seenMem = new Set();
for (const z of zombies) {
  const target = z.mem_status === "active" ? "done" : "archived";
  if (dryRun) {
    console.log(`   [dry] 卡 #${z.card}(${z.cstat}) ← 记忆 #${z.mem}(${z.mem_status}) → ${target}`);
    continue;
  }
  const n = convergeLinkedCards(db, z.mem, target, "backfill-20260925", `一次性回填：记忆 #${z.mem} 已 ${z.mem_status}${z.mem_status === "active" ? "/头done" : ""}，卡滞留 ${z.cstat}`);
  if (n > 0) { convCards += n; console.log(`   卡收敛 ${n} 张（记忆 #${z.mem} → ${target}）`); }
  seenMem.add(z.mem);
}
if (!dryRun) console.log(`   实际收敛：${convCards} 张`);

// ② 嵌套头修复：外层 pending + 全文除头外无其它 pending + 内层有 done → 外层改 done
const all = db.prepare(`SELECT id, content, version FROM memories WHERE type='task' AND status='active'`).all();
const fixable = all.filter((m) => {
  const c = String(m.content ?? "");
  const hm = c.match(/^\[task\]\[assignee:[^\]]*\]\[status:([a-z_]+)\]/);
  if (!hm || hm[1] !== "pending") return false;
  const body = c.slice(hm[0].length); // 头之后
  return body.includes("[status:done]") && !body.includes("[status:pending]");
});
console.log(`\n② 嵌套头修复候选（外层 pending、内层全 done）：${fixable.length} 条`);
for (const m of fixable) {
  if (dryRun) {
    console.log(`   [dry] 记忆 #${m.id} 外层头 pending → done`);
    continue;
  }
  const newContent = m.content.replace(/^(\[task\]\[assignee:[^\]]*\]\[status:)[a-z_]+(\])/, "$1done$2");
  try {
    const r = updateMemory(db, m.id, { content: newContent, expectedVersion: m.version });
    console.log(`   记忆 #${m.id} 外层头 pending → done（${JSON.stringify(r).slice(0, 80)}）`);
  } catch (e) {
    console.log(`   记忆 #${m.id} CAS 让位/失败：${e.message}`);
  }
}
console.log(`\n完成。${dryRun ? "（dry-run，未落库）" : "已落库；A hook 需重启 app 生效。"}`);
