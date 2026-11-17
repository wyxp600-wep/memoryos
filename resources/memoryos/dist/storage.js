/** 按业务隔离的 SQLite 文件组。兼容视图仅适配旧 API，不复制任务正文。 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const TASK_TABLES = new Set(['cards','card_events','card_comments','card_memory','dispatches','card_types','agent_profiles','card_edges','card_events_archive','task_checkpoints','request_receipts','task_fts','task_gram','task_events','task_usage']);
const RUNTIME_TABLES = new Set(['daemon_log','memory_usage','memory_usage_archive','exec_audit','exec_approvals','resource_locks','agent_sessions','agent_credentials','agent_runs','working_memory','agent_feedback_events','mcp_client_connections']);
const IDENT = /^[A-Za-z_][A-Za-z_0-9]*$/;
const qi = s => { if(!IDENT.test(s))throw new Error('非法存储标识符'); return '"'+s+'"'; };
const literal = s => "'"+String(s).replaceAll("'","''")+"'";
const own = name => TASK_TABLES.has(name)?'task_store':RUNTIME_TABLES.has(name)?'runtime_store':'main';
function filesFor(file) {
  if(file===':memory:')return {main:file,task_store:file,runtime_store:file};
  const stem=file.replace(/\.db$/i,'');
  return {main:file,task_store:stem+'.tasks.db',runtime_store:stem+'.runtime.db'};
}
function has(raw, table, schema='main') {return !!raw.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(table);}
function atomicJournals(raw) {
  for(const schema of ['main','task_store','runtime_store']) {
    raw.exec(`PRAGMA ${schema}.journal_mode=DELETE; PRAGMA ${schema}.synchronous=FULL;`);
    const row=raw.prepare(`PRAGMA ${schema}.journal_mode`).get();
    if(!['delete','memory'].includes(row.journal_mode))throw new Error('跨库事务日志模式未生效：'+schema);
  }
}
function attach(raw, files, expected, readOnly=false) {
  for(const schema of ['task_store','runtime_store']) {
    if(expected && files[schema]!==':memory:' && !fs.existsSync(files[schema]))throw new Error('数据库文件组不完整，停止启动：'+files[schema]);
    raw.prepare(`ATTACH DATABASE ? AS ${schema}`).run(readOnly?pathToFileURL(path.resolve(files[schema])).href+'?mode=ro':files[schema]);
    if(expected) {
      if(!has(raw,'storage_identity',schema)||raw.prepare(`SELECT identity FROM ${schema}.storage_identity`).get()?.identity!==expected)
        throw new Error('数据库文件组身份不匹配，停止启动：'+schema);
    }
  }
  atomicJournals(raw);
}

// 仅重写 DDL 中的标识符；字符串/注释从不参与替换。
function tokens(sql) {
  const re=/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\[(?:[^\]])*\]|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g;
  return [...sql.matchAll(re)].filter(m=>!m[0].startsWith('--')&&!m[0].startsWith('/*')).map(m=>({s:m[0],v:m[0].replace(/^["\[]|["\]]$/g,''),i:m.index,end:m.index+m[0].length}));
}
function rewriteDDL(sql, raw) {
  const ts=tokens(sql), edits=[], commands=[];
  for(let i=0;i<ts.length;i++) {
    const op=ts[i].v.toUpperCase();
    if(!['CREATE','ALTER','DROP'].includes(op))continue;
    // CREATE in a literal is not a token with this value.
    if(ts[i].s.startsWith("'"))continue;
    let j=i+1;
    while(['UNIQUE','TEMP','TEMPORARY','VIRTUAL'].includes(ts[j]?.v.toUpperCase()))j++;
    const kind=ts[j++]?.v.toUpperCase();
    if(!['TABLE','INDEX','TRIGGER','VIEW'].includes(kind))continue;
    while(['IF','NOT','EXISTS'].includes(ts[j]?.v.toUpperCase()))j++;
    const name=ts[j]; if(!name||ts[j+1]?.s==='.')continue;
    let table=name.v;
    if(kind==='INDEX'||kind==='TRIGGER') {
      let k=j+1; while(k<ts.length&&ts[k].s!==';'&&ts[k].v.toUpperCase()!=='ON')k++;
      table=ts[k+1]?.v;
      if(!table&&op==='DROP') {
        for(const schema of ['main','task_store','runtime_store']) if(raw.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE name=?`).get(name.v)){table=schema==='task_store'?'cards':schema==='runtime_store'?'agent_runs':null;break;}
      }
    }
    const schema=own(table);
    if(schema!=='main')edits.push({i:name.i,end:name.i,s:schema+'.'});
    commands.push({start:i,end:j});
  }
  // memories is a compatibility VIEW after splitting. Physical constraints/indexes target knowledge_records.
  if(commands.length)for(const t of ts)if(t.v==='memories'&&!t.s.startsWith("'"))edits.push({i:t.i,end:t.end,s:'knowledge_records'});
  for(const e of edits.sort((a,b)=>b.i-a.i))sql=sql.slice(0,e.i)+e.s+sql.slice(e.end);
  return sql;
}

function installCompatibility(db, raw, readOnly=false) {
  // ★ A1/A2（2026-11-06）：任务检索索引必须显式建在 task_store。
  //   为什么不放 db.js 的 SCHEMA：新库首启时 storage 尚未拆分/覆写 db.exec，SCHEMA 里的
  //   CREATE VIRTUAL TABLE 会落到主库，随后 finishStorage 的 moveTable 与本表撞名失败。
  if(!readOnly) raw.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS task_store.task_fts USING fts5(
      content,
      project UNINDEXED,
      tokenize = 'trigram case_sensitive 0'
    );
    CREATE TABLE IF NOT EXISTS task_store.task_gram(gram TEXT NOT NULL, memory_id INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS task_store.idx_task_gram_lookup ON task_gram(gram, memory_id);
    CREATE INDEX IF NOT EXISTS task_store.idx_task_gram_memory ON task_gram(memory_id);`);
  // ★ A3（2026-11-06）：任务向量归属任务库。
  //   写侧：db.js 的 upsertVector/deleteVector 按 memory_id 归属显式选物理表
  //   （视图不能承接 ON CONFLICT upsert，所以读取才用视图）。
  //   读侧：TEMP VIEW memory_vectors 跨库 UNION，既有 JOIN 查询零改动。
  if(!readOnly) raw.exec(`CREATE TABLE IF NOT EXISTS task_store.memory_vectors(
    memory_id INTEGER PRIMARY KEY,
    embedding BLOB NOT NULL,
    embed_model TEXT NOT NULL DEFAULT 'unknown',
    dim INTEGER NOT NULL DEFAULT 0);`);
  // ★ 2026-11-17（B8 删视图预演）：设 MEMORYOS_NO_VIEWS=1 时不建两个跨库 UNION 视图，
  //   用于实测「还有谁真的依赖 temp.memories / temp.memory_vectors」。默认不设 = 行为完全不变。
  const NO_VIEWS = process.env.MEMORYOS_NO_VIEWS === "1";
  if(!NO_VIEWS && has(raw,'memory_vectors','task_store'))
    raw.exec(`CREATE TEMP VIEW memory_vectors AS
      SELECT memory_id,embedding,embed_model,dim FROM main.memory_vectors
      UNION ALL SELECT memory_id,embedding,embed_model,dim FROM task_store.memory_vectors;`);
  const cols=raw.prepare('PRAGMA main.table_info(knowledge_records)').all();
  const names=cols.map(c=>qi(c.name)).join(',');
  raw.exec(`CREATE TEMP VIEW storage_schema AS SELECT * FROM main.sqlite_master UNION ALL SELECT * FROM task_store.sqlite_master UNION ALL SELECT * FROM runtime_store.sqlite_master;
    CREATE TEMP TABLE storage_effects(n INTEGER NOT NULL,last_id INTEGER); INSERT INTO storage_effects VALUES(0,NULL);`);
  if(!NO_VIEWS)
    raw.exec(`CREATE TEMP VIEW memories AS SELECT ${names} FROM main.knowledge_records UNION ALL SELECT ${names} FROM task_store.task_records;`);
  // ★ 第二批·编号彻底分离：任务号独立序列 task_sequence（记忆仍用 record_sequence）。
  //   ★ A5（2026-11-06）：序列表迁到任务库 task_store.task_sequence，主库不再持有任务相关表。
  //   旧库（A5 之前已拆）的序列还在 main.task_sequence —— 启动时一次性把高水位合并过去再删主库表，
  //   否则新任务号会从 max(id)+1 重来（可能重号）或回退。
  //   只读连接（诊断/备份校验）不写库；若该库尚未升级则退化为旧单序列（只读路径不取号，无副作用）。
  let splitSeq=!!raw.prepare("SELECT 1 FROM task_store.sqlite_master WHERE type='table' AND name='task_sequence'").get();
  if(!readOnly) {
    // 稳态零写入：先只读判断是否真的需要迁移（表未建 / 序列落后于 max(id)+1 / 主库仍留旧表）。
    // 为什么必须这样：多进程（dashboard/daemon/server）都会跑本函数，每次启动无条件写会争 DELETE 日志写锁，
    // 实测会抛 database is locked 导致启动失败。只有确实要迁移时才进写事务。
    const legacyExists=!!raw.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='task_sequence'").get();
    let need=!splitSeq||legacyExists;
    if(!need) {
      const cur=Number(raw.prepare('SELECT value FROM task_store.task_sequence WHERE id=1').get()?.value??0);
      const maxTask=Number(raw.prepare('SELECT max(id) m FROM task_store.task_records').get()?.m??0);
      // 水位口径：value 记录「已发出的最大任务号」，稳态应 >= max(id)，不是 max(id)+1
      // （AFTER INSERT 用 max(value,NEW.id)，id=值时不递增；写 +1 会让每次启动都误判为需迁移）。
      if(cur<Math.max(700000,maxTask)) need=true;
    }
    if(need) {
      raw.exec('SAVEPOINT task_sequence_move');
      try {
        raw.exec(`CREATE TABLE IF NOT EXISTS task_store.task_sequence(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
          INSERT INTO task_store.task_sequence(id,value) SELECT 1,max(700000,coalesce((SELECT max(id) FROM task_store.task_records),0)+1) WHERE NOT EXISTS(SELECT 1 FROM task_store.task_sequence WHERE id=1);
          UPDATE task_store.task_sequence SET value=max(700000,value) WHERE id=1 AND value<700000;`);
        const legacy=legacyExists?Number(raw.prepare('SELECT value FROM main.task_sequence WHERE id=1').get()?.value??0):0;
        if(legacy>0) raw.prepare('UPDATE task_store.task_sequence SET value=max(value,?) WHERE id=1').run(legacy);
        raw.exec('DROP TABLE IF EXISTS main.task_sequence; RELEASE task_sequence_move');
      } catch(e) { try { raw.exec('ROLLBACK TO task_sequence_move; RELEASE task_sequence_move'); } catch { } throw e; }
    }
    splitSeq=true;
  }
  const taskSeq = splitSeq ? "coalesce(NEW.type,'experience')='task'" : "0";
  const nextId = splitSeq
    ? "CASE WHEN coalesce(NEW.type,'experience')='task' THEN (SELECT value FROM task_store.task_sequence WHERE id=1) ELSE (SELECT value FROM record_sequence WHERE id=1) END"
    : "(SELECT value FROM record_sequence WHERE id=1)";
  const values=cols.map(c=>c.name==='id'?`coalesce(NEW.id,${nextId})`:c.dflt_value!=null?`coalesce(NEW.${qi(c.name)},${c.dflt_value})`:`NEW.${qi(c.name)}`).join(',');
  const insert=(table,condition)=>`INSERT INTO ${table}(${names}) SELECT ${values} WHERE ${condition};`;
  const updates=cols.filter(c=>c.name!=='id').map(c=>`${qi(c.name)}=NEW.${qi(c.name)}`).join(',');
  raw.exec(`CREATE TEMP TRIGGER records_insert INSTEAD OF INSERT ON temp.memories BEGIN
    SELECT CASE WHEN NEW.id IS NOT NULL AND (NEW.id<=0 OR EXISTS(SELECT 1 FROM memories WHERE id=NEW.id)) THEN RAISE(ABORT,'记录编号已存在或无效') END;
    SELECT CASE WHEN NEW.idempotency_key IS NOT NULL AND EXISTS(SELECT 1 FROM memories WHERE idempotency_key=NEW.idempotency_key) THEN RAISE(ABORT,'幂等键已存在') END;
    UPDATE record_sequence SET value=CASE WHEN NEW.id IS NOT NULL THEN max(value,NEW.id) ELSE value+1 END WHERE id=1 AND NOT (${taskSeq});
    ${splitSeq?`UPDATE task_store.task_sequence SET value=CASE WHEN NEW.id IS NOT NULL THEN max(value,NEW.id) ELSE value+1 END WHERE id=1 AND NEW.type='task';`:''}
    ${insert('knowledge_records',"coalesce(NEW.type,'experience')<>'task'")}
    ${insert('task_records',"NEW.type='task'")}
    UPDATE storage_effects SET n=n+1,last_id=${splitSeq?"CASE WHEN NEW.id IS NOT NULL THEN NEW.id WHEN NEW.type='task' THEN (SELECT value FROM task_store.task_sequence WHERE id=1) ELSE (SELECT value FROM record_sequence WHERE id=1) END":"(SELECT CASE WHEN NEW.id IS NULL THEN value ELSE NEW.id END FROM record_sequence WHERE id=1)"};
  END;
  CREATE TEMP TRIGGER records_update INSTEAD OF UPDATE ON temp.memories BEGIN
    SELECT CASE WHEN NEW.id<>OLD.id THEN RAISE(ABORT,'不允许更改记录编号') END;
    SELECT CASE WHEN NEW.type<>OLD.type AND (NEW.type='task' OR OLD.type='task') THEN RAISE(ABORT,'任务与知识不可通过修改类型互转，请使用创建任务或提炼知识') END;
    -- ★ A8：按归属只打一张物理表。原实现两张都 UPDATE（另一张 WHERE 0 行），
    --   会在跨库触发器上白跑一趟，且无法据此判断「这次改的到底是任务还是知识」。
    UPDATE knowledge_records SET ${updates} WHERE id=OLD.id AND coalesce(OLD.type,'experience')<>'task';
    UPDATE task_records SET ${updates} WHERE id=OLD.id AND OLD.type='task';
    UPDATE storage_effects SET n=n+1;
  END;
  CREATE TEMP TRIGGER records_delete INSTEAD OF DELETE ON temp.memories BEGIN
    DELETE FROM knowledge_records WHERE id=OLD.id AND coalesce(OLD.type,'experience')<>'task';
    DELETE FROM task_records WHERE id=OLD.id AND OLD.type='task';
    UPDATE storage_effects SET n=n+1;
  END;`);
  // TEMP 触发器允许维护跨库的可重建检索索引。任务主记录只存在 task_records。
  // ★ A1（2026-11-06）：任务索引改写到任务库 task_store.task_fts，主库 memories_fts 只留知识。
  //   搬索引必须与 lexSearch 双库合并同批上线，否则任务会「静默搜不到」。
  for(const op of ['INSERT','UPDATE','DELETE']) {
    const row=op==='DELETE'?'OLD':'NEW';
    const event=op==='UPDATE'?'UPDATE OF content, project, status, type, sector, salience, decay_lambda, pinned, valid_until, sensitivity, source_ref, embedding_stale, version':op;
    raw.exec(`CREATE TEMP TRIGGER task_index_${op.toLowerCase()} AFTER ${event} ON task_store.task_records BEGIN
      DELETE FROM task_store.task_fts WHERE rowid=${row}.id;
      ${op==='DELETE'?'':`INSERT INTO task_store.task_fts(rowid,content,project) VALUES(NEW.id,NEW.content,NEW.project);`}
      UPDATE config SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='vec_gen';
    END;`);
  }
  // .changes / lastInsertRowid 必须返回实际业务行数，不能采信 INSTEAD OF 触发器的原生 0。
  db.prepare=function(sql) {
    let text=String(sql);
    if(/\b(?:CREATE|ALTER|DROP)\b/i.test(text))text=rewriteDDL(text,raw);
    else text=text.replace(/\bsqlite_master\b/g,'storage_schema');
    const statement=raw.prepare(text);
    // UPDATE 必须保留原 SET 列集合，否则视图触发器会误触发 UPDATE OF content/version 索引失效。
    if(/^\s*UPDATE\s+memories\s+SET\b/i.test(text)) {
      const physical=['knowledge_records','task_records'].map(table=>raw.prepare(text.replace(/^(\s*UPDATE\s+)memories\b/i,'$1'+table)));
      statement.run=(...args)=>{
        raw.exec('SAVEPOINT storage_record_update');
        try {
          const results=physical.map(s=>s.run(...args));
          raw.exec('RELEASE storage_record_update');
          return {...results[0],changes:results.reduce((n,r)=>n+Number(r.changes),0)};
        }catch(e){raw.exec('ROLLBACK TO storage_record_update; RELEASE storage_record_update');throw e;}
      };
      return statement;
    }
    if(/^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["\[]?memories\b/i.test(text)) {
      const run=statement.run.bind(statement);
      statement.run=(...args)=>{
        const before=raw.prepare('SELECT n FROM temp.storage_effects').get().n;
        const out=run(...args),after=raw.prepare('SELECT * FROM temp.storage_effects').get();
        return {...out,changes:Number(after.n)-Number(before),lastInsertRowid:after.last_id??out.lastInsertRowid};
      };
    }
    return statement;
  };
  db.exec=sql=>raw.exec(rewriteDDL(String(sql),raw));
  if(!readOnly)ftsBackfillTasks(raw);
}

/**
 * ★ 2026-11-01 首启加速：任务记录 FTS 回填改为「可重试 + 不致命」。
 *   原实现裸 exec，与 daemon 首轮治理（单事务持写锁约 16s）撞锁即抛 "database is locked"，
 *   dashboard 进程直接退出 → 自愈重启两轮 → 首启白等 24s（desktop.log 2026/11/1 13:36:32→13:36:56）。
 *   回填本身是幂等修复动作（NOT EXISTS 过滤），失败不该阻断启动：退避重试 3 次，
 *   仍失败则告警放行——下次打开会再次尝试，期间任务记录仅少 FTS 命中，不影响主库。
 */
function ftsBackfillTasks(raw) {
  const sql=`INSERT INTO task_store.task_fts(rowid,content,project) SELECT id,content,project FROM task_store.task_records t WHERE NOT EXISTS(SELECT 1 FROM task_store.task_fts f WHERE f.rowid=t.id);`;
  const delays=[0,1000,3000];
  let lastErr=null;
  for(const wait of delays) {
    if(wait) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait); // 同步退避（启动路径，不烧 CPU）
    try { raw.exec(sql); return; }
    catch(e) {
      lastErr=e;
      if(!/database is locked|SQLITE_BUSY|database table is locked/i.test(String(e?.message||e))) break;
    }
  }
  console.error(`[storage] 任务 FTS 回填失败（不阻断启动，下次打开重试）: ${lastErr instanceof Error?lastErr.message:String(lastErr)}`);
}

function rawMethods(db) {return {exec:db.exec.bind(db),prepare:db.prepare.bind(db)};}
export function resumeStorage(db, dbPath, readOnly=false) {
  const raw=rawMethods(db);
  if(!has(raw,'storage_meta'))return false;
  const meta=raw.prepare('SELECT * FROM main.storage_meta WHERE id=1').get();
  if(meta?.version!==1)throw new Error('未知存储版本，停止启动');
  const files=filesFor(dbPath); attach(raw,files,meta.identity,readOnly);
  db.storage={version:1,identity:meta.identity,files,raw};
  installCompatibility(db,raw,readOnly);
  return true;
}
/** 诊断/验收连接：不迁移、不补表；只读选项覆盖全部附加库。 */
export function StorageConnection(file, options={}) {
  const db=new DatabaseSync(file,options);
  db.exec('PRAGMA busy_timeout=5000');
  try{resumeStorage(db,file,options.readOnly===true);return db;}catch(e){db.close();throw e;}
}

function moveTable(raw, name, schema) {
  const row=raw.prepare("SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?").get(name);
  if(!row)return;
  const ddl=row.sql.replace(/^(CREATE\s+TABLE\s+)(?:"[^"]+"|\w+)/i,`$1${schema}.${qi(name)}`);
  raw.exec(ddl);
  raw.exec(`INSERT INTO ${schema}.${qi(name)} SELECT * FROM main.${qi(name)}`);
  const seq=has(raw,'sqlite_sequence')?raw.prepare('SELECT seq FROM main.sqlite_sequence WHERE name=?').get(name):null;
  if(seq){raw.prepare(`DELETE FROM ${schema}.sqlite_sequence WHERE name=?`).run(name);raw.prepare(`INSERT INTO ${schema}.sqlite_sequence(name,seq) VALUES(?,?)`).run(name,seq.seq);}
  const objects=raw.prepare("SELECT type,name,sql FROM main.sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL").all(name);
  for(const o of objects){raw.exec(`DROP ${o.type.toUpperCase()} main.${qi(o.name)}`);raw.exec(o.sql.replace(new RegExp(`^(CREATE\\s+(?:UNIQUE\\s+)?${o.type}\\s+)(?:"[^"]+"|\\w+)`,'i'),`$1${schema}.${qi(o.name)}`));}
  raw.exec(`DROP TABLE main.${qi(name)}`);
}
export function finishStorage(db, dbPath) {
  if(db.storage)return;
  const raw=rawMethods(db), files=filesFor(dbPath);
  // 旧库先做一致快照；不读取或复制 .env / 凭据配置文件。
  if(dbPath!==':memory:') {
    const dir=path.join(path.dirname(dbPath),'backup');fs.mkdirSync(dir,{recursive:true});
    const backup=path.join(dir,'before-storage-split-'+Date.now()+'-'+randomUUID().slice(0,8)+'.db');
    raw.exec(`VACUUM main INTO ${literal(backup)}`);
  }
  for(const schema of ['task_store','runtime_store'])if(files[schema]!==':memory:'&&fs.existsSync(files[schema]))throw new Error('目标分库已存在且主库无迁移标记，停止以防覆盖：'+files[schema]);
  attach(raw,files);
  const identity=randomUUID();
  raw.exec('BEGIN IMMEDIATE');
  try {
    raw.exec('CREATE TABLE storage_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,identity TEXT NOT NULL);');
    raw.prepare('INSERT INTO storage_meta VALUES(1,1,?)').run(identity);
    for(const schema of ['task_store','runtime_store']){raw.exec(`CREATE TABLE ${schema}.storage_identity(identity TEXT NOT NULL)`);raw.prepare(`INSERT INTO ${schema}.storage_identity VALUES(?)`).run(identity);}
    for(const name of TASK_TABLES)moveTable(raw,name,'task_store');
    for(const name of RUNTIME_TABLES)moveTable(raw,name,'runtime_store');
    raw.exec('ALTER TABLE main.memories RENAME TO knowledge_records');
    const memoryDDL=raw.prepare("SELECT sql FROM main.sqlite_master WHERE name='knowledge_records'").get().sql;
    raw.exec(memoryDDL.replace(/^(CREATE TABLE\s+)(?:"[^"]+"|\w+)/i,'$1task_store.task_records'));
    for(const index of raw.prepare("SELECT name,sql FROM main.sqlite_master WHERE type='index' AND tbl_name='knowledge_records' AND sql IS NOT NULL").all()) {
      raw.exec(index.sql.replace(/^(CREATE\s+(?:UNIQUE\s+)?INDEX\s+)(?:"[^"]+"|\w+)/i,'$1task_store.'+qi('task_'+index.name)).replace(/\bON\s+"?knowledge_records"?/i,'ON task_records'));
    }
    // 保留已删除 ID 的高水位，迁移后不复用历史编号。
    const high=Number(raw.prepare("SELECT max(coalesce((SELECT seq FROM main.sqlite_sequence WHERE name='knowledge_records'),0),coalesce((SELECT max(id) FROM knowledge_records),0)) n").get().n);
    raw.exec("INSERT INTO task_store.task_records SELECT * FROM main.knowledge_records WHERE type='task'; DELETE FROM main.knowledge_records WHERE type='task';");
    raw.exec('CREATE TABLE record_sequence(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);');
    raw.prepare('INSERT INTO record_sequence VALUES(1,?)').run(high);
    raw.exec('CREATE VIEW main.memories AS SELECT * FROM knowledge_records');
    raw.exec("CREATE TRIGGER knowledge_task_guard BEFORE INSERT ON knowledge_records WHEN NEW.type='task' BEGIN SELECT RAISE(ABORT,'任务必须写入任务库'); END;");
    raw.exec("CREATE TRIGGER knowledge_type_guard BEFORE UPDATE OF type ON knowledge_records WHEN NEW.type='task' BEGIN SELECT RAISE(ABORT,'任务与知识不可直接互转'); END;");
    raw.exec("CREATE TRIGGER task_store.task_type_insert_guard BEFORE INSERT ON task_records WHEN NEW.type<>'task' BEGIN SELECT RAISE(ABORT,'任务库只接收任务记录'); END;");
    raw.exec("CREATE TRIGGER task_store.task_type_update_guard BEFORE UPDATE OF type ON task_records WHEN NEW.type<>'task' BEGIN SELECT RAISE(ABORT,'任务与知识不可直接互转'); END;");
    raw.exec('COMMIT');
  }catch(e){raw.exec('ROLLBACK');throw e;}
  db.storage={version:1,identity,files,raw};
  try{raw.exec('VACUUM main');}catch(e){console.error('[storage] 分库已提交，主库空闲页压缩延后：'+e.message);}
  installCompatibility(db,raw);
}

export function storageStatus(db) {
  if(!db.storage)return {version:0,mode:'legacy'};
  const {raw,files,identity}=db.storage;
  return {version:1,identity,journal:'DELETE',databases:Object.entries(files).map(([schema,file])=>({schema,file,
    tables:raw.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(r=>r.name)})),
    knowledge:Number(raw.prepare('SELECT count(*) n FROM main.knowledge_records').get().n),
    tasks:Number(raw.prepare('SELECT count(*) n FROM task_store.task_records').get().n)};
}
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** 整组备份目录命名（严格匹配才允许保留策略触碰）：storage-YYYY-MM-DD。
 *  hotupdate-*、手工放进 backup/ 的目录、storage-*.partial-* 一律不匹配 → 天然免疫误删。 */
const BACKUP_DIR_RE = /^storage-(\d{4})-(\d{2})-(\d{2})(?:-[\da-fT-]+)?$/;
/**
 * 整组备份保留策略：只保留最近 keep 份（默认 7），更旧的**移入同盘待删区**而非 rm。
 * 安全边界（#700060 卡面要求）：
 *   ① 命名必须严格匹配 storage-YYYY-MM-DD，其它目录只看不碰；
 *   ② 移走前必须通过 validateBundle（清单/三成员/sha256/identity/integrity_check 全过），
 *      校验失败只记 skipped，原样保留；
 *   ③ 目标是 path.dirname(root)/_pending-delete-<date>/<原目录名> —— 同名即跳过不覆盖，
 *      还原只需把目录 mv 回 backup/。
 */
export function pruneBackups(root, opts = {}) {
  const keep = Math.max(1, Math.min(Number(opts.keep ?? 7) || 7, 90));
  const stamp = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const pendingRoot = opts.pendingRoot ?? path.join(path.dirname(root), '_pending-delete-' + stamp);
  const result = { keep, kept: [], removed: [], pendingRoot, skipped: [] };
  if (!fs.existsSync(root)) return result;
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && BACKUP_DIR_RE.test(d.name))
    .map(d => ({ name: d.name, date: d.name.slice('storage-'.length) }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  result.kept = dirs.slice(0, keep).map(d => d.name);
  for (const d of dirs.slice(keep)) {
    const src = path.join(root, d.name);
    try { validateBundle(src); }
    catch (e) { result.skipped.push({ name: d.name, reason: '校验未通过，原样保留：' + (e instanceof Error ? e.message : String(e)) }); continue; }
    fs.mkdirSync(pendingRoot, { recursive: true });
    const dest = path.join(pendingRoot, d.name);
    if (fs.existsSync(dest)) { result.skipped.push({ name: d.name, reason: '待删区已存在同名目录，不覆盖' }); continue; }
    fs.renameSync(src, dest);
    result.removed.push(d.name);
  }
  return result;
}
export function backupStorage(db, dbPath, opts={}) {
  const {raw,files,identity}=db.storage;
  if(dbPath===':memory:')throw new Error('内存数据库无法生成可恢复文件组');
  const root=opts.dir??path.join(path.dirname(dbPath),'backup'), stamp=(opts.now??new Date()).toISOString().slice(0,10);
  fs.mkdirSync(root,{recursive:true});
  const target=path.join(root,'storage-'+stamp+(opts.manual?'-'+Date.now().toString(16)+'-'+randomUUID().slice(0,8):''));
  if(fs.existsSync(path.join(target,'manifest.json'))) {validateBundle(target);return {created:null,removed:[],note:'今日整组备份已存在且校验有效'};}
  const staging=target+'.partial-'+randomUUID();fs.mkdirSync(staging);
  // 另一个连接持有 RESERVED 写锁；源连接 VACUUM INTO 只读，整组期间禁止任何写者提交。
  const lock=new DatabaseSync(files.main);lock.exec('PRAGMA busy_timeout=5000');
  const lockRaw=rawMethods(lock);attach(lockRaw,files,identity);
  try {
    lock.exec('BEGIN IMMEDIATE');
    const members=[];
    for(const [schema,file] of Object.entries(files)) {
      const name=path.basename(file),dest=path.join(staging,name);
      raw.exec(`VACUUM ${schema} INTO ${literal(dest)}`);
      members.push({schema,name,sha256:digest(dest),bytes:fs.statSync(dest).size});
    }
    fs.writeFileSync(path.join(staging,'manifest.json'),JSON.stringify({version:1,identity,created_at:new Date().toISOString(),members},null,2));
    lock.exec('ROLLBACK');
    validateBundle(staging);
    if(fs.existsSync(target))throw new Error('备份目录已存在但缺少有效清单，保留残留目录并停止');
    fs.renameSync(staging,target);
    // ★ #700060：备份成功后执行保留策略（移入同盘待删区，不 rm）。保留失败不影响本次备份。
    let pruned={kept:[],removed:[],pendingRoot:'',skipped:[]};
    try{pruned=pruneBackups(root,{keep:opts.keep,now:opts.now});}catch(e){pruned.error=e instanceof Error?e.message:String(e);}
    return {created:target,kept:pruned.kept,removed:pruned.removed,pendingDir:pruned.pendingRoot,skipped:pruned.skipped,
      note:'已完成三库一致快照及 SHA256 校验：'+target+(pruned.removed.length?'；按 keep='+pruned.keep+' 移入待删区 '+pruned.removed.length+' 份':'' )+(pruned.error?'；保留策略失败（不影响备份）：'+pruned.error:'')};
  }finally{if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();}
}
export function validateBundle(dir) {
  const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  if(manifest.version!==1||!Array.isArray(manifest.members)||manifest.members.length!==3)throw new Error('备份清单无效');
  const schemas=new Set();
  for(const member of manifest.members) {
    if(!['main','task_store','runtime_store'].includes(member.schema)||schemas.has(member.schema)||path.basename(member.name)!==member.name)throw new Error('备份成员无效');
    schemas.add(member.schema);
    const file=path.join(dir,member.name);
    if(digest(file)!==member.sha256)throw new Error('备份校验失败：'+member.name);
    const test=new DatabaseSync(file,{readOnly:true});
    try {
      if(test.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('数据库完整性检查失败：'+member.name);
      const table=member.schema==='main'?'storage_meta':'storage_identity';
      if(test.prepare(`SELECT identity FROM ${table}`).get()?.identity!==manifest.identity)throw new Error('备份身份不匹配');
    }finally{test.close();}
  }
  for(const extra of manifest.extras||[]){if(!['settings.json','sources.json','interface.json'].includes(extra.name)||digest(path.join(dir,extra.name))!==extra.sha256)throw new Error('备份配置校验失败');}
  return manifest;
}
export function restoreBundle(dir, targetDir) {
  const manifest=validateBundle(dir);
  if(fs.existsSync(targetDir))throw new Error('恢复目标必须是尚不存在的独立目录');
  const staging=targetDir+'.partial-'+randomUUID();fs.mkdirSync(staging,{recursive:true});
  for(const member of manifest.members)fs.copyFileSync(path.join(dir,member.name),path.join(staging,member.name));
  fs.renameSync(staging,targetDir);
  return path.join(targetDir,manifest.members.find(m=>m.schema==='main').name);
}
/** 单库导出用 CJK 2-gram 切分：与 db.js::gramTokens 同规则（相邻 CJK 二元组、非 CJK 打断、单条上限 4000）。 */
function cjkGrams(text) {
  const out=new Set();let prev='';
  for(const ch of String(text??'')) {
    if(/[\u4e00-\u9fff]/.test(ch)) { if(prev)out.add(prev+ch); prev=ch; if(out.size>=4000)break; }
    else prev='';
  }
  return [...out];
}
/** 从已校验的一致快照导出旧版单库。只写尚不存在的目标文件，保留所有新任务。 */
export function exportLegacy(dir, targetFile) {
  const manifest=validateBundle(dir);
  if(fs.existsSync(targetFile))throw new Error('单库回退目标已存在，停止以免覆盖');
  const source=path.join(dir,manifest.members.find(m=>m.schema==='main').name);
  fs.mkdirSync(path.dirname(targetFile),{recursive:true});
  const input=new DatabaseSync(source,{readOnly:true});
  try{input.prepare('VACUUM INTO ?').run(targetFile);}finally{input.close();}
  const db=new DatabaseSync(targetFile);
  try {
    for(const schema of ['task_store','runtime_store'])db.prepare(`ATTACH DATABASE ? AS ${schema}`).run(path.join(dir,manifest.members.find(m=>m.schema===schema).name));
    db.exec('BEGIN IMMEDIATE; DROP VIEW main.memories; DROP TRIGGER main.knowledge_task_guard; DROP TRIGGER IF EXISTS main.knowledge_type_guard; ALTER TABLE main.knowledge_records RENAME TO memories;');
    // 主库 FTS 已不含任务索引（A1 搬库后本 DELETE 为空操作，保留以兼容更早的备份包）；
    // 单库态由恢复的 INSERT 触发器把任务重新写回 memories_fts。
    db.exec('DELETE FROM main.memories_fts WHERE rowid IN (SELECT id FROM task_store.task_records); INSERT INTO main.memories SELECT * FROM task_store.task_records;');
    for(const schema of ['task_store','runtime_store']) {
      // ★ A1：task_fts 是虚拟表且带 *_data/_idx/_content/_docsize/_config 影子表，
      //   影子表名不能被显式 CREATE（object name reserved for internal use）；
      //   单库态的全文检索由 memories_fts 承担，故整组跳过。
      // ★ A9（2026-11-06）：task_sequence / memory_vectors 必须跳过拷贝——主库已有同名表会撞，
      //   序列在单库态不需要（走 sqlite_sequence），向量在下方单独合并。
      for(const row of db.prepare(`SELECT name,sql FROM ${schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'task_fts%' AND name NOT IN ('storage_identity','task_records','task_sequence','memory_vectors')`).all()) {
        // 自动词表按知识/任务分别存储；回退单库时合并行，不能重复建同名表。
        if(row.name.startsWith('memory_') && ['memory_auto_terms','memory_manual_terms','memory_metadata_state','memory_metadata_dirty','memory_metadata_epoch'].includes(row.name) && has(rawMethods(db),row.name,'main')) {
          if(row.name==='memory_metadata_epoch')db.exec(`UPDATE main.memory_metadata_epoch SET epoch=epoch+(SELECT epoch FROM ${schema}.memory_metadata_epoch WHERE id=1) WHERE id=1`);
          else db.exec(`INSERT OR IGNORE INTO main.${qi(row.name)} SELECT * FROM ${schema}.${qi(row.name)}`);
          continue;
        }
        db.exec(row.sql);db.exec(`INSERT INTO main.${qi(row.name)} SELECT * FROM ${schema}.${qi(row.name)}`);
        for(const object of db.prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL`).all(row.name))db.exec(object.sql);
        if(has(rawMethods(db),'sqlite_sequence',schema)) {
          const seq=db.prepare(`SELECT seq FROM ${schema}.sqlite_sequence WHERE name=?`).get(row.name);
          if(seq){db.prepare('DELETE FROM main.sqlite_sequence WHERE name=?').run(row.name);db.prepare('INSERT INTO main.sqlite_sequence VALUES(?,?)').run(row.name,seq.seq);}
        }
      }
    }
    // ★ A9（2026-11-06）：单库导出必须补齐任务检索索引，否则「有正文、搜不到」。
    //   FTS：memories 的 AFTER INSERT 触发器已写；这里按 rowid 兜底补齐（兼容触发器缺失的早期备份包）。
    db.exec(`INSERT INTO main.memories_fts(rowid,content,project) SELECT m.id,m.content,m.project FROM main.memories m WHERE NOT EXISTS(SELECT 1 FROM main.memories_fts f WHERE f.rowid=m.id)`);
    //   gram：没有触发器，必须显式重建——中文 2 字词只走 gram 探针，缺它能搜到正文却搜不到任务。
    const gramIns=db.prepare('INSERT INTO main.memories_gram(gram,memory_id) VALUES(?,?)');
    for(const m of db.prepare(`SELECT m.id,m.content FROM main.memories m WHERE NOT EXISTS(SELECT 1 FROM main.memories_gram g WHERE g.memory_id=m.id)`).all()) {
      const grams=cjkGrams(m.content);
      if(!grams.length)gramIns.run('',m.id);else for(const g of grams)gramIns.run(g,m.id);
    }
    //   向量：组 3 之后任务向量在 task_store.memory_vectors，单库态必须合并回主库，否则任务只能词法检索。
    if(has(rawMethods(db),'memory_vectors','task_store'))
      db.exec('INSERT OR IGNORE INTO main.memory_vectors(memory_id,embedding,embed_model,dim) SELECT memory_id,embedding,embed_model,dim FROM task_store.memory_vectors');
    // ★ 第二批·编号分离：回退到单库时两个取号表都不再需要（legacy 走 sqlite_sequence 自增）
    db.exec('DROP TABLE main.storage_meta; DROP TABLE main.record_sequence; DROP TABLE IF EXISTS main.task_sequence; COMMIT;');
    if(db.prepare('PRAGMA main.integrity_check').get().integrity_check!=='ok')throw new Error('回退导出完整性检查失败');
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
  return targetFile;
}
