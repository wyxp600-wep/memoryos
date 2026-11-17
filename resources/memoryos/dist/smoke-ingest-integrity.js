/** 受控HTTP模型夹具，仅验证采集完整性/恢复，不评估模型提炼质量。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ingest-integrity-'));
process.env.USERPROFILE=root;process.env.HOME=root;process.env.EMBED_MODE='fake';process.env.MEMORYOS_DATA_DIR=root;
process.env.MEMORY_DB=path.join(root,'memory.db');process.env.MEMORY_SOURCES=path.join(root,'sources.json');
process.env.LLM_MODEL='controlled-integrity-fixture';process.env.INGEST_MAX_CALLS='100';
const {openDb}=await import('./db.js');
const {ingestAll,readText,splitL1Items}=await import('./ingest.js');
const db=openDb(process.env.MEMORY_DB),norm=p=>p.replaceAll('\\','/');
let responseMode='valid',requests=0;
const server=http.createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const request=JSON.parse(Buffer.concat(chunks));requests++;
 const original=request.messages.at(-1).content.split('：\n\n').at(-1);
 const marker=original.match(/BLOCK_[0-9]+/)?.[0]??'LONG_CONTENT';
 const items=[{content:`数据库恢复校验 ${marker} 必须保留原文末尾的约束及源路径，出现失败须停止推进读取位置。`,type:'experience',source_quote:original.slice(0,30)}];
 const content=responseMode==='invalid'||responseMode==='fail-once' ?'{broken-json':responseMode==='unbacked'?JSON.stringify([{...items[0],source_quote:'原文中完全不存在的伪造引文'}]):JSON.stringify(items);
 if(responseMode==='fail-once')responseMode='valid';
 res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:responseMode==='truncated'?'length':'stop',message:{content}}]}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
process.env.LLM_BASE_URL=`http://127.0.0.1:${server.address().port}/v1`;
const sources=(file,level)=>fs.writeFileSync(process.env.MEMORY_SOURCES,JSON.stringify({sources:[{id:'fixture',path:file,name:'完整采集夹具',agent:'fixture',kind:'memory',level}]}));
const state=file=>db.prepare('SELECT * FROM ingest_state WHERE path=?').get(norm(file));
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
try{
 const large=path.join(root,'large.md'),largeBody='完整正文不应静默截断。'.repeat(105000)+'TAIL_SENTINEL';fs.writeFileSync(large,largeBody);
 check('超过1MB文件读取包含末尾',()=>assert.equal(readText(large),largeBody));
 const structured='结论：\n保留结构化正文中的代码与证据。\n\n关键词：\nA；B；C\n\n适用范围：\n测试环境\n\n依据：\n```js\n结论：不是边界\n```\n\n行动：\n先检查再执行\n\n状态：\n待验证，最后核验日期：2026-11-16。';
 check('结构化L1与代码围栏不被拆碎',()=>assert.deepEqual(splitL1Items(structured),[structured]));
 const l1=path.join(root,'l1.md');fs.writeFileSync(l1,structured);sources(l1,'L1');
 db.exec("CREATE TEMP TRIGGER reject_l1 BEFORE INSERT ON knowledge_records WHEN NEW.source='ingest' BEGIN SELECT RAISE(ABORT,'injected-write-failure'); END;");
 const failed=await ingestAll(db);
 check('L1写入失败不推进水位',()=>{assert.equal(failed.inserted,0);assert.equal(state(l1)?.size,0);assert.ok(failed.errors.some(e=>e.includes('injected-write-failure')));});
 db.exec('DROP TRIGGER reject_l1');db.prepare('UPDATE ingest_state SET next_retry_at=NULL').run();
 const retry=await ingestAll(db);check('L1恢复后原文逐字入库',()=>{assert.equal(retry.inserted,1);assert.equal(db.prepare("SELECT content FROM memories WHERE source='ingest'").get().content,structured);assert.ok(state(l1).size>0);});
 const many=path.join(root,'many.md');const body=Array.from({length:16},(_,i)=>`BLOCK_${i} `+'每段都有独立证据，不能把尚未尝试的尾部标为完成。'.repeat(65)).join('\n\n');fs.writeFileSync(many,body);sources(many,'L2');
 const first=await ingestAll(db);
 check('12块预算耗尽暂停而非标记整源完成',()=>{assert.equal(first.chunks,12);assert.ok(!state(many)||state(many).size===0);assert.equal(db.prepare('SELECT next_block FROM ingest_block_progress WHERE source=?').get(norm(many)).next_block,12);});
 for(let i=0;i<4&&!(state(many)?.size>0);i++)await ingestAll(db);
 check('后续轮次续读直至尾部且保存完整源',()=>{assert.ok(state(many).size>0);assert.equal(db.prepare('SELECT content FROM ingest_source_snapshots WHERE source=?').get(norm(many)).content,body);assert.ok(db.prepare("SELECT 1 FROM memories WHERE content LIKE '%BLOCK_15%'").get());});
 const failFile=path.join(root,'fail.md');fs.writeFileSync(failFile,'BLOCK_999 '+'故障原文证据与必要限定必须原样保留。'.repeat(12));sources(failFile,'L2');
 for(const mode of ['invalid','unbacked','truncated']){
  responseMode=mode;db.prepare('UPDATE ingest_state SET next_retry_at=NULL').run();
  const count=db.prepare('SELECT count(*) n FROM memories').get().n,result=await ingestAll(db);
  check('拒绝'+mode+'模型输出并保存死信原文',()=>{assert.ok(result.llmFail>0);assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n,count);assert.ok(db.prepare('SELECT content FROM ingest_dead_letters WHERE source=?').get(norm(failFile)).content.includes('BLOCK_999'));});
 }
 responseMode='valid';db.prepare('UPDATE ingest_state SET next_retry_at=NULL').run();await ingestAll(db);
 check('失败后可恢复且保留引文关联',()=>{assert.ok(db.prepare("SELECT 1 FROM memories WHERE content LIKE '%BLOCK_999%'").get());assert.ok(db.prepare("SELECT 1 FROM ingest_item_sources WHERE quote LIKE '%BLOCK_999%'").get());});
 const writeFile=path.join(root,'write-fail.md');fs.writeFileSync(writeFile,'BLOCK_888 '+'单块写入失败不能推进水位。'.repeat(20));sources(writeFile,'L2');
 db.exec("CREATE TEMP TRIGGER reject_l2 BEFORE INSERT ON knowledge_records WHEN NEW.source='ingest' BEGIN SELECT RAISE(ABORT,'injected-l2-failure'); END;");
 const l2Failed=await ingestAll(db);
 check('L2写入失败不推进块位置和文件水位',()=>{assert.equal(l2Failed.inserted,0);assert.equal(state(writeFile)?.size,0);assert.equal(db.prepare('SELECT next_block FROM ingest_block_progress WHERE source=?').get(norm(writeFile)).next_block,0);});
 db.exec('DROP TRIGGER reject_l2');db.prepare('UPDATE ingest_state SET next_retry_at=NULL').run();await ingestAll(db);
 check('L2写入恢复后成功采入遗漏块',()=>{assert.ok(state(writeFile)?.size>0);assert.ok(db.prepare("SELECT 1 FROM memories WHERE content LIKE '%BLOCK_888%'").get());});
 const mixed=path.join(root,'mixed.md');fs.writeFileSync(mixed,'BLOCK_777 '+'一个块失败以后成功块不应覆盖失败块的重试位置。'.repeat(160));sources(mixed,'L2');responseMode='fail-once';
 const mixedFirst=await ingestAll(db,0,{incremental:true});
 check('前块失败、后块成功时仍保留最早失败位置',()=>{assert.equal(mixedFirst.llmFail,1);assert.equal(state(mixed).size,0);assert.equal(db.prepare('SELECT next_block FROM ingest_block_progress WHERE source=?').get(norm(mixed)).next_block,0);});
 db.prepare('UPDATE ingest_state SET next_retry_at=NULL').run();await ingestAll(db,0,{incremental:true});
 check('增量模式不把失败源当未变而跳过，恢复后补齐首块',()=>{assert.ok(state(mixed).size>0);assert.ok(db.prepare("SELECT 1 FROM memories WHERE content LIKE '%BLOCK_777%'").get());assert.equal(state(mixed).fail_count,0);});
 console.log(`PASS ${checks}项采集完整性检查；受控模型请求${requests}次`);
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}
