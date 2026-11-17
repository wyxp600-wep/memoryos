/** 确定性夹具检查段落索引生命周期与权限；不测真实模型语义质量。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDb,writeMemory,updateMemory} from './db.js';
import {memoryPassages,rebuildPassages,passageCandidates} from './memory-passages.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'passage-smoke-')),file=path.join(root,'memory.db');
const db=openDb(file),original='前段事实。'.repeat(90)+'TAIL_NEEDLE 这里是末尾的独立错误和解法。';
const parts=memoryPassages(original);
assert.equal(parts[0].start,0);assert.equal(parts.at(-1).end,original.length);
for(let i=0;i<parts.length;i++){assert.equal(parts[i].text,original.slice(parts[i].start,parts[i].end));if(i)assert.ok(parts[i].start<=parts[i-1].end);}
const put=(extra={})=>writeMemory(db,{content:original,type:'experience',source:'human',agent:'human:fixture',agent_fpath:null,project:'p',...extra}).id;
const target=put(),secret=put({sensitivity:'secret'}),other=put({project:'other'}),expired=put({valid_until:'2020-01-01'});
const e={provenance:()=>({model:'unit-fixture',dim:2}),embedTexts:async strings=>strings.map(s=>s.includes('TAIL_NEEDLE')?[1,0]:[0,1])};
await rebuildPassages(db,e,{limit:100});
const cosine=(a,b)=>a[0]*b[0]+a[1]*b[1];
let hits=passageCandidates(db,[1,0],e.provenance(),{project:'p'},cosine,['active'],20);
assert.ok(hits.some(h=>h.id===target));assert.ok(!hits.some(h=>[secret,other,expired].includes(h.id)));
const legacy=new DatabaseSync(file);legacy.prepare('UPDATE knowledge_records SET content=? WHERE id=?').run(original.replaceAll('TAIL_NEEDLE','REMOVED'),target);legacy.close();
hits=passageCandidates(db,[1,0],e.provenance(),{project:'p'},cosine,['active'],20);assert.ok(!hits.some(h=>h.id===target),'旧连接改正文必须立即失效');
await rebuildPassages(db,e,{limit:100});
hits=passageCandidates(db,[1,0],e.provenance(),{project:'p'},cosine,['active'],20);assert.ok(!hits.some(h=>h.id===target),'重建不能召回旧内容');
assert.equal(db.prepare('SELECT content FROM memories WHERE id=?').get(target).content,original.replaceAll('TAIL_NEEDLE','REMOVED'));
assert.equal(passageCandidates(db,[1,0],{model:'another-model',dim:2},{project:'p'},cosine,['active'],20).length,0);
await rebuildPassages(db,{...e,provenance:()=>({model:'another-model',dim:2})},{limit:100});
assert.equal(db.prepare("SELECT count(*) n FROM memory_passages WHERE model!='another-model'").get().n,0,'切换模型后须重算所有旧模型段落');
console.log('PASS 段落原文位置、首尾覆盖、尾部召回、secret/项目/有效期过滤、旧连接更新失效、重建及跨模型隔离');db.close();
