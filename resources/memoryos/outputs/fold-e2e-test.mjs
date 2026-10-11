#!/usr/bin/env node
// fold-e2e-test.mjs — foldInto 七断言端对端测试
// 运行方式：MEMORY_DB=/tmp/mem-verify/memory.db node outputs/fold-e2e-test.mjs
import fs from 'node:fs';
import path from 'node:path';

// 提前设置，避免 embed.js 尝试加载 ONNX 运行时（fake 模式产生零向量，不影响本次测试）
if (!process.env.EMBED_MODE) process.env.EMBED_MODE = 'fake';

const DB_PATH = process.env.MEMORY_DB ?? '/tmp/mem-verify/memory.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

// 动态 import，使上方 env 设置对 embed.js 模块初始化可见
const { openDb, writeMemory, readMemory, appendEvent, undoLastArbitration, foldInto } =
  await import('../dist/db.js');

const db = openDb(DB_PATH);

let pass = 0, fail = 0;

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 断言 1-5：共用 winner A 和 loser B
// ═══════════════════════════════════════════════════════════════════

// textA 与 textB 各≥50字，前两句相同，末句各异
const textA =
  '深度学习在图像识别领域已经取得了突破性进展，卷积神经网络被广泛应用于医疗影像分析。' +
  '自然语言处理技术使得机器能够理解并生成人类语言，推动了智能助手的快速发展。' +
  '强化学习算法让机器能够通过试错来学习最优策略，已在围棋等复杂游戏中击败人类冠军。';

const textB =
  '深度学习在图像识别领域已经取得了突破性进展，卷积神经网络被广泛应用于医疗影像分析。' +
  '自然语言处理技术使得机器能够理解并生成人类语言，推动了智能助手的快速发展。' +
  '大型语言模型代表了当前自然语言处理的最高水平，能够完成复杂的推理和创作任务。';

// 写入 winner（A）
// node:sqlite 不接受 undefined，agent_fpath 等可选字段必须显式传 null
const winnerA = writeMemory(db, {
  content: textA, type: 'experience', agent: 'test-agent', agent_fpath: null, project: 'fold-test'
});

const countBefore = Number(
  db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='active' AND project='fold-test'`).get().c
);

// 直接调用 foldInto，不经过 server 层
const foldRes1 = foldInto(db, winnerA.id, textB, { agent: 'test-agent', fromId: 99 });

const countAfter = Number(
  db.prepare(`SELECT COUNT(*) c FROM memories WHERE status='active' AND project='fold-test'`).get().c
);

// 断言 1：foldInto 返回 ok:true 且无 skipped，active 行数不变（不插新行）
assert(
  '1. foldInto ok 且 active 行数不变（无新行产生）',
  foldRes1.ok === true && !foldRes1.skipped && countAfter === countBefore,
  `foldRes=${JSON.stringify(foldRes1)} before=${countBefore} after=${countAfter}`
);

// 断言 2：winner content 包含 B 的独有差异段
const winner2 = readMemory(db, winnerA.id);
const uniqueSeg = '大型语言模型代表了当前自然语言处理的最高水平';
assert(
  '2. winner content 包含 B 的差异内容',
  winner2.content.includes(uniqueSeg),
  `content tail: ...${winner2.content.slice(-100)}`
);

// 断言 3：winner embedding_stale=1
// readMemory 使用 BASE_COLUMNS，不含 embedding_stale，须直接查库
const staleRow = db.prepare(`SELECT embedding_stale FROM memories WHERE id=?`).get(winnerA.id);
assert(
  '3. winner embedding_stale=1',
  staleRow != null && Number(staleRow.embedding_stale) === 1,
  `embedding_stale=${staleRow?.embedding_stale}`
);

// 断言 4：memory_events 有 op='fold'，payload 含 beforeLen（数值）
const foldEvts4 = db.prepare(
  `SELECT payload FROM memory_events WHERE memory_id=? AND op='fold' ORDER BY id`
).all(winnerA.id);
let payload4 = null;
try { payload4 = foldEvts4.length > 0 ? JSON.parse(foldEvts4[0].payload) : null; } catch {}
assert(
  '4. memory_events 有 op=fold 行且 payload 含 beforeLen',
  foldEvts4.length > 0 && payload4 != null && typeof payload4.beforeLen === 'number',
  `events=${foldEvts4.length} payload=${JSON.stringify(payload4)}`
);

// 断言 5：重写与 winner 完全同文 → skipped='duplicate'，正文未膨胀
const contentBefore5 = winner2.content;
const foldRes5 = foldInto(db, winnerA.id, winner2.content, { agent: 'test-agent' });
const winner5 = readMemory(db, winnerA.id);
assert(
  '5. 重写同文 → skipped=duplicate，正文未膨胀',
  foldRes5.ok === true && foldRes5.skipped === 'duplicate' && winner5.content === contentBefore5,
  `res=${JSON.stringify(foldRes5)} contentChanged=${winner5.content !== contentBefore5}`
);

// ═══════════════════════════════════════════════════════════════════
// 断言 6：构造 ~2970 字 winner，折入 ~60 字差异 → too_long，事件留痕
// ═══════════════════════════════════════════════════════════════════
// longUnit = 39 字，× 84 = 3276，slice 到 2970
const longUnit = '本段落专用于构造超长正文，作为触发字数上限保护机制的测试材料，内容无实际意义。';
const longContent = longUnit.repeat(84).slice(0, 2970);

const longWinner = writeMemory(db, {
  content: longContent, type: 'experience', agent: 'test-agent', agent_fpath: null, project: 'fold-test'
});

// appendPart6：58 字，全部不在 longContent 中，确保 _diffSegments 提取出差异段
const appendPart6 =
  '量子计算技术正在快速发展，有望在密码学和药物研发领域带来革命性突破，' +
  '科学家们正在努力解决量子退相干这一核心技术难题。';

const foldRes6 = foldInto(db, longWinner.id, appendPart6, { agent: 'test-agent' });

const foldEvts6 = db.prepare(
  `SELECT payload FROM memory_events WHERE memory_id=? AND op='fold' ORDER BY id DESC LIMIT 1`
).all(longWinner.id);
let payload6 = null;
try { payload6 = foldEvts6.length > 0 ? JSON.parse(foldEvts6[0].payload) : null; } catch {}

assert(
  '6. winner >3000 字时返回 skipped=too_long，事件仍留痕',
  foldRes6.ok === true && foldRes6.skipped === 'too_long' &&
  foldEvts6.length > 0 && payload6 != null && payload6.skipped === 'too_long',
  `res=${JSON.stringify(foldRes6)} payload=${JSON.stringify(payload6)}`
);

// ═══════════════════════════════════════════════════════════════════
// 断言 7：undoLastArbitration 不被 fold 事件污染
// ═══════════════════════════════════════════════════════════════════
const memUndo = writeMemory(db, {
  content: '这是专用于仲裁撤销测试的记忆条目，内容不做实际语义判断。',
  type: 'experience', agent: 'test-agent', agent_fpath: null, project: 'fold-test'
});

// 手动写一条真仲裁事件 op='merge'（undoLastArbitration 识别的类型）
const mergeSnap = {
  pending: {
    id: memUndo.id, status: 'active', confidence: 0.8,
    eff_confidence: null, conflict_with: null, superseded_by: null
  },
  old: null,
  insertedId: null
};
appendEvent(db, {
  memory_id: memUndo.id, op: 'merge',
  payload: JSON.stringify(mergeSnap), operator: 'human:arbitrate'
});

// 再写一条 fold 事件（id 更大，时间更晚）——此类型不在 undoLastArbitration 的查询 IN 列表中
appendEvent(db, {
  memory_id: memUndo.id, op: 'fold',
  payload: JSON.stringify({ beforeLen: 50 }), operator: 'daemon'
});

// undoLastArbitration 应选中 merge 而非 fold
const undoResult = undoLastArbitration(db);

assert(
  '7. undoLastArbitration 不被 fold 污染，取到 merge 事件',
  typeof undoResult === 'string' && undoResult.includes('merge'),
  `result="${undoResult}"`
);

// ═══════════════════════════════════════════════════════════════════
console.log('');
console.log(`== 合计：${pass} PASS / ${fail} FAIL ==`);
