/** 受控向量验证“相关度优先”，不代表真实模型准确率。 */
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {openDb,writeMemory,upsertVector} from './db.js';import {hybridSearch} from './search.js';
const db=openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(),'relevance-')),'memory.db'));
const vec=sim=>[sim,Math.sqrt(1-sim*sim)];
const put=(content,sim,extra={})=>{const id=writeMemory(db,{content,type:'experience',source:'human',agent:'human:fixture',agent_fpath:null,project:'fixture',...extra}).id;upsertVector(db,id,vec(sim),{model:'unit-fixture',dim:2});return id;};
const target=put('componentKey 需要保留具体约束和原始依据。',.94);
db.prepare("UPDATE memories SET last_seen_at='2020-01-01',created_at='2020-01-01' WHERE id=?").run(target);
put('泛泛相关的热门内容。'.repeat(10),.8);
const e={provenance:()=>({model:'unit-fixture',dim:2}),embedTexts:async()=>[[1,0]]};
try{
 const hits=await hybridSearch(db,e,{query:'semantic-probe-no-lexical-match',project:'fixture',limit:10,simFloor:.76,relRatio:.5});
 assert.equal(hits[0].id,target,'更相关的旧证据不应被热门通用内容压过');
 assert.ok(hits.some(h=>h.id===target));
 console.log('PASS 旧的具体证据以相关度优先，衰减不会静默删除强证据候选');
}finally{db.close();}
