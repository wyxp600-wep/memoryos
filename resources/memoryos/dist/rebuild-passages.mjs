import path from 'node:path';
import fs from 'node:fs';
import {openDb} from './db.js';
import {getEmbedder} from './embed.js';
import {rebuildPassages} from './memory-passages.js';
const index=process.argv.indexOf('--db');if(index<0||!process.argv[index+1])throw new Error('必须显式指定副本 --db');
const file=path.resolve(process.argv[index+1]),production=path.resolve(process.env.APPDATA??'.','MemoryOS','data');
if(!process.argv.includes('--apply'))throw new Error('重建索引需显式指定 --apply');
if(!fs.existsSync(file))throw new Error('数据库副本不存在，拒绝新建');
if(file.startsWith(production+path.sep))throw new Error('本工具拒绝生产目录');
process.env.MEMORY_DB=file;process.env.MEMORYOS_DATA_DIR=path.join(path.dirname(file),'passage-data');
const db=openDb(file);try{const e=await getEmbedder();if(e.mode==='fake')throw new Error('禁止使用伪向量');let total=0;while(true){const r=await rebuildPassages(db,e,{limit:20});total+=r.done;console.log(JSON.stringify({...r,total}));if(!r.pending)break;}}finally{db.close();}
