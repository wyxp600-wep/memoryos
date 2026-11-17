/** 可重建的搜索元数据；原文始终是唯一事实来源，不调用模型、不改写正文。 */
import { createHash } from 'node:crypto';
import { memoryFields, ALL_PROJECTS } from './memory-fields.js';

export const METADATA_VERSION = 'terms-v1';
const segmenter = new Intl.Segmenter('zh-CN', {granularity:'word'});
const STOP = new Set('如何 怎么 什么 为什么 是否 可以 需要 进行 当前 本次 问题 修复 优化 记忆 搜索 读取 上传 内容 信息 结果 结论 关键词 适用 范围 依据 行动 状态 验证 已验证 待验证 已替代 日期 最后 核验 以及 但是 如果 这个 那个 一个 一些 所有 通过 使用 确保 支持 没有 已经 不能 必须 默认 实际 the and for with from into this that then than when where which what how are was were not only should would could have has had'.split(' '));
const norm = s => String(s).normalize('NFKC').trim().toLowerCase();
function usable(s) {return s.length>=2 && s.length<=80 && !STOP.has(norm(s)) && !/^\d+$/.test(s);}
/** 查询和正文共用分词，保留错误码、组件名、文件名及中英混合词。 */
export function queryKeywords(text) {
    const out=new Map(), add=s=>{const t=String(s).trim();if(usable(t)&&!out.has(norm(t)))out.set(norm(t),t);};
    const value=String(text??'').normalize('NFKC');
    for(const m of value.matchAll(/[A-Za-z][A-Za-z0-9_]*(?:[.\/-][A-Za-z0-9_]+)*/g))add(m[0]);
    for(const part of segmenter.segment(value))if(part.isWordLike)add(part.segment);
    return [...out.values()].slice(0,32);
}
export function deriveMemoryMetadata(row) {
    const content=String(row.content??''), fields=memoryFields(content), terms=new Map();
    const add=(term,source,weight,kind='keyword')=>{
        term=String(term).trim();const key=kind+'|'+norm(term);if(source==='body:关键词'?(!term||term.length>80):!usable(term))return;
        const old=terms.get(key);if(!old||old.weight<weight)terms.set(key,{kind,term,term_norm:norm(term),source,weight});
    };
    const keys=fields.filter(f=>f.name==='关键词');
    for(const f of keys)for(const term of f.value.split(/[;；,，|\n]/))add(term,'body:关键词',8);
    // 全文计数；不截首段，尾部错误码和条件同样参与。按篇内次数只作有限加权。
    const counts=new Map();
    for(const token of segmenter.segment(content))if(token.isWordLike&&usable(token.segment)){
        const k=norm(token.segment),hit=counts.get(k);if(hit)hit.count++;else counts.set(k,{term:token.segment,count:1});
    }
    for(const {term,count} of counts.values())add(term,'body:token',1+Math.min(count-1,3)*0.2);
    for(const m of content.matchAll(/[A-Za-z][A-Za-z0-9_]*(?:[.\/-][A-Za-z0-9_]+)*/g))add(m[0],'body:identifier',4);
    const conclusion=fields.find(f=>f.name==='结论')?.value??content.split('\n').find(s=>s.trim())??'';
    for(const token of queryKeywords(conclusion))add(token,'body:结论',3);
    for(const m of content.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,40})(?=\s|$)/gu))add(m[1],'body:hashtag',6,'tag');
    for(const [name,value] of [['project',row.project],['type',row.type],['sector',row.sector]])if(value)add(String(value),'record:'+name,5,'tag');
    const ranked=[...terms.values()].sort((a,b)=>b.weight-a.weight||a.term_norm.localeCompare(b.term_norm,'en'));
    const keywords=ranked.filter(t=>t.kind==='keyword').slice(0,64),tags=ranked.filter(t=>t.kind==='tag').slice(0,16);
    // 给无手动标签的条目附少量基于真实原文的主题，保留来源以便核对。
    for(const t of keywords.filter(t=>t.source!=='body:token').slice(0,5))if(!tags.some(x=>x.term_norm===t.term_norm))tags.push({...t,kind:'tag',source:'auto:'+t.source});
    return {version:METADATA_VERSION,hash:createHash('sha256').update(JSON.stringify([content,row.project,row.type,row.sector])).digest('hex'),keywords,tags};
}
const stores=db=>db.storage?[{schema:'main',table:'knowledge_records'},{schema:'task_store',table:'task_records'}]:[{schema:'main',table:'memories'}];
const prefix=s=>s==='main'?'':s+'.';
/** 触发器只排队，无 JS UDF；旧 SQLite 连接也能写，不会因函数未注册而中断业务。 */
export function installMemoryMetadata(db) {
    for(const {schema,table} of stores(db)) {
        const p=prefix(schema);
        db.exec(`CREATE TABLE IF NOT EXISTS ${p}memory_auto_terms(memory_id INTEGER NOT NULL,kind TEXT NOT NULL,term_norm TEXT NOT NULL,term TEXT NOT NULL,source TEXT NOT NULL,weight REAL NOT NULL,PRIMARY KEY(memory_id,kind,term_norm));
          CREATE INDEX IF NOT EXISTS ${p}idx_memory_auto_terms_term ON memory_auto_terms(term_norm,memory_id);
          CREATE TABLE IF NOT EXISTS ${p}memory_metadata_state(memory_id INTEGER PRIMARY KEY,hash TEXT NOT NULL,version TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS ${p}memory_manual_terms(memory_id INTEGER NOT NULL,kind TEXT NOT NULL,term_norm TEXT NOT NULL,term TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(memory_id,kind,term_norm));
          CREATE TABLE IF NOT EXISTS ${p}memory_metadata_dirty(memory_id INTEGER PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS ${p}memory_metadata_epoch(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL);
          INSERT OR IGNORE INTO ${p}memory_metadata_epoch VALUES(1,0);`);
        for(const [name,event] of [['insert','INSERT'],['update','UPDATE OF content,project,type,sector']])
            db.exec(`CREATE TRIGGER IF NOT EXISTS ${p}auto_metadata_${name} AFTER ${event} ON ${table} BEGIN INSERT OR IGNORE INTO memory_metadata_dirty VALUES(NEW.id); UPDATE memory_metadata_epoch SET epoch=epoch+1 WHERE id=1; END;`);
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${p}auto_metadata_delete AFTER DELETE ON ${table} BEGIN DELETE FROM memory_auto_terms WHERE memory_id=OLD.id; DELETE FROM memory_manual_terms WHERE memory_id=OLD.id; DELETE FROM memory_metadata_state WHERE memory_id=OLD.id; DELETE FROM memory_metadata_dirty WHERE memory_id=OLD.id; UPDATE memory_metadata_epoch SET epoch=epoch+1 WHERE id=1; END;`);
        db.prepare(`INSERT OR IGNORE INTO ${p}memory_metadata_dirty SELECT m.id FROM ${p}${table} m LEFT JOIN ${p}memory_metadata_state s ON s.memory_id=m.id WHERE s.memory_id IS NULL OR s.version!=?`).run(METADATA_VERSION);
    }
}
function storeMetadata(db,row,schema) {
    const p=prefix(schema),meta=deriveMemoryMetadata(row);
    db.prepare(`DELETE FROM ${p}memory_auto_terms WHERE memory_id=?`).run(row.id);
    const insert=db.prepare(`INSERT INTO ${p}memory_auto_terms VALUES(?,?,?,?,?,?)`);
    for(const term of [...meta.keywords,...meta.tags])insert.run(row.id,term.kind,term.term_norm,term.term,term.source,term.weight);
    for(const term of db.prepare(`SELECT * FROM ${p}memory_manual_terms WHERE memory_id=?`).all(row.id))
        db.prepare(`INSERT OR REPLACE INTO ${p}memory_auto_terms VALUES(?,?,?,?,?,?)`).run(row.id,term.kind,term.term_norm,term.term,term.source,10);
    db.prepare(`INSERT OR REPLACE INTO ${p}memory_metadata_state VALUES(?,?,?)`).run(row.id,meta.hash,METADATA_VERSION);
    db.prepare(`DELETE FROM ${p}memory_metadata_dirty WHERE memory_id=?`).run(row.id);
    return meta;
}
/** 手动项独立保存，自动重建永不覆盖。省略字段表示保留，空数组表示显式清空。 */
export function setMemoryTerms(db,id,{keywords,tags}={},source='manual') {
    if(keywords===undefined&&tags===undefined)return;
    const row=db.prepare('SELECT type FROM main.knowledge_records WHERE id=?').get(id);if(!row)throw new Error('记忆不存在');
    const p=prefix(db.storage&&row.type==='task'?'task_store':'main');
    for(const [kind,items] of [['keyword',keywords],['tag',tags]])if(items!==undefined){
        if(!Array.isArray(items)||items.length>32||items.some(t=>typeof t!=='string'||!t.trim()||t.trim().length>80))throw new Error('关键词和标签须为不超过32个、每个1～80字的非空词');
        db.prepare(`DELETE FROM ${p}memory_manual_terms WHERE memory_id=? AND kind=?`).run(id,kind);
        for(const term of items)db.prepare(`INSERT OR IGNORE INTO ${p}memory_manual_terms VALUES(?,?,?,?,?)`).run(id,kind,norm(term),term.trim(),source+':'+kind);
    }
    db.prepare(`INSERT OR IGNORE INTO ${p}memory_metadata_dirty VALUES(?)`).run(id);
    db.exec(`UPDATE ${p}memory_metadata_epoch SET epoch=epoch+1 WHERE id=1`);
}
export function refreshMemoryMetadata(db,id) {
    const row=db.prepare('SELECT id,content,type,project,sector FROM main.knowledge_records WHERE id=?').get(id);
    if(!row)return null;
    return storeMetadata(db,row,db.storage&&row.type==='task'?'task_store':'main');
}
export function rebuildMemoryMetadata(db,{limit=Number.MAX_SAFE_INTEGER}={}) {
    let processed=0;
    db.exec('SAVEPOINT metadata_rebuild');
    try {
        for(const {schema,table} of stores(db)) {
            const p=prefix(schema);
            const rows=db.prepare(`SELECT m.id,m.content,m.type,m.project,m.sector FROM ${p}${table} m JOIN ${p}memory_metadata_dirty d ON m.id=d.memory_id ORDER BY m.id LIMIT ?`).all(Math.max(0,limit-processed));
            for(const row of rows){storeMetadata(db,row,schema);processed++;}
        }
        db.exec('RELEASE metadata_rebuild');
    }catch(e){db.exec('ROLLBACK TO metadata_rebuild;RELEASE metadata_rebuild');throw e;}
    return {processed,pending:stores(db).reduce((n,{schema})=>n+Number(db.prepare(`SELECT count(*) n FROM ${prefix(schema)}memory_metadata_dirty`).get().n),0)};
}
export function metadataEpoch(db) {return stores(db).map(({schema})=>db.prepare(`SELECT epoch FROM ${prefix(schema)}memory_metadata_epoch WHERE id=1`).get()?.epoch??0).join(':');}
export function metadataForMemory(db,id) {
    rebuildMemoryMetadata(db);
    const row=db.prepare('SELECT type FROM main.knowledge_records WHERE id=?').get(id);if(!row)return null;
    const p=prefix(db.storage&&row.type==='task'?'task_store':'main');
    const state=db.prepare(`SELECT hash,version FROM ${p}memory_metadata_state WHERE memory_id=?`).get(id);
    const terms=db.prepare(`SELECT kind,term,term_norm,source,weight FROM ${p}memory_auto_terms WHERE memory_id=? ORDER BY weight DESC,term_norm`).all(id);
    return {...state,keywords:terms.filter(t=>t.kind==='keyword'),tags:terms.filter(t=>t.kind==='tag')};
}
export function metadataCandidates(db,terms,project,limit=40,statuses=['active','trial'],filters={}) {
    const normalized=[...new Set((terms??[]).map(norm).filter(t=>t&&t.length<=80))].slice(0,40);if(!normalized.length)return [];
    rebuildMemoryMetadata(db);
    const states=statuses.filter(s=>['active','trial','archived'].includes(s));if(!states.length)return [];
    const index=stores(db).map(({schema})=>`SELECT memory_id,term_norm,term,weight FROM ${prefix(schema)}memory_auto_terms`).join(' UNION ALL ');
    const scope=project===ALL_PROJECTS?'':"AND m.project COLLATE NOCASE IN (?, 'global')";
    const filtering=(filters.type?' AND m.type=?':'')+(filters.agent?' AND m.agent=?':'')+(filters.sector?' AND m.sector=?':'');
    const rows=db.prepare(`SELECT m.id,t.term,t.term_norm,t.weight FROM (${index}) t JOIN main.knowledge_records m ON m.id=t.memory_id WHERE t.term_norm IN (${normalized.map(()=>'?')}) ${scope} ${filtering}
      AND m.status IN (${states.map(()=>'?')}) AND m.sensitivity!='secret' AND m.superseded_by IS NULL
      AND (m.valid_from IS NULL OR julianday(m.valid_from)<=julianday('now')) AND (m.valid_until IS NULL OR julianday(m.valid_until)>julianday('now'))`).all(...normalized,...(scope?[project]:[]),...(filters.type?[filters.type]:[]),...(filters.agent?[filters.agent]:[]),...(filters.sector?[filters.sector]:[]),...states);
    const hits=new Map();for(const row of rows){let hit=hits.get(row.id);if(!hit){hit={id:row.id,terms:new Map(),weight:0};hits.set(row.id,hit);}if(!hit.terms.has(row.term_norm)){hit.terms.set(row.term_norm,row.term);hit.weight+=row.weight;}}
    return [...hits.values()].map(h=>({id:h.id,hits:h.terms.size,weight:h.weight,matched_terms:[...h.terms.values()],matched:[...h.terms.values()].join(','),match_kind:'metadata'})).sort((a,b)=>b.hits-a.hits||b.weight-a.weight||b.id-a.id).slice(0,limit);
}
