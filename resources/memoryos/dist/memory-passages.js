const MEMORIES = "main.knowledge_records"; // ★ 2026-11-16（B4 组4）：检索链路只查记忆物理表，不再返回任务记录
/** 长正文的派生语义索引；原文不改写，逐块保留字符位置，旧连接写入后立即失效。 */
import {createHash} from 'node:crypto';
export const PASSAGE_VERSION='passages-v1';
export function memoryPassages(content){
 const text=String(content??'');if(text.length<360)return [];
 const parts=[];let start=0;
 while(start<text.length){
  let end=Math.min(text.length,start+360);
  if(end<text.length){const segment=text.slice(start,end),bound=Math.max(segment.lastIndexOf('。'),segment.lastIndexOf('\n'),segment.lastIndexOf('；'));if(bound>=180)end=start+bound+1;}
  parts.push({start,end,text:text.slice(start,end)});if(end===text.length)break;start=Math.max(start+1,end-60);
 }
 return parts;
}
export function installPassageIndex(db){
 db.exec(`CREATE TABLE IF NOT EXISTS memory_passages(memory_id INTEGER NOT NULL,ordinal INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,content_hash TEXT NOT NULL,model TEXT NOT NULL,dim INTEGER NOT NULL,embedding BLOB NOT NULL,PRIMARY KEY(memory_id,ordinal));
  CREATE TABLE IF NOT EXISTS memory_passage_state(memory_id INTEGER PRIMARY KEY,hash TEXT NOT NULL,version TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memory_passage_dirty(memory_id INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS memory_passage_epoch(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL);
  INSERT OR IGNORE INTO memory_passage_epoch VALUES(1,0);`);
 const table=db.storage?'knowledge_records':'memories';
 for(const [name,event]of [['insert','INSERT'],['update','UPDATE OF content']])db.exec(`CREATE TRIGGER IF NOT EXISTS passage_${name} AFTER ${event} ON ${table} BEGIN INSERT OR IGNORE INTO memory_passage_dirty VALUES(NEW.id); UPDATE memory_passage_epoch SET epoch=epoch+1 WHERE id=1; END;`);
 db.exec(`CREATE TRIGGER IF NOT EXISTS passage_delete AFTER DELETE ON ${table} BEGIN DELETE FROM memory_passages WHERE memory_id=OLD.id;DELETE FROM memory_passage_state WHERE memory_id=OLD.id;DELETE FROM memory_passage_dirty WHERE memory_id=OLD.id;UPDATE memory_passage_epoch SET epoch=epoch+1 WHERE id=1;END;`);
 db.prepare(`INSERT OR IGNORE INTO memory_passage_dirty SELECT id FROM ${table} WHERE NOT EXISTS(SELECT 1 FROM memory_passage_state s WHERE s.memory_id=${table}.id AND s.version=?)`).run(PASSAGE_VERSION);
}
export async function rebuildPassages(db,embedder,{limit=2}={}){
 const provenance=embedder.provenance();if(provenance.model==='fake')return {done:0,pending:0,skipped:'fake'};
 db.prepare('INSERT OR IGNORE INTO memory_passage_dirty SELECT DISTINCT memory_id FROM memory_passages WHERE model!=? OR dim!=?').run(provenance.model,provenance.dim);
 const table=db.storage?'knowledge_records':'memories';
 const rows=db.prepare(`SELECT m.id,m.content,m.sensitivity FROM ${table} m JOIN memory_passage_dirty d ON d.memory_id=m.id ORDER BY m.id LIMIT ?`).all(limit);
 let done=0,passages=0;
 for(const row of rows){
  const parts=row.sensitivity==='secret'?[]:memoryPassages(row.content),hash=createHash('sha256').update(row.content).digest('hex');
  const vectors=parts.length?await embedder.embedTexts(parts.map(p=>p.text)):[];
  if(vectors.length!==parts.length||vectors.some(v=>v.length!==provenance.dim||!v.every(Number.isFinite)))throw new Error('段落向量无效，保留待重算：'+row.id);
  db.exec('SAVEPOINT passage_update');
  try{
   if(db.prepare(`SELECT content FROM ${table} WHERE id=?`).get(row.id)?.content!==row.content)throw new Error('段落重算期间正文已变化：'+row.id);
   db.prepare('DELETE FROM memory_passages WHERE memory_id=?').run(row.id);
   const insert=db.prepare('INSERT INTO memory_passages VALUES(?,?,?,?,?,?,?,?)');
   for(let i=0;i<parts.length;i++){const v=Float32Array.from(vectors[i]);insert.run(row.id,i,parts[i].start,parts[i].end,hash,provenance.model,v.length,Buffer.from(v.buffer));}
   db.prepare('INSERT OR REPLACE INTO memory_passage_state VALUES(?,?,?)').run(row.id,hash,PASSAGE_VERSION);
   db.prepare('DELETE FROM memory_passage_dirty WHERE memory_id=?').run(row.id);
   db.exec('UPDATE memory_passage_epoch SET epoch=epoch+1 WHERE id=1;RELEASE passage_update');
   done++;passages+=parts.length;
  }catch(error){db.exec('ROLLBACK TO passage_update;RELEASE passage_update');throw error;}
  await new Promise(resolve=>setTimeout(resolve,0));
 }
 return {done,passages,pending:Number(db.prepare('SELECT count(*) n FROM memory_passage_dirty').get().n)};
}
const cache=new WeakMap();
export function passageEpoch(db){return db.prepare('SELECT epoch FROM memory_passage_epoch WHERE id=1').get()?.epoch??0;}
export function passageCandidates(db,qv,provenance,p,cosine,statuses,limit){
 const epoch=passageEpoch(db);let entry=cache.get(db);
 if(!entry||entry.epoch!==epoch){entry={epoch,rows:db.prepare('SELECT p.* FROM memory_passages p WHERE NOT EXISTS(SELECT 1 FROM memory_passage_dirty d WHERE d.memory_id=p.memory_id)').all().map(r=>({...r,vec:new Float32Array(Uint8Array.from(r.embedding).buffer)}))};cache.set(db,entry);}
 const scope=p.project==='*'?'':" AND project COLLATE NOCASE IN (?, 'global')";
 const allowed=new Set(db.prepare(`SELECT id FROM ${MEMORIES} WHERE status IN (${statuses.map(()=>'?')}) AND sensitivity!='secret' AND superseded_by IS NULL AND (valid_from IS NULL OR julianday(valid_from)<=julianday('now')) AND (valid_until IS NULL OR julianday(valid_until)>julianday('now'))${scope}${p.type?' AND type=?':''}${p.agent?' AND agent=?':''}${p.sector?' AND sector=?':''}`).all(...statuses,...(scope?[p.project]:[]),...(p.type?[p.type]:[]),...(p.agent?[p.agent]:[]),...(p.sector?[p.sector]:[])).map(r=>r.id));
 const hits=new Map();
 for(const row of entry.rows){if(!allowed.has(row.memory_id)||row.model!==provenance.model||row.dim!==qv.length)continue;const sim=cosine(qv,row.vec);if(sim>(hits.get(row.memory_id)?.sim??0))hits.set(row.memory_id,{id:row.memory_id,sim,start:row.start,end:row.end});}
 return [...hits.values()].filter(h=>h.sim>0.4).sort((a,b)=>b.sim-a.sim).slice(0,limit);
}
