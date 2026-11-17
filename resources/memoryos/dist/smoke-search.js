import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, writeMemory, upsertVector } from './db.js';
import { archivedSearch } from './search.js';

process.env.MEMORYOS_BODY_GUARD = '0';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoryos-cold-layer-'));
const db = openDb(path.join(dir, 'memory.db'));
const fixture = (content, status) => writeMemory(db, {
  type: 'experience',
  content,
  project: 'global',
  agent: 'human:test',
  agent_fpath: null,
  status,
}).id;
const target = fixture('冷层归档检索标记 alpha-omega', 'archived');
const noise = fixture('完全无关的归档噪音记录 zeta-noise-999', 'archived');
fixture('在库记忆不参与归档冷层', 'active');

const embedder = {
  id: 'fake',
  provenance: () => ({ model: 'fake', dim: 8 }),
  embedTexts: async (queries) => queries.map(() => Array(8).fill(0)),
};
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(' '));
let got;
try {
  got = await archivedSearch(db, embedder, {
    query: 'alpha-omega 冷层归档检索标记',
    project: 'global',
    limit: 5,
    simFloor: 0.76,
  });
} finally {
  console.warn = originalWarn;
}

assert.ok(
  got.some((x) => x.id === target && x.archived === true && x.status === 'archived'),
  '归档记录必须能被检索并标注 archived',
);
assert.ok(!got.some((x) => x.id === noise), '无词法/语义证据的归档噪音不得越过 simFloor');
assert.equal(warnings.filter((w) => w.includes('keywordMap')).length, 0);
console.log(`PASS archivedSearch hits=${got.length}, target=${target}, noise=${noise}, archived=true, simFloor=0.76`);

// 无词法证据的受控语义夹具：类型过滤必须早于冷层候选LIMIT。
for(let i=0;i<55;i++){
  const id=writeMemory(db,{content:'归档候选干扰 '+i,type:'convention',project:'global',agent:'human:fixture',agent_fpath:null,status:'archived',source:'human'}).id;
  upsertVector(db,id,[1,0],{model:'unit-fixture',dim:2});
}
const semanticTarget=fixture('完整类型过滤目标', 'archived');
upsertVector(db,semanticTarget,[0.999,0.001],{model:'unit-fixture',dim:2});
const semantic=await archivedSearch(db,{provenance:()=>({model:'unit-fixture',dim:2}),embedTexts:async()=>[[1,0]]},{query:'semantic-only-probe',project:'global',type:'experience',limit:5,simFloor:.76});
assert.ok(semantic.some(x=>x.id===semanticTarget),'冷层类型不符的55个候选不得挤掉目标');
assert.ok(semantic.every(x=>x.type==='experience'));
console.log('PASS 冷层类型过滤先于语义候选上限（55个干扰项，无词法证据夹具）');
db.close();
fs.rmSync(dir, { recursive: true, force: true });
