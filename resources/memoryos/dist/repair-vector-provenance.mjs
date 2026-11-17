/** 离线重算出处不明或已过期的向量。必须显式指定副本库；保留每条旧向量供回滚。 */
import fs from 'node:fs';
import path from 'node:path';
import {openDb,upsertVector,invalidateVectorCache} from './db.js';
import {getEmbedder,embedMode} from './embed.js';
const arg=name=>process.argv[process.argv.indexOf(name)+1];
if(!process.argv.includes('--db'))throw new Error('必须显式指定 --db，禁止默认连接生产');
const file=path.resolve(arg('--db'));
const prod=path.resolve(process.env.APPDATA??'.','MemoryOS','data');
if(file===prod||file.startsWith(prod+path.sep))throw new Error('本工具只处理副本；拒绝连接生产目录');
if(!fs.existsSync(file))throw new Error('副本数据库不存在');
process.env.MEMORY_DB=file;
process.env.MEMORYOS_DATA_DIR=path.join(path.dirname(file),'repair-data');
if(embedMode()==='fake')throw new Error('重算需要真实嵌入模型，fake禁止');
const db=openDb(file),apply=process.argv.includes('--apply'),started=new Date().toISOString();
try{
 const rows=db.prepare(`SELECT m.id,m.content,m.version,m.embedding_stale,v.embedding,v.embed_model,v.dim FROM memories m LEFT JOIN memory_vectors v ON v.memory_id=m.id WHERE m.type!='task' AND (v.memory_id IS NULL OR v.embed_model='unknown' OR v.dim=0 OR m.embedding_stale=1) ORDER BY m.id`).all();
 console.log(JSON.stringify({operation:'repair-vector-provenance',apply,candidates:rows.length,started}));
 if(apply){
  db.exec(`CREATE TABLE IF NOT EXISTS vector_repair_original(memory_id INTEGER PRIMARY KEY,embedding BLOB,embed_model TEXT,dim INTEGER,embedding_stale INTEGER,version INTEGER,content TEXT,recorded_at TEXT NOT NULL)`);
  const e=await getEmbedder(),provenance=e.provenance();let completed=0;
  for(const row of rows){
   const [vector]=await e.embedTexts([row.content]);
   if(!vector||vector.length!==provenance.dim||!vector.every(Number.isFinite))throw new Error('向量无效，停止：'+row.id);
   db.exec('BEGIN IMMEDIATE');
   try{
    const current=db.prepare('SELECT version,content FROM memories WHERE id=?').get(row.id);
    if(current?.version!==row.version||current?.content!==row.content)throw new Error('正文已变化，停止避免错配：'+row.id);
    db.prepare('INSERT OR IGNORE INTO vector_repair_original VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.embedding??null,row.embed_model??null,row.dim??null,row.embedding_stale,row.version,row.content,started);
    upsertVector(db,row.id,vector,{...provenance,recordType:'experience'});
    db.prepare('UPDATE memories SET embedding_stale=0 WHERE id=?').run(row.id);
    db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
   completed++;
   if(completed%25===0||completed===rows.length)console.log(JSON.stringify({completed,total:rows.length,lastId:row.id,model:provenance.model}));
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  invalidateVectorCache(db);
  console.log(JSON.stringify({completed,remaining:db.prepare("SELECT count(*) n FROM memories m LEFT JOIN memory_vectors v ON v.memory_id=m.id WHERE m.type!='task' AND (v.memory_id IS NULL OR v.embed_model='unknown' OR v.dim=0 OR m.embedding_stale=1)").get().n}));
 }
}finally{db.close();}
