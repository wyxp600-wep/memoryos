/** 指定客户端领单：复用 task 记忆、card_memory、dispatches，不引入第二套任务状态机。 */
import { writeMemory, updateMemory, readMemory, withTx } from './db.js';
import { createTaskRow } from './task-writer.js'; // ★ 2026-11-16（B4 组1b）：任务写入唯一入口（补漏：队列建任务原来仍走记忆写入层）
const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
export function queueAssignments(db) {
  return db.prepare(`SELECT c.id, c.status, c.meta, cm.memory_id FROM cards c
    JOIN card_memory cm ON cm.card_id=c.id AND cm.relation='dispatch'
    WHERE json_valid(c.meta) AND json_extract(c.meta,'$.queue_delivery.agent_key') IS NOT NULL`).all();
}
export function queueClaimError(db, memoryId, actual, as) {
  const assignments=queueAssignments(db);
  const rows=assignments.filter(r=>Number(r.memory_id)===Number(memoryId));
  for(const row of rows){
    const delivery=parse(row.meta).queue_delivery;
    if(actual!==delivery.agent_key || (as && as!==actual)) return `任务 #${memoryId} 是 ${delivery.agent_key} 的定向队列任务，当前客户端 ${actual} 不可代领（不支持 as 覆盖）。`;
    const active=assignments.filter(r=>r.status==='running' && Number(r.memory_id)!==Number(memoryId) && parse(r.meta).queue_delivery.agent_card_id===delivery.agent_card_id).length;
    if(active>=delivery.concurrency)return `指定智能体并发位置已满（${active}/${delivery.concurrency}），任务保留等待领取。`;
  }
  return null;
}
export function enqueueTargetedTask(db, cardId, agentCardId, profile) {
  const receiver=String(profile?.agent_key||'').trim();
  if(!/^[a-z][a-z0-9_-]{0,31}$/.test(receiver))throw new Error('请先在智能体卡中选择接收任务的客户端，队列不会转交内置智能体');
  let result;
  withTx(db,()=>{
    const card=db.prepare('SELECT * FROM cards WHERE id=?').get(cardId);
    if(!card || !['todo','ready'].includes(card.status) || card.claim_lock)throw new Error('卡片已被领取或状态改变，请刷新');
    const meta=parse(card.meta);
    const relation=db.prepare(`SELECT memory_id FROM card_memory WHERE card_id=? AND relation='dispatch' LIMIT 1`).get(cardId);
    let memoryId=relation?.memory_id || (card.ref_kind==='memory'?card.ref_id:null);
    let task=memoryId?readMemory(db,Number(memoryId)):null;
    const content=`[task][assignee:${receiver}][status:pending] ${card.title}\n\n${card.body||''}`;
    if(task){
      if(queueAssignments(db).some(r=>Number(r.memory_id)===Number(memoryId)&&Number(r.id)!==Number(cardId)))throw new Error('关联任务已被其他队列卡使用，请为本卡建立独立任务');
      if(task.type!=='task'||!['active','trial'].includes(task.status)||!/^\[task\].*\[status:(pending|open)\]/.test(task.content))throw new Error('关联任务不处于待领取状态，拒绝覆盖');
      if(meta.queue_delivery?.agent_key===receiver && meta.queue_delivery?.agent_card_id===agentCardId){result={ok:true,id:cardId,taskId:Number(memoryId),channel:'queue',status:'waiting',receiver,queued:true,noop:true};return;}
      const originalBody=task.content.replace(/^\[task\]\[assignee:[^\]]*\]\[status:[^\]]*\]/, '').trim();
      if(!updateMemory(db,Number(memoryId),{content:`[task][assignee:${receiver}][status:pending] ${originalBody}`,expectedVersion:task.version}))throw new Error('任务版本漂移，请刷新');
    }else{
      task=createTaskRow(db,{content,agent:'human:dashboard',agent_fpath:null,project:'global',source:'human',sensitivity:'normal'});
      memoryId=Number(task.id);
    }
    meta.queue_delivery={agent_key:receiver,agent_card_id:agentCardId,concurrency:Math.max(1,Math.min(16,Math.floor(Number(profile.concurrency)||1))),enqueued_at:new Date().toISOString()};
    db.prepare(`UPDATE cards SET status='ready',assignee=?,meta=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(receiver,JSON.stringify(meta),cardId);
    db.prepare(`INSERT OR IGNORE INTO card_memory(card_id,memory_id,relation) VALUES(?,?,'dispatch')`).run(cardId,memoryId);
    db.prepare(`UPDATE card_edges SET status='superseded' WHERE source_id=? AND kind='dispatch' AND status='active'`).run(cardId);
    db.prepare(`INSERT INTO card_edges(source_id,target_id,kind,status) VALUES(?,?,'dispatch','active')`).run(cardId,agentCardId);
    db.prepare(`INSERT INTO card_events(card_id,actor,action,from_status,to_status,detail) VALUES(?,'human:dashboard','queue_wait',?,'ready',?)`).run(cardId,card.status,`等待 ${receiver} 通过 task_claim 领取；任务 #${memoryId}`);
    result={ok:true,id:cardId,taskId:Number(memoryId),channel:'queue',status:'waiting',receiver,queued:true};
  });
  return result;
}
export function linkQueueClaim(db,memoryId,dispatchId){
  for(const row of queueAssignments(db).filter(r=>Number(r.memory_id)===Number(memoryId)))db.prepare(`UPDATE card_edges SET dispatch_id=? WHERE source_id=? AND kind='dispatch' AND status='active'`).run(dispatchId,row.id);
}
export function settleQueueEdges(db,memoryId,status){
  if(!['done','cancelled','archived'].includes(status))return;
  for(const row of queueAssignments(db).filter(r=>Number(r.memory_id)===Number(memoryId)))db.prepare(`UPDATE card_edges SET status=? WHERE source_id=? AND kind='dispatch' AND status='active'`).run(status==='done'?'completed':'cancelled',row.id);
}

// 在 LIMIT 之前过滤接收方，避免其他客户端的大量积压挤掉当前客户端任务。
// ★ 2026-11-16（B4 组1）：改为按表名生成 —— 任务侧已直连 task_store.task_records，
//   固定写 memories.id 会让物理表查询报 `no such column: memories.id`。
export const queueVisibleSqlFor = (table = "memories") => `NOT EXISTS (SELECT 1 FROM card_memory qcm JOIN cards qc ON qc.id=qcm.card_id
 WHERE qcm.memory_id=${table}.id AND qcm.relation='dispatch' AND json_valid(qc.meta)
 AND json_extract(qc.meta,'$.queue_delivery.agent_key') IS NOT NULL
 AND json_extract(qc.meta,'$.queue_delivery.agent_key') != ?)`;
/** 兼容旧调用（仍指向 memories 视图；task-domain 已改传物理表）。 */
export const queueVisibleSql = queueVisibleSqlFor("memories");
