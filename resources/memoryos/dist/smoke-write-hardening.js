/**
 * 第 6 步（2026-11-05）写入面硬化回归：
 * ① 被拒写入留审计 ② 状态整值 ③ 正文 6000 上限 ④ 降级写入提示 ⑤ 首写提示降噪
 * ⑦ 去重口径描述 ⑧ project 归一 ⑨ [task] 头收紧
 * 口径：隔离临时库 + 真实工具定义；不碰生产库。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.EMBED_MODE = 'api';                                  // ④ 降级路径：指向不可达端点，必然走 embedFailed
process.env.EMBED_API_URL = 'http://127.0.0.1:1/v1/embeddings';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'write-hardening-'));
process.env.MEMORY_DB = path.join(tmp, 'test.db');
const { openDb } = await import('./db.js');
const { registerMemoryTools } = await import('./server-reg-memory.js');
const { memoryBodyErrors, MEMORY_BODY_MAX_CHARS, MEMORY_BODY_TEMPLATE } = await import('./memory-body.js');
const { bodyFixture } = await import('./memory-body-fixture.js');
let n = 0;
const check = (name, ok, extra = '') => { assert.ok(ok, `${name} ${extra}`); n++; console.log(`通过 ${name}`); };

/* ── ② 状态严格整值 ───────────────────────────────────────────── */
const valid = bodyFixture('状态整值探针 用于确认三值判定');
check('状态：单一合法值通过', !memoryBodyErrors(valid).length);
check('状态：「待验证/已验证」混写被拒并点名',
    memoryBodyErrors(valid.replace('待验证', '待验证/已验证')).some((s) => /只写一个状态值/.test(s)));
check('状态：「⚠ 待验证」前置词被拒',
    memoryBodyErrors(valid.replace('待验证', '⚠ 待验证')).some((s) => /不接受前置词/.test(s)));
check('状态：「待验证中」后缀词被拒',
    memoryBodyErrors(valid.replace('待验证', '待验证中')).some((s) => /值后须紧接分隔标点/.test(s)));
check('状态：值后自然语言描述不误伤',
    !memoryBodyErrors(valid.replace('待验证', '已验证，仅隔离副本已完成')).length);

/* ── ③ 正文 6000 上限：拒绝并报字数，不截断 ─────────────────────── */
function bodyOfLength(target) {
    const tpl = bodyFixture('长度探针');
    const cut = tpl.indexOf('依据：\n') + 4;
    const tail = tpl.indexOf('\n\n行动：');
    const filler = Math.max(1, target - cut - (tpl.length - tail));
    return tpl.slice(0, cut) + 'a'.repeat(filler) + tpl.slice(tail);
}
const atLimit = bodyOfLength(MEMORY_BODY_MAX_CHARS);
check(`正文：恰好 ${MEMORY_BODY_MAX_CHARS} 字通过`, atLimit.length === MEMORY_BODY_MAX_CHARS && !memoryBodyErrors(atLimit).length, `len=${atLimit.length}`);
const overLimit = bodyOfLength(MEMORY_BODY_MAX_CHARS + 1);
const overErrs = memoryBodyErrors(overLimit);
check('正文：超 1 字被拒且报「当前字数 / 上限」',
    overErrs.length === 1 && overErrs[0].includes(`当前 ${MEMORY_BODY_MAX_CHARS + 1} 字`) && overErrs[0].includes(`上限 ${MEMORY_BODY_MAX_CHARS} 字`),
    overErrs[0] ?? '');
check('正文：超限时不静默截断（原串未被改写）', overLimit.length === MEMORY_BODY_MAX_CHARS + 1);

/* ── 工具面 ───────────────────────────────────────────────────── */
const db = openDb(process.env.MEMORY_DB);
const tools = new Map();
const ctx = { db, stateReceipt: () => '', runTaskTx: (_d, fn) => { fn(); return null; }, isCredentialValid: () => true, nowIso: () => new Date().toISOString(), plusHoursIso: () => new Date().toISOString() };
registerMemoryTools({ addTool: (t) => tools.set(t.name, t) }, ctx);
const T = (name) => tools.get(name);
const run = async (name, raw) => T(name).execute(T(name).parameters.parse(raw));

/* ── ① 被拒写入留审计 ─────────────────────────────────────────── */
const rejectedRaw = '旧散文：没有六字段，token=sk-live-abcdef123456 不该被存';
const rejected = await run('memory_write', { content: rejectedRaw, project: 'test' });
check('审计：不合规写入被拒（isError）', rejected?.isError === true && rejected.content?.[0]?.text?.includes('未写入'), JSON.stringify(rejected).slice(0, 120));
const auditRows = db.prepare('SELECT * FROM memory_write_rejections ORDER BY id DESC').all();
check('审计：落了一行记录', auditRows.length === 1, `rows=${auditRows.length}`);
const au = auditRows[0] ?? {};
check('审计：记录谁/何时/原因/字数', !!au.agent && !!au.created_at && /第1个字段/.test(au.reason ?? '') && au.content_len === rejectedRaw.length, `agent=${au.agent} len=${au.content_len}`);
check('审计：只存摘要不存全文', (au.content_digest ?? '').length <= 81 && au.content_digest !== rejectedRaw, `digest=${au.content_digest}`);
check('审计：敏感串已脱敏', !/sk-live-abcdef123456/.test(au.content_digest ?? ''), au.content_digest);
const rejectsMsg = await run('memory_admin', { action: 'rejects', limit: 5 });
check('审计：memory_admin(action=rejects) 可查', /被拒写入/.test(rejectsMsg) && /原因：/.test(rejectsMsg), rejectsMsg.slice(0, 100));

/* ── ④/⑤ 降级写入回执 + 首写提示降噪 ─────────────────────────── */
const first = await run('memory_write', { content: valid, project: 'test' });
const firstText = first.content?.[0]?.text ?? String(first);
check('降级：回执写明「暂未生成检索向量」', /暂未生成检索向量/.test(firstText), firstText.replace(/\s+/g, ' ').slice(0, 120));
check('降级：回执给出补算触发方式', /daemon/.test(firstText) && /--once/.test(firstText));
check('首写：全新 agent 第一次写入不提示「未调用 memory_search」', !/未调用 memory_search/.test(firstText));
const second = await run('memory_write', { content: bodyFixture('首写降噪探针 第二条'), project: 'test' });
const secondText = second.content?.[0]?.text ?? String(second);
check('首写：已有历史写入时才提示', /未调用 memory_search/.test(secondText), secondText.replace(/\s+/g, ' ').slice(-100));

/* ── ⑧ project 归一 ───────────────────────────────────────────── */
const proj = await run('memory_write', { content: bodyFixture('scope 归一探针 大小写分裂'), project: ' MemoryOS ' });
const projText = proj.content?.[0]?.text ?? String(proj);
check('归一：回执保留原始写法并提示归一', /scope 已归一：MemoryOS → memoryos/.test(projText), projText.replace(/\s+/g, ' ').slice(-120));
const projRow = db.prepare(`SELECT project FROM memories WHERE content LIKE '%scope 归一探针%' ORDER BY id DESC LIMIT 1`).get();
check('归一：库内落归一值', projRow?.project === 'memoryos', `project=${projRow?.project}`);

/* ── ⑨ [task] 头收紧 ─────────────────────────────────────────── */
const taskHead = '[task][assignee:?][status:pending] write-hardening 探针';
const normal = await run('memory_write', { content: taskHead, type: 'convention', project: 'test' });
check('[task]：普通类型带状态头被拒并点名', normal?.isError === true && /\[task\] 状态头只供任务记忆/.test(normal.content?.[0]?.text ?? ''), normal.content?.[0]?.text?.replace(/\s+/g, ' ').slice(0, 100));
const explicit = await run('memory_write', { content: taskHead, type: 'task', project: 'test' });
check('[task]：显式 type=task 放行并落 task', !explicit?.isError && /按任务记忆写入/.test(explicit.content?.[0]?.text ?? String(explicit)), String(explicit).slice(0, 100));
const taskRow = db.prepare(`SELECT type FROM memories WHERE content=? ORDER BY id DESC LIMIT 1`).get(taskHead);
check('[task]：库内 type=task', taskRow?.type === 'task', `type=${taskRow?.type}`);

/* ── ⑦ 去重口径描述 ───────────────────────────────────────────── */
const desc = T('memory_write').description;
check('描述：写明「精确同文自动合并，语义相近仅提示」', /精确同文自动合并/.test(desc) && /不覆盖既有条目/.test(desc), desc.slice(0, 80));
check('描述：写明不受设置页开关限制', /不受控制台设置页/.test(desc));
check('描述：正文上限写进描述', desc.includes('6000'));

/* ── 追溯：审计只记拒绝，不记成功 ─────────────────────────────── */
check('审计：成功写入不产生审计行', db.prepare('SELECT COUNT(*) c FROM memory_write_rejections').get().c === 2, `c=${db.prepare('SELECT COUNT(*) c FROM memory_write_rejections').get().c}`);
db.close();
console.log(`\nsmoke-write-hardening: ${n} 项通过`);
