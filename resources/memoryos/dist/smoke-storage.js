/** 三库物理边界、跨连接CAS、事务回滚、删除闭环、整组恢复验收。仅操作临时目录。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb,writeMemory,updateMemory,readMemory,readVector,upsertVector,deleteVector,withTx,backupDb,logUsage,logDaemon,markMerged,createDispatch } from './db.js';
import { reapExpiredLeases } from './daemon.js';
import { StorageConnection,storageStatus,restoreBundle,validateBundle,exportLegacy } from './storage.js';
import { createCardsDomain } from './cards-domain.js';
import { createTaskMemory } from './task-domain.js';
import { reconcileTasksAndCards } from './reconcile.js';
import { buildApp } from './dashboard.js';
process.env.EMBED_MODE='fake';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memoryos-storage-')),file=path.join(dir,'memory.db');
let db=openDb(file),passed=0;
const check=(name,fn)=>{fn();passed++;console.log('通过 '+name);};
const create=(type,content)=>writeMemory(db,{type,content,agent:'human:test',agent_fpath:null,project:'test'});
const knowledge=create('experience','保留知识'),task=create('task','[task][assignee:codex][status:pending] 待删除任务');
check('任务正文物理隔离且旧编号可读',()=>{assert.equal(db.prepare('SELECT count(*) n FROM main.knowledge_records WHERE type=\'task\'').get().n,0);assert.equal(db.prepare('SELECT id FROM task_store.task_records').get().id,task.id);assert.equal(readMemory(db,task.id).type,'task');});
// ★ A1/A2（2026-11-06）硬断言：任务 FTS/gram 已搬进任务库，主库零残留；任务库索引齐全。
check('任务检索索引不残留主库且任务库齐全',()=>{
  assert.equal(db.prepare('SELECT count(*) n FROM main.memories_fts WHERE rowid IN (SELECT id FROM task_store.task_records)').get().n,0,'主库 FTS 不得残留任务行');
  assert.equal(db.prepare('SELECT count(*) n FROM main.memories_gram WHERE memory_id IN (SELECT id FROM task_store.task_records)').get().n,0,'主库 gram 不得残留任务行');
  const tasks=db.prepare('SELECT count(*) n FROM task_store.task_records').get().n;
  assert.equal(db.prepare('SELECT count(*) n FROM task_store.task_fts').get().n,tasks,'任务库 FTS 条数应等于任务条数');
  assert.equal(db.prepare('SELECT count(DISTINCT memory_id) n FROM task_store.task_gram').get().n,tasks,'任务库 gram 应覆盖全部任务');
});
// ★ A3（2026-11-06）：任务向量归任务库，主库零残留，读侧跨库视图可回读。
check('任务向量物理隔离且视图可读回',()=>{
  const v=Array(8).fill(0);v[0]=1;
  upsertVector(db,task.id,v,{model:'fake',dim:8});
  assert.equal(db.prepare('SELECT count(*) n FROM main.memory_vectors WHERE memory_id=?').get(task.id).n,0,'主库不得残留任务向量');
  assert.equal(db.prepare('SELECT count(*) n FROM task_store.memory_vectors WHERE memory_id=?').get(task.id).n,1,'任务库应持有任务向量');
  assert.equal(readVector(db,task.id).length,8,'跨库视图应能读回任务向量');
});
// ★ 第二批·编号彻底分离：不改动本套件的存量夹具（后续断言依赖记录条数），只核对两条序列互不推进。
check('记忆与任务编号彻底分离（任务号≥700000、互不推进）',()=>{
  assert.ok(task.id>=700000,'任务号进入独立序列（≥700000）');
  assert.ok(knowledge.id<700000,'记忆号仍在低位区间');
  assert.equal(db.prepare("SELECT value FROM record_sequence WHERE id=1").get().value,knowledge.id,'写任务不推进记忆序列');
  assert.equal(db.prepare("SELECT value FROM task_store.task_sequence WHERE id=1").get().value,task.id,'任务序列独立推进且落在任务库');
  assert.equal(db.storage.raw.prepare("SELECT count(*) n FROM main.sqlite_master WHERE type='table' AND name='task_sequence'").get().n,0,'主库不得保留任务序列表');
  assert.equal(readMemory(db,task.id).type,'task','任务号仍可回读');
});
check('三个文件且主库无卡片副本',()=>{assert.equal(storageStatus(db).databases.length,3);assert.equal(db.storage.raw.prepare("SELECT count(*) n FROM main.sqlite_master WHERE type='table' AND name='cards'").get().n,0);});
let peer=new StorageConnection(file);
check('跨连接 CAS 仅一个成功',()=>{assert.ok(updateMemory(db,task.id,{content:task.content+' CAS',expectedVersion:1}));assert.equal(updateMemory(peer,task.id,{content:'过期写',expectedVersion:1}),null);});
check('物理约束禁止把任务改成知识',()=>assert.throws(()=>db.prepare("UPDATE memories SET type='experience' WHERE id=?").run(task.id),/不可直接互转/));
check('任务访问计数不触发向量失效',()=>{const gen=db.prepare("SELECT value FROM config WHERE key='vec_gen'").get().value;db.prepare('UPDATE memories SET hit_count=hit_count+1 WHERE id=?').run(task.id);assert.equal(db.prepare("SELECT value FROM config WHERE key='vec_gen'").get().value,gen);});
check('只读连接覆盖全部分库',()=>{const r=new StorageConnection(file,{readOnly:true});try{assert.throws(()=>r.prepare("UPDATE task_records SET status='archived'").run(),/readonly/);assert.throws(()=>r.prepare("INSERT INTO daemon_log(task,op) VALUES('test','test')").run(),/readonly/);}finally{r.close();}});
check('跨库失败整体回滚',()=>{assert.throws(()=>withTx(db,()=>{db.prepare("UPDATE memories SET content='回滚正文' WHERE id=?").run(task.id);db.prepare("INSERT INTO daemon_log(task,op) VALUES('rollback','probe')").run();throw new Error('故障注入');}),/故障注入/);assert.equal(readMemory(db,task.id).content,task.content+' CAS');assert.equal(db.prepare("SELECT count(*) n FROM daemon_log WHERE task='rollback'").get().n,0);});
const cards=createCardsDomain({db});
const cardId=Number(db.prepare("INSERT INTO cards(board,kind,title,status,ref_kind,ref_id) VALUES('default','task','待删除任务','ready','memory',?)").run(task.id).lastInsertRowid);
db.prepare("INSERT INTO card_memory(card_id,memory_id,relation) VALUES(?,?,'dispatch')").run(cardId,task.id);
db.prepare("INSERT INTO card_memory(card_id,memory_id,relation) VALUES(?,?,'reference')").run(cardId,knowledge.id);
db.prepare("INSERT INTO task_checkpoints(card_id,version,session_id,author,payload,task_state) VALUES(?,1,'test','human:test','{}','{}')").run(cardId);
check('删卡一次取消任务并保留关联知识',()=>{assert.equal(cards.deleteCardRow(cardId).removed,cardId);assert.equal(readMemory(db,task.id).status,'archived');assert.match(readMemory(db,task.id).content,/status:cancelled/);assert.equal(readMemory(db,knowledge.id).status,'active');assert.equal(db.prepare('SELECT count(*) n FROM cards WHERE id=?').get(cardId).n,0);reconcileTasksAndCards(db);assert.equal(db.prepare('SELECT count(*) n FROM cards WHERE id=?').get(cardId).n,0);});
check('已不存在卡片重复删除幂等',()=>assert.equal(cards.deleteCardRow(cardId).already_absent,true));
check('删除清理卡片检查点而不留外键悬挂',()=>assert.equal(db.prepare('SELECT count(*) n FROM task_checkpoints WHERE card_id=?').get(cardId).n,0));
const running=create('task','[task][assignee:codex][status:in_progress] 执行任务');
const runningCard=Number(db.prepare("INSERT INTO cards(board,kind,title,status,ref_kind,ref_id) VALUES('default','task','执行任务','running','memory',?)").run(running.id).lastInsertRowid);
check('执行中任务也可直接删除（派发一并释放，任务取消归档）',()=>{const r=cards.deleteCardRow(runningCard);assert.equal(r.removed,runningCard);assert.equal(readMemory(db,running.id).status,'archived');assert.match(readMemory(db,running.id).content,/status:cancelled/);});
// ★ 2026-11-13 回归：残留认领锁（历史 stale lock）不再阻挡删除——用户要求「点确认必删」。
const lockedCard=Number(db.prepare("INSERT INTO cards(board,kind,title,status,claim_lock,lease_expires_at) VALUES('default','task','残留锁卡片','cancelled','deadbeefdeadbeefdeadbeef','2026-01-01T00:00:00.000Z')").run().lastInsertRowid);
check('残留 claim_lock 的终态卡可直接删除',()=>{assert.equal(cards.deleteCardRow(lockedCard).removed,lockedCard);assert.equal(db.prepare('SELECT count(*) n FROM cards WHERE id=?').get(lockedCard).n,0);});
// ★ 2026-11-13：自动归档（终态 done/cancelled + 超 N 天）；manual 模式必须完全不动。
const setCfg=(k,v)=>db.prepare("INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k,JSON.stringify(v));
const oldDone=Number(db.prepare("INSERT INTO cards(board,kind,title,status,updated_at) VALUES('default','task','自动归档候选','done','2026-01-01T00:00:00.000Z')").run().lastInsertRowid);
const oldCancelled=Number(db.prepare("INSERT INTO cards(board,kind,title,status,updated_at) VALUES('default','task','取消也归档','cancelled','2026-01-01T00:00:00.000Z')").run().lastInsertRowid);
check('自动归档：done/cancelled 超阈值 → archived',()=>{setCfg('cards.archive_mode','auto');setCfg('cards.archive_days',7);const r=cards.runAutoArchive();assert.ok(r.archived>=2);assert.equal(db.prepare('SELECT status FROM cards WHERE id=?').get(oldDone).status,'archived');assert.equal(db.prepare('SELECT status FROM cards WHERE id=?').get(oldCancelled).status,'archived');});
check('自动归档：manual 模式完全不动',()=>{setCfg('cards.archive_mode','manual');const c2=Number(db.prepare("INSERT INTO cards(board,kind,title,status,updated_at) VALUES('default','task','手动模式候选','done','2026-01-01T00:00:00.000Z')").run().lastInsertRowid);const r=cards.runAutoArchive();assert.equal(r.skipped,'manual');assert.equal(db.prepare('SELECT status FROM cards WHERE id=?').get(c2).status,'done');});
const created=await createTaskMemory({db,writeMemory,logUsage,logDaemon,getEmbedder:async()=>({embedTexts:async()=>[]})},{title:'界面创建测试',project:'test'});
check('界面创建同时返回任务号与卡号',()=>{assert.ok(created.task_id);assert.ok(created.card_id);assert.equal(db.prepare("SELECT memory_id FROM card_memory WHERE card_id=? AND relation='dispatch'").get(created.card_id).memory_id,created.task_id);});
const app=buildApp(db,{token:'storage-smoke-private'});
const headers={authorization:'Bearer storage-smoke-private'};
try {
 check('知识列表排除任务记录',()=>{});
 const all=await app.inject({url:'/api/all',headers});assert.equal(all.statusCode,200);assert.ok(all.json().rows.every(r=>r.type!=='task'));
 const status=await app.inject({url:'/api/storage',headers});assert.equal(status.json().databases.length,3);
 const graph=await app.inject({url:'/api/cards/graph?auto=0',headers});assert.equal(graph.statusCode,200);assert.equal(graph.json().nodes.find(n=>Number(n.id)===created.card_id).task_id,created.task_id);
 passed++;console.log('通过 地图显式任务号与三库诊断接口');
 const deletion=await app.inject({url:'/api/cards/'+created.card_id,method:'DELETE',headers});assert.equal(deletion.statusCode,200);assert.equal(deletion.json().removed,created.card_id);
 const again=await app.inject({url:'/api/cards/'+created.card_id,method:'DELETE',headers});assert.equal(again.json().already_absent,true);
 passed++;console.log('通过 HTTP 删除及重复删除');
}finally{await app.close();}
peer.close();db.close();db=openDb(file);
check('重启不重建已取消地图卡',()=>{reconcileTasksAndCards(db);assert.equal(db.prepare('SELECT count(*) n FROM cards WHERE id=?').get(created.card_id).n,0);assert.equal(readMemory(db,created.task_id).status,'archived');});
const backup=backupDb(db,file,{dir:path.join(dir,'snapshots')});
check('备份完整且重跑幂等',()=>{assert.equal(validateBundle(backup.created).members.length,3);assert.equal(backupDb(db,file,{dir:path.join(dir,'snapshots')}).created,null);});
const restored=restoreBundle(backup.created,path.join(dir,'restored')),restoredDb=openDb(restored);
check('恢复保留任务知识与运行记录',()=>{assert.equal(readMemory(restoredDb,knowledge.id).content,'保留知识');assert.equal(readMemory(restoredDb,task.id).status,'archived');assert.ok(restoredDb.prepare("SELECT id FROM daemon_log WHERE op='delete'").get());});restoredDb.close();
check('可导出保留新增任务的旧版单库',()=>{const legacyFile=exportLegacy(backup.created,path.join(dir,'rollback.db'));const legacy=new DatabaseSync(legacyFile,{readOnly:true});try{assert.equal(legacy.prepare('SELECT count(*) n FROM memories').get().n,4);assert.equal(legacy.prepare('SELECT status FROM memories WHERE id=?').get(task.id).status,'archived');assert.ok(legacy.prepare("SELECT id FROM daemon_log WHERE op='delete'").get());
  // ★ A9（2026-11-06）：单库产物必须带任务检索索引，否则「有正文、搜不到」。
  assert.equal(legacy.prepare('SELECT count(*) n FROM memories_fts WHERE rowid=?').get(task.id).n,1,'导出库 FTS 缺任务行');
  assert.ok(legacy.prepare('SELECT count(*) n FROM memories_gram WHERE memory_id=?').get(task.id).n>0,'导出库 gram 缺任务行');
  assert.equal(legacy.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='task_sequence'").get().n,0,'导出库不应带任务序列');
}finally{legacy.close();}});
check('跨库文件丢失必须停止启动',()=>{const f=storageStatus(db).databases.find(r=>r.schema==='task_store').file;db.close();fs.renameSync(f,f+'.missing');assert.throws(()=>new StorageConnection(file),/文件组不完整/);fs.renameSync(f+'.missing',f);});
check('旧原生连接禁止静默写入错误库',()=>{const legacy=new DatabaseSync(file);try{assert.throws(()=>legacy.exec("INSERT INTO memories(content,type,agent) VALUES('bad','task','old')"),/view/);}finally{legacy.close();}});
// ★ 回归 #700030：放在全部存量夹具断言之后，避免改变后续断言依赖的任务序列与记录条数。
check('带 scope 任务写入向量即归属任务库',()=>{
  // 前述「跨库文件丢失」断言会 close 主连接，这里用新连接复验，不改变测试间共享的 db 句柄。
  const scopedDb=openDb(file);
  let scoped;
  try{
    scoped=writeMemory(scopedDb,{
      type:'task',
      content:'[task][assignee:?][status:pending] [scope:resources/memoryos/dist/db.js] 向量归属回归',
      agent:'human:test',agent_fpath:null,project:'test',
      embedding:Array(8).fill(0),
    });
  }finally{scopedDb.close();}
  const verifyDb=openDb(file);
  try{
    assert.equal(verifyDb.prepare('SELECT count(*) n FROM main.memory_vectors WHERE memory_id=?').get(scoped.id).n,0,'主库不得残留带 scope 任务向量');
    assert.equal(verifyDb.prepare('SELECT count(*) n FROM task_store.memory_vectors WHERE memory_id=?').get(scoped.id).n,1,'任务库应持有带 scope 任务向量');
    assert.equal(readVector(verifyDb,scoped.id).length,8,'跨库视图应能读回带 scope 任务向量');
    assert.throws(()=>upsertVector(verifyDb,888888,Array(8).fill(0),{model:'fake',dim:8}),/记录不存在|拒绝写向量/,'未知记录不得静默写主库');
    assert.throws(()=>upsertVector(verifyDb,scoped.id,Array(8).fill(0),{model:'fake',dim:8,recordType:'experience'}),/归属冲突/,'声明与实测归属冲突不得写向量');
    assert.equal(verifyDb.prepare('SELECT count(*) n FROM main.memory_vectors WHERE memory_id IN (SELECT id FROM task_store.task_records)').get().n,0,'主库任务向量全库不变式');
    assert.equal(verifyDb.prepare('SELECT count(*) n FROM (SELECT memory_id FROM memory_vectors GROUP BY memory_id HAVING count(*)>1)').get().n,0,'跨库向量视图不得有同 id 重复');
    // 记录物理删除后归属判定为 null；删除向量仍须清理两路物理表，不得 fail-closed 抛错。
    verifyDb.prepare('DELETE FROM memories WHERE id=?').run(scoped.id);
    deleteVector(verifyDb,scoped.id);
    assert.equal(verifyDb.prepare('SELECT count(*) n FROM main.memory_vectors WHERE memory_id=?').get(scoped.id).n,0,'主库不得残留已删除任务向量');
    assert.equal(verifyDb.prepare('SELECT count(*) n FROM task_store.memory_vectors WHERE memory_id=?').get(scoped.id).n,0,'任务库不得残留已删除任务向量');
  }finally{verifyDb.close();}
});
/* ══════════════════════════════════════════════════════════════════════════════
 * ★ 2026-11-13 回归（四处口径缺陷）：放回要擦干净、合并要跟着走。
 *   放在文件尾部：不改动上面 Export 断言依赖的记忆条数/任务序列。
 * ══════════════════════════════════════════════════════════════════════════════ */
check('fix3.流转回 ready 必须擦掉认领锁与租约（blocked→ready）',()=>{
  const v=openDb(file);
  try{
    const c=createCardsDomain({db:v});
    const cid=Number(v.prepare("INSERT INTO cards(board,kind,title,status,claim_lock,lease_expires_at,lease_notice_at,lease_stale_at) VALUES('default','task','回池清锁回归','blocked','deadbeefdeadbeefdeadbeef','2026-01-01T00:00:00.000Z','2025-12-31T00:00:00.000Z','2025-12-31T00:00:00.000Z')").run().lastInsertRowid);
    const r=c.transitionCard(cid,{status:'ready'},'human:test');
    assert.equal(r.to,'ready','blocked→ready 应允许');
    const row=v.prepare('SELECT status,claim_lock,lease_expires_at,lease_notice_at,lease_stale_at FROM cards WHERE id=?').get(cid);
    assert.equal(row.status,'ready');
    assert.equal(row.claim_lock,null,'回到可领取后不得残留认领锁');
    assert.equal(row.lease_expires_at,null,'回到可领取后不得残留租约');
    assert.equal(row.lease_notice_at,null);
    assert.equal(row.lease_stale_at,null);
  }finally{v.close();}
});
check('fix4a.记忆合并后关联卡随归档（含在途 running 卡）',()=>{
  const v=openDb(file);
  try{
    const loser=writeMemory(v,{type:'task',content:'[task][assignee:codex][status:in_progress] 被合并任务',agent:'human:test',agent_fpath:null,project:'test'});
    const winner=writeMemory(v,{type:'task',content:'[task][assignee:codex][status:in_progress] 存活任务',agent:'human:test',agent_fpath:null,project:'test'});
    const cid=Number(v.prepare("INSERT INTO cards(board,kind,title,status,ref_kind,ref_id,claim_lock,lease_expires_at) VALUES('default','task','合并跟随回归','running','memory',?,'cafebabecafebabecafebabe','2026-01-01T00:00:00.000Z')").run(loser.id).lastInsertRowid);
    const dsp=createDispatch(v,{key:'fix4a-dsp-key',memoryId:loser.id,agent:'codex',leaseMinutes:10});
    markMerged(v,loser.id,winner.id);
    assert.equal(readMemory(v,loser.id).status,'merged','loser 应为 merged');
    const row=v.prepare('SELECT status,claim_lock FROM cards WHERE id=?').get(cid);
    assert.equal(row.status,'archived','合并后关联卡必须跟随归档（不得留孤儿卡）');
    assert.equal(row.claim_lock,null,'合并归档后不得残留认领锁');
    assert.notEqual(v.prepare('SELECT state FROM dispatches WHERE id=?').get(dsp.id).state,'active','合并后工作证不得仍为 active');
  }finally{v.close();}
});
check('fix4b.todo 泳道的头卡分歧必须告警（含 blocked 头，403 场景）',()=>{
  const v=openDb(file);
  try{
    const t=writeMemory(v,{type:'task',content:'[task][assignee:codex][status:blocked] 头卡分歧回归',agent:'human:test',agent_fpath:null,project:'test'});
    const cid=Number(v.prepare("INSERT INTO cards(board,kind,title,status,ref_kind,ref_id,updated_at) VALUES('default','task','头卡分歧','todo','memory',?,strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 minutes'))").run(t.id).lastInsertRowid);
    v.prepare("INSERT INTO card_memory(card_id,memory_id,relation) VALUES(?,?,'dispatch')").run(cid,t.id);
    const r=reconcileTasksAndCards(v);
    assert.equal(v.prepare('SELECT status FROM cards WHERE id=?').get(cid).status,'todo','todo 泳道不是对账目标，卡不得被改写');
    assert.ok(v.prepare("SELECT count(*) n FROM daemon_log WHERE task='reconcile' AND op='diverge' AND memory_id=?").get(t.id).n>=1,'blocked 头 + todo 卡必须写发散告警（旧实现只看 in_progress）');
    assert.ok(Number(r.divergenceAlerts??0)>=1,'divergenceAlerts 应计数');
  }finally{v.close();}
});
check('fix2.ready 卡上的过期工作证应被 reaper 置 stale（卡状态/锁不动）',()=>{
  const v=openDb(file);
  try{
    const t=writeMemory(v,{type:'task',content:'[task][assignee:codex][status:pending] 回池后过期工作证',agent:'human:test',agent_fpath:null,project:'test'});
    const cid=Number(v.prepare("INSERT INTO cards(board,kind,title,status,ref_kind,ref_id) VALUES('default','task','ready 过期工作证','ready','memory',?)").run(t.id).lastInsertRowid);
    v.prepare("INSERT INTO card_memory(card_id,memory_id,relation) VALUES(?,?,'dispatch')").run(cid,t.id);
    const dsp=createDispatch(v,{key:'fix2-dsp-key',memoryId:t.id,agent:'codex',leaseMinutes:10});
    v.prepare("UPDATE dispatches SET lease_expires_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(dsp.id);
    const before=v.prepare('SELECT status,claim_lock FROM cards WHERE id=?').get(cid);
    reapExpiredLeases(v);
    assert.equal(v.prepare('SELECT state FROM dispatches WHERE id=?').get(dsp.id).state,'stale','ready 卡上的过期 active 工作证应被置 stale（旧实现只覆盖 blocked/pending）');
    const after=v.prepare('SELECT status,claim_lock FROM cards WHERE id=?').get(cid);
    assert.equal(after.status,before.status,'reaper 不得改卡状态');
    assert.equal(after.claim_lock,before.claim_lock,'reaper 不得动认领锁');
    // 阶段四：可领取卡上的存量残留锁（364 场景）应被清理
    v.prepare("UPDATE cards SET claim_lock='deadbeefdeadbeefdeadbeef', lease_expires_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(cid);
    const out2=reapExpiredLeases(v);
    assert.equal(v.prepare('SELECT claim_lock FROM cards WHERE id=?').get(cid).claim_lock,null,'可领取卡过期残留锁应被清理');
    assert.ok(Number(out2.poolLocksCleared??0)>=1,'应记入 poolLocksCleared');
  }finally{v.close();}
});
console.log(`总计 ${passed} 项通过；隔离数据目录：${dir}`);
