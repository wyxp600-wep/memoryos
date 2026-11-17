/** 唯一对外任务号 = task_records.id；地图节点主键仅供内部路由与旧客户端兼容。 */
export function taskIdOfCard(db,cardId) {
  // ★ 2026-11-17（B8）：任务侧直连任务物理表，不再经 temp.memories 视图（表内行本身即任务，无需 type 过滤）
  const rows=db.prepare(`SELECT m.id FROM card_memory cm JOIN task_store.task_records m ON m.id=cm.memory_id
    WHERE cm.card_id=? AND cm.relation='dispatch'
    UNION SELECT m.id FROM cards c JOIN task_store.task_records m ON c.ref_kind='memory' AND c.ref_id=m.id
    WHERE c.id=? AND c.kind='task'`).all(cardId,cardId);
  if(rows.length>1)throw new Error('同一地图节点绑定多个任务，停止操作并修复关联');
  return rows.length?Number(rows[0].id):null;
}
export function cardIdOfTask(db,taskId) {
  if(!db.prepare("SELECT id FROM task_store.task_records WHERE id=?").get(taskId))throw new Error('任务 #'+taskId+' 不存在');
  const row=db.prepare(`SELECT c.id FROM cards c WHERE c.kind='task' AND
    ((c.ref_kind='memory' AND c.ref_id=?) OR EXISTS(SELECT 1 FROM card_memory cm WHERE cm.card_id=c.id AND cm.memory_id=? AND cm.relation='dispatch')) ORDER BY c.id LIMIT 1`).get(taskId,taskId);
  if(!row)throw new Error('任务 #'+taskId+' 暂无地图节点，无法使用地图检查点');
  return Number(row.id);
}
export function ensureCardTask(db,cardId,writeTask) {
  const c=db.prepare('SELECT * FROM cards WHERE id=?').get(cardId);
  if(!c||c.kind!=='task')return null;
  const existing=taskIdOfCard(db,cardId);if(existing)return existing;
  let meta={};try{meta=JSON.parse(c.meta||'{}');}catch{throw new Error('任务元数据无效，未创建任务编号');}
  const status=({running:'in_progress',review:'in_progress',blocked:'blocked',failed:'blocked',done:'done',cancelled:'cancelled',archived:'archived'})[c.status]||'pending';
  const project=String(meta.project||'global');
  const rawAssignee=String(c.assignee||'').replace(/[\[\]\r\n]/g,'');
  const assignee=['','any','unassigned'].includes(rawAssignee)?'?':rawAssignee;
  const content=`[task][assignee:${assignee}][status:${status}] ${c.title}\n\n${c.body||''}`;
  let id;
  db.exec('SAVEPOINT ensure_card_task');
  try {
    const task=writeTask(db,{content,type:'task',agent:'human:dashboard',agent_fpath:null,project,source:'human',source_ref:'card:'+c.id,status:c.status==='archived'||c.status==='cancelled'?'archived':'active'});
    id=task.id;
    db.prepare("INSERT INTO card_memory(card_id,memory_id,relation) VALUES(?,?,'dispatch')").run(c.id,id);
    // 不替换原始笔记/知识来源引用，dispatch 关联才是任务号的权威映射。
    if(!c.ref_kind)db.prepare("UPDATE cards SET ref_kind='memory',ref_id=? WHERE id=?").run(id,c.id);
    db.exec('RELEASE ensure_card_task');
  }catch(e){db.exec('ROLLBACK TO ensure_card_task; RELEASE ensure_card_task');throw e;}
  return Number(id);
}
export function installTaskIdentity(db,writeTask) {
  if(db.prepare("SELECT value FROM config WHERE key='task_identity.v1'").get())return;
  db.exec('SAVEPOINT task_identity_migration');
  try {
    for(const c of db.prepare("SELECT id FROM cards WHERE kind='task' ORDER BY id").all())ensureCardTask(db,c.id,writeTask);
    db.prepare("INSERT INTO config(key,value) VALUES('task_identity.v1','1')").run();
    db.exec('RELEASE task_identity_migration');
  }catch(e){db.exec('ROLLBACK TO task_identity_migration; RELEASE task_identity_migration');throw e;}
}
export function normalizeTaskArguments(name,args,db) {
  if(!args||args.task_id==null)return args;
  const taskId=Number(args.task_id);
  if(!Number.isSafeInteger(taskId)||taskId<=0)throw new Error('task_id 必须是正整数任务号');
  if(name.startsWith('task_')) {
    if(args.memory_id!=null&&Number(args.memory_id)!==taskId)throw new Error('task_id 与旧 memory_id 不一致，已拒绝操作');
    return {...args,memory_id:taskId};
  }
  if(db && ['memory_context','memory_work'].includes(name)) {
    const cardId=cardIdOfTask(db,taskId);
    if(args.task_card_id!=null&&Number(args.task_card_id)!==cardId)throw new Error('task_id 与旧 task_card_id 不一致，已拒绝操作');
    return {...args,task_card_id:cardId};
  }
  return args;
}
export function publicTaskResult(db,result) {
  if(typeof result!=='string'||!db)return result;
  return result.replace(/\bmemory_id=(\d+)/g,'task_id=$1').replace(/ \+ 地图卡 #\d+/g,'').replace(/(?:地图)?卡片\s*#(\d+)/g,(text,id)=>{
    const taskId=taskIdOfCard(db,Number(id));return taskId?'任务 #'+taskId:text;
  });
}
